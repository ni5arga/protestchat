/**
 * The mesh engine.
 *
 * Owns the whole message lifecycle: sealing, dedup, store-and-forward, relaying
 * and expiry. Deliberately the only place any of that logic exists — the Swift
 * and Kotlin sides are dumb byte pipes, so there is exactly one implementation
 * to audit rather than three that drift.
 *
 * Routing is epidemic, not addressed. There are no routing tables and no
 * next-hop decisions, because a routing table is a map of who talks to whom and
 * that is precisely the thing worth not building. Every device carries every
 * unexpired envelope it has seen and offers it to every peer it meets; the
 * recipient is whoever can decrypt it. This costs bandwidth and battery and
 * buys the property that a captured phone reveals nothing about who was
 * talking to whom.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { concat, fromBase64, fromUtf8, toBase64, toUtf8 } from './bytes';
// crypto-core rather than crypto: crypto.ts is only the keystore, and it pulls
// in expo-secure-store. Nothing here needs the keystore — the identity arrives
// through start() — and importing the core directly is what lets this file be
// loaded and tested off-device.
import type { Identity, OpenedMessage, PublicIdentity } from './crypto-core';
import { open, openWithKey, randomId, seal, sealToKey } from './crypto-core';
import type { Envelope, MessageBody } from './protocol';
import {
  DEFAULTS,
  EnvelopeType,
  PROTOCOL_VERSION,
  decodeBody,
  decodeEnvelope,
  encodeBody,
  encodeEnvelope,
  isExpired,
  pad,
  unpad,
} from './protocol';
import type { MeshStore } from './store';
import type { Peer, Transport } from './transport';

export const SERVICE_ID = 'org.protestchat.mesh.v1';

/** Cap on envelopes offered per peer per encounter, so one greedy peer cannot drain us. */
const MAX_SYNC_PER_PEER = 200;

export type MeshStatus = {
  running: boolean;
  radioAvailable: boolean;
  peers: Peer[];
  connected: string[];
  carrying: number;
  lastError: string | null;
};

type Listener = (status: MeshStatus) => void;

export class MeshEngine {
  private transportRef: Transport | null;
  private storeRef: MeshStore | null;
  private identity: Identity | null = null;
  private displayName = 'anon';
  private unsubscribes: (() => void)[] = [];
  private listeners = new Set<Listener>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private peers = new Map<string, Peer>();
  private connected = new Set<string>();
  private carrying = 0;
  private running = false;
  private lastError: string | null = null;

  /**
   * Channel keys we can currently open, including the public broadcast key.
   * Kept in memory only; the durable copy lives in the channels table.
   */
  private channelKeys: { id: string; key: Uint8Array }[] = [];

  /**
   * Fired when a message we can read is opened.
   * `conversationId` is a publicId, "#channelId", or "~groupId".
   */
  onMessage:
    | ((conversationId: string, senderPublicId: string, text: string, sentAt: number) => void)
    | null = null;

  /** Replaces the set of channel keys used for trial decryption. */
  setChannelKeys(keys: { id: string; key: Uint8Array }[]): void {
    this.channelKeys = keys;
  }

  /**
   * Both dependencies are injectable so the engine can be driven by a fake
   * radio and a memory store under `npm test`. Left alone, it resolves the real
   * ones on first use — lazily and by require, because both of those modules
   * reach for native code that does not exist off-device, and the module-level
   * `mesh` singleton below is constructed the moment this file is imported.
   */
  constructor(transport?: Transport, store?: MeshStore) {
    this.transportRef = transport ?? null;
    this.storeRef = store ?? null;
  }

