/**
 * Emergency protocol coordination layer.
 *
 * This file is the ONLY place in the codebase that knows about emergency
 * messages as a concept. Its responsibilities:
 *
 *   1. Derive and hold the emergency channel key (never stored in channels table)
 *   2. Enforce the sender-side rate limit (in memory, not persisted)
 *   3. Build and send emergency / heartbeat bodies via mesh.sendEncodedToKey
 *   4. Receive decoded body bytes from mesh.onEmergencyMessage and route them
 *      to the appropriate db function
 *   5. Expose a clean query surface for the UI (getActiveAlerts, getHeartbeats)
 *
 * What this file does NOT do:
 *   - It does not import React or any UI component
 *   - It does not know about the channels table or the #public broadcast
 *   - It does not know about contacts, groups, or the chat messages table
 *   - It does not run any background timers (sweep is the caller's concern)
 *
 * Security model:
 *   Emergency messages are broadcast to a hardcoded symmetric key held by
 *   every app instance. They are NOT confidential — any device in range can
 *   read them. That is intentional: emergencies must reach strangers. The
 *   trade-off is documented in crypto-core.ts (EMERGENCY_CHANNEL_KEY).
 *
 *   The sender-side rate limit stops accidental spam. The receiver-side
 *   deduplication (window_bucket UNIQUE index in db.ts) stops intentional
 *   spam from any single source. Neither prevents a hostile device from
 *   flooding from many different identities — that is an accepted limitation
 *   of a fully decentralised system with no identity verification.
 */

import { fromUtf8, toUtf8 } from './bytes';
import { EMERGENCY_CHANNEL_ID, EMERGENCY_CHANNEL_KEY } from './crypto-core';
import {
  dismissAlert,
  insertEmergencyAlert,
  insertHeartbeat,
  listActiveAlerts,
  listHeartbeats,
  type EmergencyAlert,
  type Heartbeat,
} from './db';
import { mesh } from './mesh';
import {
  EMERGENCY_TTL_SECONDS,
  EmergencyCategory,
  decodeBody,
  encodeBody,
  pad,
  type EmergencyLocationLabel,
} from './protocol';

export type { EmergencyAlert, Heartbeat };
export { EmergencyCategory };

// ---------------------------------------------------------------------------
// Sender-side rate limiter
// ---------------------------------------------------------------------------

/**
 * Minimum time between emergency sends of the same category, in milliseconds.
 *
 * In-memory only: resets when the app is killed. This is a deliberate choice
 * — a persistent rate limit would survive into a new incident (tomorrow's
 * emergency blocked because you used this category yesterday). The window is
 * long enough to stop accidental tap-spam within a session, which is the
 * primary failure mode.
 *
 * The receiver-side dedup (window_bucket) handles the case where a user
 * kills and restarts the app to bypass this limit.
 */
const COOLDOWN_MS: Readonly<Record<string, number>> = {
  [EmergencyCategory.medical]: 5 * 60 * 1000,
  [EmergencyCategory.unsafe]: 5 * 60 * 1000,
  [EmergencyCategory.lostGroup]: 10 * 60 * 1000,
  [EmergencyCategory.needHelp]: 5 * 60 * 1000,
};

/** Timestamps of the last successful send per category. */
const lastSentAt = new Map<string, number>();

/**
 * Returns true if the user may send an emergency of this category right now.
 *
 * A false return means the cooldown has not elapsed. The UI should show how
 * much time remains rather than silently ignoring the tap.
 */
export function canSendEmergency(category: EmergencyCategory): boolean {
  const last = lastSentAt.get(category);
  if (last === undefined) return true;
  const cooldown = COOLDOWN_MS[category] ?? 5 * 60 * 1000;
  return Date.now() - last >= cooldown;
}

/**
 * Milliseconds remaining in the cooldown for a category.
 * Returns 0 if the user may send immediately.
 */
export function cooldownRemainingMs(category: EmergencyCategory): number {
  const last = lastSentAt.get(category);
  if (last === undefined) return 0;
  const cooldown = COOLDOWN_MS[category] ?? 5 * 60 * 1000;
  const remaining = cooldown - (Date.now() - last);
  return Math.max(0, remaining);
}

// ---------------------------------------------------------------------------
// Emergency channel key registration
// ---------------------------------------------------------------------------

/**
 * Returns the emergency channel entry for registration with the mesh engine.
 *
 * Must be called once during app startup, after the mesh engine is started,
 * to enable trial decryption of emergency messages.
 *
 * The emergency key is NEVER stored in the channels table — this in-memory
 * registration is the only record of it on the device.
 */
