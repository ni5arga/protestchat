/**
 * The storage contract the mesh engine depends on, plus an in-memory
 * implementation of it.
 *
 * Split out of db.ts for one reason: db.ts imports expo-sqlite, which only
 * exists on a device, so anything that imports it transitively cannot be run or
 * tested off-device. The mesh engine is the single most security-critical piece
 * of logic in the app — dedup, hop limits, expiry, "a relay must not be able to
 * read what it relays" — and none of that should be verifiable only by standing
 * in a room with several phones.
 *
 * This file therefore holds no persistence code. It holds the interface, the
 * retention policy that both implementations must obey, and a memory-backed
 * store whose semantics deliberately match the SQL in db.ts statement for
 * statement. If the two ever drift, the tests are testing a fiction.
 */

import { fromBase64, toBase64 } from './bytes';
import type { Envelope } from './protocol';
import { decodeEnvelope, encodeEnvelope } from './protocol';

export type MessageState = 'queued' | 'sent' | 'delivered' | 'failed';

export type Message = {
  id: string;
  /** Conversation key: publicId, "#channelId", or "~groupId". */
  peerId: string;
  /** Who wrote it. Differs from peerId in channels and groups. */
  senderId: string | null;
  outgoing: boolean;
  text: string;
  sentAt: number;
  state: MessageState;
};

/**
 * Hard local cap on how long this device will carry anything, regardless of
 * what the envelope claims.
 *
 * The outer header is unauthenticated — it has to be, since relays legitimately
 * mutate hopCount and cannot verify a signature that lives inside the
 * ciphertext. So a hostile relay can rewrite ttlSeconds upward and make every
 * phone in the mesh hoard a message far past what its sender intended, which
 * quietly destroys the "short TTL limits what a seized phone reveals" property.
 *
 * The fix needs no cryptography: each device enforces its own retention from
 * FIRST SIGHT. An attacker cannot forge our local clock.
 */
export const MAX_LOCAL_RETENTION_MS = 6 * 3600 * 1000;

/** Dedup entries outlive the envelope itself, so nothing loops back to us. */
export const SEEN_RETENTION_MS = 7 * 24 * 3600 * 1000;

/**
 * Exactly the storage surface MeshEngine touches — nothing more, so that a test
 * double cannot accidentally be handed responsibilities the engine does not
 * actually have.
 */
export interface MeshStore {
  sweepExpired(): Promise<void>;
  envelopeIds(): Promise<string[]>;
  storeEnvelope(e: Envelope, isOurs?: boolean): Promise<void>;
  getEnvelopesByIds(ids: string[]): Promise<Envelope[]>;
  /** Returns true only the first time an id is presented. The dedup primitive. */
  markSeen(idB64: string): Promise<boolean>;
  hasSeen(idB64: string): Promise<boolean>;
  /**
   * Content-level dedup, keyed on a hash of the decrypted message rather than
   * the outer envelope id. Returns true only the first time. Stops a captured
   * ciphertext re-wrapped in a fresh envelope id from being delivered twice.
   */
  markMessageSeen(hashB64: string): Promise<boolean>;
  insertMessage(m: Message): Promise<void>;
  setMessageState(id: string, state: MessageState): Promise<void>;
  upsertContact(publicId: string, name: string): Promise<void>;

  /**
   * Records who an outgoing message is expected to be acknowledged by.
   *
   * This is the ledger delivery receipts are checked against, and it is what
   * makes "a receipt for a message we never sent" a non-event: an unrecognised
   * (messageId, publicId) pair simply has no row to update. Note it keys on the
   * pair, not the id alone, so a member of a group cannot ack on another
   * member's behalf and cannot fake delivery to someone else.
   *
   * Empty for channel and public messages, which never expect a receipt.
   */
  addExpectedRecipients(messageId: string, publicIds: string[]): Promise<void>;