  private get transport(): Transport {
    if (!this.transportRef) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./transport') as typeof import('./transport');
      this.transportRef = mod.getTransport();
    }
    return this.transportRef;
  }

  private get store(): MeshStore {
    if (!this.storeRef) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./db') as typeof import('./db');
      this.storeRef = mod.meshStore;
    }
    return this.storeRef;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(identity: Identity, displayName: string): Promise<void> {
    if (this.running) return;
    this.identity = identity;
    this.displayName = displayName;
    this.running = true;
    this.lastError = null;

    this.unsubscribes = [
      this.transport.on('peerFound', (p) => {
        this.peers.set(p.id, p);
        this.emit();
      }),
      this.transport.on('peerLost', (id) => {
        this.peers.delete(id);
        this.connected.delete(id);
        this.emit();
      }),
      this.transport.on('connected', (p) => {
        this.peers.set(p.id, p);
        this.connected.add(p.id);
        this.emit();
        void this.offerInventory(p.id);
      }),
      this.transport.on('disconnected', (id) => {
        this.connected.delete(id);
        this.emit();
      }),
      this.transport.on('payload', (peerId, b64) => void this.ingest(peerId, b64)),
      this.transport.on('error', (message) => {
        // An empty message is the transport's "clear the error" signal, e.g. the
        // radio reaching 'ready' after a transient startup state.
        this.lastError = message || null;
        this.emit();
      }),
    ];

    await this.store.sweepExpired();
    await this.refreshCarrying();
    await this.transport.start(SERVICE_ID, displayName);

    // Expiry is a security control here, not housekeeping — an envelope past
    // its TTL is evidence sitting on a phone that might get taken.
    this.sweepTimer = setInterval(() => {
      void this.store.sweepExpired().then(() => this.refreshCarrying());
    }, 60_000);

    this.emit();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const u of this.unsubscribes) u();
    this.unsubscribes = [];
    this.peers.clear();
    this.connected.clear();
    // Drop the in-memory secrets. panic wipe calls stop() before erasing disk;
    // clearing these here means a wiped app is not still holding the identity
    // and channel keys in a live field. JS cannot zero the backing memory, so
    // this drops the references for GC rather than promising secure erasure —
    // the seized-unlocked-phone case remains out of scope (see threat model).
    this.identity = null;
    this.channelKeys = [];
    await this.transport.stop();
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.status());
    return () => this.listeners.delete(listener);
  }

  status(): MeshStatus {
    return {
      running: this.running,
      radioAvailable: this.transport.available,
      peers: [...this.peers.values()],
      connected: [...this.connected],
      carrying: this.carrying,
      lastError: this.lastError,
    };
  }

  private emit(): void {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  private async refreshCarrying(): Promise<void> {
    this.carrying = (await this.store.envelopeIds()).length;
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Seals `text` to `recipient` and injects it into the mesh.
   *
   * Returns as soon as the envelope is durably stored, NOT when it is
   * delivered — with store-and-forward, delivery may be minutes away and may
   * happen via someone else's phone entirely. The UI reflects this: a message
   * is "queued" until there is somebody to hand it to, "sent" once there was,
   * and only "delivered" when the recipient's own acknowledgement finds its way
   * back to us — which may itself take a relay and an hour.
   */
  async sendText(recipient: PublicIdentity, text: string): Promise<string> {
    if (!this.identity) throw new Error('mesh not started');

    const messageId = randomId();
    const sealed = seal(this.identity, recipient, this.packBody(text, messageId));

    await this.recordOutgoing(messageId, recipient.publicId, text, [recipient.publicId]);
    // 'sent' is written BEFORE injecting, and that ordering is load-bearing: the
    // recipient may be in range and its receipt can be back in our hands inside
    // the same tick, and writing 'sent' afterwards would overwrite 'delivered'
    // with a weaker state. The condition is unchanged — "was there anybody to
    // hand this to" is known before we hand it over.
    if (this.connected.size > 0) await this.store.setMessageState(messageId, 'sent');
    await this.inject(sealed);

    return messageId;
  }

  /**
   * Sends to a channel or to public broadcast.
   *
   * Identical machinery to a direct message; only the sealing differs. Because
   * recipients find their mail by trial decryption, the mesh needs no notion of
   * channels at all — a channel message is just an envelope that happens to
   * open under a key more than one person holds.
   */
  async sendToChannel(channelId: string, key: Uint8Array, text: string): Promise<string> {
    if (!this.identity) throw new Error('mesh not started');

    const messageId = randomId();
    // No message id in the body: a channel message must never be acked, and the
    // cleanest way to guarantee that is to give holders of the key nothing to
    // ack. See packBody.
    const sealed = sealToKey(this.identity, key, this.packBody(text));

    await this.recordOutgoing(messageId, `#${channelId}`, text, []);
    if (this.connected.size > 0) await this.store.setMessageState(messageId, 'sent');
    await this.inject(sealed);

    return messageId;
  }

  /**
   * Sends to a closed group by fan-out: one independently sealed copy per
   * member. There is no group key and no shared secret, so the group has no
   * rekeying problem and removing someone is simply not sending to them.
   *
   * The cost is N× bandwidth, which is why the UI caps group size.
   */
  async sendToGroup(groupId: string, members: PublicIdentity[], text: string): Promise<string> {
    if (!this.identity) throw new Error('mesh not started');

    const messageId = randomId();
    // One id shared by every copy. A distinct id per member would let a member
    // ack only its own copy, but it buys nothing: two colluding members can
    // already recognise that they hold the same message from its identical
    // plaintext and sentAt, so the shared id leaks nothing they did not have.
    const body = this.packBody(text, messageId);
    await this.recordOutgoing(
      messageId,
      `~${groupId}`,
      text,
      members.map((m) => m.publicId),
    );
    if (this.connected.size > 0) await this.store.setMessageState(messageId, 'sent');

    // Injecting N envelopes at the same instant is itself a signal: an observer
    // counting envelopes leaving one device learns "that phone is in a group of
    // N" without decrypting anything. Spreading the injection over a few
    // seconds costs nothing and removes the pattern.
    await Promise.all(
      members.map(async (member) => {
        const sealed = seal(this.identity!, member, body);
        await this.inject(sealed, jitterMs());
      }),
    );

    return messageId;
  }

  // ---- shared plumbing ----------------------------------------------------

  /**
   * Builds a padded, sealed-payload-ready body.
   *
   * `messageId` is passed only for the modes where a delivery receipt is
   * wanted, and its presence IS the request for one. Receipts are therefore
   * opt-in by construction rather than by a runtime flag a bug could flip:
   *
   *   - Direct message: included. One sender, one recipient, one ack. The
   *     receipt is sealed back to that one person and tells nobody else
   *     anything.
   *   - Group: included. A group is N independent direct messages, so this is
   *     just the direct case N times over.
   *   - Channel: OMITTED. Everyone holding the channel key would ack every
   *     message, which hands every key-holder a per-message read log of every
   *     other member — a participation and attention map that the channel
   *     construct deliberately does not otherwise have, and precisely the sort
   *     of record that is dangerous on a seized phone.
   *   - Public broadcast: OMITTED, and this one is not a close call. The public
   *     key is held by every device running the app, so every listener in range
   *     would reply to every broadcast: N acks per message, each of which is
   *     itself an envelope the whole mesh floods and relays. That is a
   *     broadcast storm on a link budget that cannot absorb it. It also
   *     de-anonymises the audience of a megaphone: broadcast is the one mode
   *     where the listener is currently invisible to the speaker, and receipts
   *     would turn every listener into a signed, identified reply.
   */
  private packBody(text: string, messageId?: string): Uint8Array {
    const body: MessageBody = messageId
      ? { kind: 'text', text, sentAt: Date.now(), id: messageId }
      : { kind: 'text', text, sentAt: Date.now() };
    return pad(toUtf8(encodeBody(body)));
  }

  /**
   * `expectedFrom` is who this message needs a receipt from before it counts as
   * delivered — empty for the modes that never ack.
   *
   * For a group that means EVERY member, not the first one to reply. A group
   * message is one row in the UI and one thing in the user's head, so its state
   * has to be the weakest guarantee that holds across the whole fan-out;
   * showing "delivered" when four of five copies are still sitting in someone's
   * carry cache would be a lie in the direction that gets people hurt — the
   * point of the indicator is to let someone decide whether to assume the group
   * knows. Partial progress stays 'sent', which honestly means "handed to the
   * mesh, not yet confirmed everywhere".
   */
  private async recordOutgoing(
    id: string,
    conversationId: string,
    text: string,
    expectedFrom: string[],
  ): Promise<void> {
    await this.store.insertMessage({
      id,
      peerId: conversationId,
      senderId: this.identity?.publicId ?? null,
      outgoing: true,
      text,
      sentAt: Date.now(),
      state: 'queued',
    });
    await this.store.addExpectedRecipients(id, expectedFrom);
  }

  /**
   * Wraps a sealed payload in an envelope, stores it, and pushes it to anyone
   * in range. If nobody is in range it simply waits in the cache and goes out
   * at the next encounter — that is the store-and-forward path, not an error.
   */
  private async inject(sealed: Uint8Array, delayMs = 0): Promise<void> {
    const envelope: Envelope = {
      version: PROTOCOL_VERSION,
      type: EnvelopeType.Sealed,
      id: fromBase64(randomId()),
      createdAt: Date.now(),
      ttlSeconds: DEFAULTS.ttlSeconds,
      hopCount: 0,
      maxHops: DEFAULTS.maxHops,
      payload: sealed,
    };

    // Stored before any delay, so a message survives the app being killed
    // between injection and transmission.
    await this.store.storeEnvelope(envelope, true);
    await this.store.markSeen(toBase64(envelope.id));
    await this.refreshCarrying();

    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await this.broadcast(encodeEnvelope(envelope));
  }

  private async broadcast(raw: Uint8Array, exceptPeerId?: string): Promise<void> {
    const b64 = toBase64(raw);
    await Promise.all(
      [...this.connected]
        .filter((id) => id !== exceptPeerId)
        .map((id) =>
          this.transport.send(id, b64).catch((err) => {
            // A peer walking out of range mid-send is normal, not an error
            // worth surfacing to a user standing in a crowd.
            console.warn(`[mesh] send to ${id} failed:`, err);
          }),
        ),
    );
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  private async ingest(fromPeerId: string, payloadBase64: string): Promise<void> {
    const envelope = decodeEnvelope(fromBase64(payloadBase64));
    // Malformed input from a stranger's radio is expected. Drop it silently;
    // do not let a parse failure become a crash or a log that fingerprints us.
    if (!envelope) return;
    if (isExpired(envelope)) return;

    switch (envelope.type) {
      case EnvelopeType.Inventory:
        return this.handleInventory(fromPeerId, envelope);
      case EnvelopeType.Request:
        return this.handleRequest(fromPeerId, envelope);
      case EnvelopeType.Sealed:
        return this.handleSealed(fromPeerId, envelope);
    }
  }

  private async handleSealed(fromPeerId: string, envelope: Envelope): Promise<void> {
    const idB64 = toBase64(envelope.id);

    // Dedup before anything expensive. In a dense crowd the same envelope
    // arrives from many directions and trial decryption is not free.
    if (!(await this.store.markSeen(idB64))) return;

    // Try to open it under every key we hold: our own identity first, then each
    // channel. Failure is the overwhelmingly common case and means only "not
    // for me" — we relay it either way, and we cannot tell the difference
    // between someone else's mail and a forgery, which is exactly the point.
    //
    // The direct and channel wire layouts differ in length (direct carries an
    // ephemeral public key, channel does not), so trial decryption alone tells
    // them apart. No discriminator byte on the wire means relays cannot even
    // learn which mode a message is in.
    const hit = this.tryOpen(envelope.payload);
    if (hit) {
      const unpadded = unpad(hit.opened.body);
      const parsed = unpadded ? decodeBody(fromUtf8(unpadded)) : null;

      if (parsed?.kind === 'text') {
        const sender = hit.opened.sender.publicId;

        // Content-level dedup. The envelope-id dedup above is defeated by a
        // replay attacker who re-wraps a captured ciphertext in a fresh envelope
        // id; hashing the DECRYPTED body catches that. A genuine resend carries
        // a fresh random `id` (and a distinct sentAt), so only an exact replay
        // collides. If we have already delivered this message, we still relay
        // the envelope below (others may not have it) but do not file a
        // duplicate or re-ack — a stale directive resurfacing hours later is
        // exactly the confusion this prevents.
        const contentHash = toBase64(
          sha256(concat(toUtf8(`${sender}|${hit.conversationId ?? ''}|`), hit.opened.body)),
        );

        if (await this.store.markMessageSeen(contentHash)) {
          // Never overwrite a name the user set; only ensure the sender exists so
          // channel messages from strangers are attributable to something stable.
          await this.store.upsertContact(sender, shortName(sender));
          await this.store.insertMessage({
            id: randomId(),
            peerId: hit.conversationId ?? sender,
            senderId: sender,
            outgoing: false,
            text: parsed.text,
            sentAt: parsed.sentAt,
            state: 'delivered',
          });
          this.onMessage?.(hit.conversationId ?? sender, sender, parsed.text, parsed.sentAt);

          // Ack only what asked to be acked, and only in the one-to-one mode.
          // `conversationId === null` means this opened under our own identity —
          // a direct message, or one copy of a group fan-out, which is the same
          // thing on the wire. A channel hit is never acked even if the sender
          // put an id in the body, so a hostile or buggy peer cannot talk us
          // into announcing our presence in a channel.
          if (hit.conversationId === null && parsed.id) {
            await this.sendReceipt(hit.opened.sender, parsed.id);
          }
        }
      } else if (parsed?.kind === 'receipt' && hit.conversationId === null) {
        // A receipt is not itself acked. `packBody` is the only thing that ever
        // sets a message id, and it is only ever called for text, so a receipt
        // carries nothing to reply to and this branch never sends — which is
        // what stops two phones acking each other's acks forever.
        //
        // Direct hits only. We never seal an ack to a channel key, so a receipt
        // arriving through a channel is a member trying to acknowledge on a
        // path we did not offer; the ledger would refuse it anyway, and there
        // is no reason to run it.
        await this.applyReceipt(hit.opened.sender.publicId, parsed.messageId);
      }

      // Still stored and relayed even though it was ours. Dropping it here
      // would tell a traffic observer which device is the recipient.
    }

    await this.store.storeEnvelope(envelope);
    await this.refreshCarrying();

    if (envelope.hopCount + 1 >= envelope.maxHops) return;
    const forwarded: Envelope = { ...envelope, hopCount: envelope.hopCount + 1 };
    await this.broadcast(encodeEnvelope(forwarded), fromPeerId);
  }

  /**
   * Seals an acknowledgement back to the sender and injects it like any other
   * message.
   *
   * Everything about this is deliberately ordinary. It is sealed to one
   * recipient with `seal`, padded to the same buckets as text, and pushed into
   * the same store-and-forward cache, so:
   *
   *   - relays cannot tell a receipt from a message. Same envelope type, same
   *     opaque payload, same size bucket (a receipt body is well under 256
   *     bytes, and so is a short message). If receipts were smaller, or shaped
   *     differently on the wire, an observer could watch an envelope go out and
   *     a distinctive little envelope come back and infer both endpoints of a
   *     conversation from traffic analysis alone — which would give away by the
   *     side door exactly what the sealed construction protects.
   *   - it works when we have never met the sender. The receipt goes into the
   *     carry cache and rides the mesh the same way their message reached us,
   *     which is the case that matters: the message that took an hour to arrive
   *     through three strangers is the one whose sender most needs to know it
   *     landed.
   */
  private async sendReceipt(to: PublicIdentity, messageId: string): Promise<void> {
    if (!this.identity) return;
    const body = pad(toUtf8(encodeBody({ kind: 'receipt', messageId, receivedAt: Date.now() })));
    await this.inject(seal(this.identity, to, body));
  }

  /**
   * Applies an incoming acknowledgement.
   *
   * The store does the checking, keyed on (message, sender): a receipt for
   * something we never sent, or from someone we never sent it to, matches no
   * row and is dropped. That is not just tidiness — without it, anyone able to
   * guess or replay a message id could mark other people's messages delivered,
   * and "delivered" is a claim a user acts on.
   */
  private async applyReceipt(fromPublicId: string, messageId: string): Promise<void> {
    if (await this.store.recordReceipt(messageId, fromPublicId)) {
      await this.store.setMessageState(messageId, 'delivered');
    }
  }

  /**
   * Trial decryption across every key we hold.
   *
   * `conversationId` is null for a direct message (the conversation is then the
   * sender) and "#channelId" for a channel hit.
   *
   * Group messages are indistinguishable from direct ones here by design — a
   * fan-out copy IS a direct message. The group a message belongs to is a
   * purely local notion, which is why groups need no protocol support at all.
   */
  private tryOpen(
    payload: Uint8Array,
  ): { opened: OpenedMessage; conversationId: string | null } | null {
    if (this.identity) {
      const direct = open(this.identity, payload);
      if (direct) return { opened: direct, conversationId: null };
    }

    for (const { id, key } of this.channelKeys) {
      const hit = openWithKey(key, payload);
      if (hit) return { opened: hit, conversationId: `#${id}` };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Sync: two peers meet and reconcile what they carry
  // -------------------------------------------------------------------------

  private async offerInventory(peerId: string): Promise<void> {
    const ids = (await this.store.envelopeIds()).slice(0, MAX_SYNC_PER_PEER);
    await this.sendControl(peerId, EnvelopeType.Inventory, ids);
  }

  private async handleInventory(peerId: string, envelope: Envelope): Promise<void> {
    const theirIds = parseIdList(envelope.payload);
    if (!theirIds) return;

    const mine = new Set(await this.store.envelopeIds());
    const wanted: string[] = [];
    for (const id of theirIds.slice(0, MAX_SYNC_PER_PEER)) {
      if (!mine.has(id) && !(await this.store.hasSeen(id))) wanted.push(id);
    }
    if (wanted.length === 0) return;

    await this.sendControl(peerId, EnvelopeType.Request, wanted);
  }

  private async handleRequest(peerId: string, envelope: Envelope): Promise<void> {
    const wanted = parseIdList(envelope.payload);
    if (!wanted) return;

    const envelopes = await this.store.getEnvelopesByIds(wanted.slice(0, MAX_SYNC_PER_PEER));
    for (const e of envelopes) {
      if (e.hopCount >= e.maxHops) continue;
      await this.transport
        .send(peerId, toBase64(encodeEnvelope({ ...e, hopCount: e.hopCount + 1 })))
        .catch(() => {});
    }
  }

  private async sendControl(
    peerId: string,
    type: EnvelopeType,
    ids: string[],
  ): Promise<void> {
    const envelope: Envelope = {
      version: PROTOCOL_VERSION,
      type,
      id: fromBase64(randomId()),
      createdAt: Date.now(),
      /**
       * Control traffic is point-to-point and worthless once the encounter is
       * over, so this wants to be short. It cannot be 60s, though.
       *
       * encodeEnvelope floors createdAt to the 60s TIME_GRANULARITY_MS boundary
       * to stop precise clocks being a fingerprint. With ttlSeconds = 60 the
       * receiver's isExpired check therefore killed control envelopes anywhere
       * from 0 to 60 seconds after they were sent, uniformly at random. On a
       * BLE-only link, or with any clock skew between two phones, inventory
       * sync silently failed a large fraction of the time — silently, because
       * handleInventory simply never ran and the two devices just did not
       * reconcile.
       *
       * Five minutes swamps both the granularity floor and realistic skew.
       */
      ttlSeconds: 300,
      hopCount: 0,
      maxHops: 1,
      payload: toUtf8(JSON.stringify(ids)),
    };
    await this.transport.send(peerId, toBase64(encodeEnvelope(envelope))).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

function parseIdList(payload: Uint8Array): string[] | null {
  try {
    const parsed = JSON.parse(fromUtf8(payload));
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return null;
  }
}

/** A stable placeholder label until the user renames the contact themselves. */
export const shortName = (publicId: string): string => `anon-${publicId.slice(0, 6)}`;

/** 0–3s of unpredictable delay, used to break up group fan-out patterns. */
function jitterMs(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 3000) + 1;
}

export const mesh = new MeshEngine();