export function emergencyChannelEntry(): { id: string; key: Uint8Array } {
  return { id: EMERGENCY_CHANNEL_ID, key: EMERGENCY_CHANNEL_KEY };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Sends an emergency alert to all nearby devices via the emergency channel.
 *
 * Throws if:
 *   - The mesh engine is not started
 *   - The rate limit for this category has not elapsed
 *
 * The `location` field defaults to `{kind:'none'}`. A user who skips the
 * location prompt sends nothing — this is the deliberate privacy default.
 */
export async function sendEmergencyAlert(
  category: EmergencyCategory,
  location: EmergencyLocationLabel = { kind: 'none' },
): Promise<void> {
  if (!canSendEmergency(category)) {
    throw new Error(
      `Rate limit active for category "${category}". ` +
        `Wait ${Math.ceil(cooldownRemainingMs(category) / 1000)}s.`,
    );
  }

  const body = encodeBody({
    kind: 'emergency',
    category,
    urgency: 'high',
    location,
    sentAt: Date.now(),
    id: generateId(),
  });

  // pad() normalises the encoded body to a standard size bucket so the
  // emergency body length cannot be distinguished from a normal text message.
  const bodyBytes = pad(toUtf8(body));
  await mesh.sendEncodedToKey(EMERGENCY_CHANNEL_KEY, bodyBytes);

  // Only update the rate limiter after a successful send.
  lastSentAt.set(category, Date.now());
}

/**
 * Sends a safety heartbeat ("I am okay") to all nearby devices.
 *
 * Not rate-limited as aggressively as emergency alerts, but a 60-second
 * minimum prevents a flood from accidental repeated taps.
 */
const HEARTBEAT_COOLDOWN_MS = 60 * 1000;
let lastHeartbeatAt = 0;

export function canSendHeartbeat(): boolean {
  return Date.now() - lastHeartbeatAt >= HEARTBEAT_COOLDOWN_MS;
}

export async function sendHeartbeat(): Promise<void> {
  if (!canSendHeartbeat()) {
    throw new Error('Heartbeat sent too recently. Wait a moment.');
  }

  const body = encodeBody({
    kind: 'heartbeat',
    state: 'safe',
    sentAt: Date.now(),
    id: generateId(),
  });

  const bodyBytes = pad(toUtf8(body));
  await mesh.sendEncodedToKey(EMERGENCY_CHANNEL_KEY, bodyBytes);
  lastHeartbeatAt = Date.now();
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

/**
 * Handles incoming emergency protocol bytes from mesh.onEmergencyMessage.
 *
 * This is the single receive entry point for all emergency messages. It
 * decodes, validates, and routes to the appropriate db function.
 *
 * Trust note: The sender is authenticated by the crypto seal. A hostile peer
 * CAN send a valid emergency body — the sender-side rate limit and receiver-
 * side merge/dedup are the defences against abuse.
 */
export async function handleIncomingEmergencyBytes(
  senderPublicId: string,
  bodyBytes: Uint8Array,
): Promise<void> {
  const json = fromUtf8(bodyBytes);
  const parsed = decodeBody(json);

  if (!parsed) {
    // Malformed or future-version body. Drop silently — never crash or log.
    return;
  }

  if (parsed.kind === 'emergency') {
    await insertEmergencyAlert({
      id: parsed.id,
      senderId: senderPublicId,
      category: parsed.category,
      urgency: parsed.urgency,
      areaLabel: parsed.location.kind === 'label' ? parsed.location.text : null,
      sentAt: parsed.sentAt,
    });
    return;
  }

  if (parsed.kind === 'heartbeat') {
    await insertHeartbeat({
      id: parsed.id,
      senderId: senderPublicId,
      state: parsed.state,
      sentAt: parsed.sentAt,
    });
    return;
  }

  // kind:'text' or kind:'receipt' under the emergency key — should not occur
  // in normal operation but be defensive rather than crashing.
}

// ---------------------------------------------------------------------------
// UI query surface
// ---------------------------------------------------------------------------

/** Returns undismissed emergency alerts for the alert feed component. */
export async function getActiveAlerts(): Promise<EmergencyAlert[]> {
  return listActiveAlerts();
}

/** Returns the most recent heartbeat per sender for the contacts panel. */
export async function getHeartbeats(): Promise<Heartbeat[]> {
  return listHeartbeats();
}

/** Dismisses an alert — hides it in the UI; row stays for dedup until swept. */
export async function dismissEmergencyAlert(id: string): Promise<void> {
  return dismissAlert(id);
}

export { EMERGENCY_TTL_SECONDS };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