  /**
   * Marks one expected recipient as having acknowledged, and answers the only
   * question the engine has: is this message now delivered to EVERYONE it was
   * addressed to?
   *
   * Returns false if there was nothing to mark — an unknown message, an unknown
   * recipient, or a duplicate receipt — so a caller can treat true as "and this
   * is the transition to delivered", exactly once.
   */
  recordReceipt(messageId: string, fromPublicId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

type StoredEnvelope = {
  id: string;
  /** Kept encoded, exactly as db.ts does, so a re-encode bug cannot hide here. */
  raw: string;
  createdAt: number;
  expiresAt: number;
  hopCount: number;
  isOurs: boolean;
};

/**
 * A MeshStore that keeps everything in maps, plus read-only views for
 * assertions. The extra accessors are inspection only — the engine sees the
 * MeshStore surface and nothing else.
 */
export interface MemoryStore extends MeshStore {
  readonly messages: Message[];
  readonly contacts: { publicId: string; name: string }[];
  readonly envelopes: StoredEnvelope[];
  readonly seen: string[];
}

export function createMemoryStore(now: () => number = Date.now): MemoryStore {
  const envelopes = new Map<string, StoredEnvelope>();
  const messages = new Map<string, Message>();
  const contacts = new Map<string, { publicId: string; name: string }>();
  const seen = new Map<string, number>();
  const seenMessages = new Map<string, number>();
  /**
   * messageId -> (publicId -> acked). Nested rather than one map under a joined
   * "id|id" key, because that needs a separator, and a separator is a thing two
   * call sites can disagree about while both looking right. Stands in for the
   * (message_id, public_id) primary key in db.ts.
   */
  const expected = new Map<string, Map<string, boolean>>();

  return {
    async sweepExpired() {
      const t = now();
      for (const [id, e] of envelopes) if (e.expiresAt <= t) envelopes.delete(id);
      for (const [id, at] of seen) if (at <= t - SEEN_RETENTION_MS) seen.delete(id);
      for (const [h, at] of seenMessages) if (at <= t - SEEN_RETENTION_MS) seenMessages.delete(h);
    },

    async envelopeIds() {
      const t = now();
      return [...envelopes.values()].filter((e) => e.expiresAt > t).map((e) => e.id);
    },

    async storeEnvelope(e, isOurs = false) {
      const t = now();
      const claimed = e.createdAt + e.ttlSeconds * 1000;
      const id = toBase64(e.id);
      envelopes.set(id, {
        id,
        raw: toBase64(encodeEnvelope(e)),
        createdAt: e.createdAt,
        // Same first-sight cap as db.ts: a peer that inflates ttlSeconds must
        // not be able to make us hoard its traffic.
        expiresAt: Math.min(claimed, t + MAX_LOCAL_RETENTION_MS),
        hopCount: e.hopCount,
        isOurs,
      });
    },

    async getEnvelopesByIds(ids) {
      const t = now();
      const out: Envelope[] = [];
      for (const id of ids) {
        const row = envelopes.get(id);
        if (!row || row.expiresAt <= t) continue;
        const decoded = decodeEnvelope(fromBase64(row.raw));
        if (decoded) out.push(decoded);
      }
      return out;
    },

    async markSeen(idB64) {
      if (seen.has(idB64)) return false;
      seen.set(idB64, now());
      return true;
    },

    async hasSeen(idB64) {
      return seen.has(idB64);
    },

    async markMessageSeen(hashB64) {
      if (seenMessages.has(hashB64)) return false;
      seenMessages.set(hashB64, now());
      return true;
    },

    async insertMessage(m) {
      // INSERT OR IGNORE: re-delivery of the same message id must not clobber
      // the state the UI already settled on.
      if (!messages.has(m.id)) messages.set(m.id, { ...m });
    },

    async setMessageState(id, state) {
      const m = messages.get(id);
      if (m) m.state = state;
    },

    async addExpectedRecipients(messageId, publicIds) {
      // INSERT OR IGNORE, as in db.ts: re-arming an existing row would erase an
      // ack that has already come back.
      let row = expected.get(messageId);
      if (!row) expected.set(messageId, (row = new Map()));
      for (const publicId of publicIds) {
        if (!row.has(publicId)) row.set(publicId, false);
      }
    },

    async recordReceipt(messageId, fromPublicId) {
      const row = expected.get(messageId);
      // Unknown message, unknown recipient, or a duplicate receipt: nothing
      // changes, so this is not the moment of delivery. Matches the
      // `AND acked = 0` guard in db.ts.
      if (row?.get(fromPublicId) !== false) return false;
      row.set(fromPublicId, true);

      // Delivered means delivered to everyone it was addressed to; see the note
      // on MeshEngine.recordOutgoing for why a group is all-or-nothing.
      for (const acked of row.values()) if (!acked) return false;
      return true;
    },

    async upsertContact(publicId, name) {
      // Mirrors db.ts: first write wins on the name, so a label the user chose
      // survives the engine calling this on every message from that person.
      if (!contacts.has(publicId)) contacts.set(publicId, { publicId, name });
    },

    get messages() {
      return [...messages.values()];
    },
    get contacts() {
      return [...contacts.values()];
    },
    get envelopes() {
      return [...envelopes.values()];
    },
    get seen() {
      return [...seen.keys()];
    },
  };
}
