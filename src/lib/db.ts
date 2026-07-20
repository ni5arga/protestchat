/**
 * Local storage.
 *
 * Everything lives on the device and nowhere else — there is no server to
 * subpoena. The flipside is that a seized, unlocked phone is the whole attack,
 * which is why every table has an expiry sweep and `wipeEverything()` exists.
 */

import * as SQLite from 'expo-sqlite';

import { fromBase64, toBase64 } from './bytes';
import type { Envelope } from './protocol';
import { decodeEnvelope, encodeEnvelope } from './protocol';
import type { MeshStore, Message, MessageState } from './store';
import { MAX_LOCAL_RETENTION_MS, SEEN_RETENTION_MS } from './store';

export type Contact = {
  publicId: string;
  name: string;
  /** True only after the safety number has been compared in person. */
  verified: boolean;
  firstSeen: number;
  lastSeen: number;
};

// The message shape and the retention policy live in store.ts, because the mesh
// engine must be able to reach them without dragging expo-sqlite in with them.
// Re-exported here so every existing `db.Message` call site keeps working.
export type { Message, MessageState };
export { MAX_LOCAL_RETENTION_MS };

/**
 * Memoises the PROMISE, not the handle.
 *
 * Memoising the handle looks equivalent and is not. It leaves two windows in
 * which concurrent callers misbehave, and app boot fires roughly eight DB calls
 * at once (refresh alone runs four in parallel, plus the mesh engine starting
 * and the public channel being ensured):
 *
 *   1. Between entering and the assignment, every concurrent caller sees null
 *      and starts its OWN openDatabaseAsync on the same file.
 *   2. The handle would be assigned before the schema exec finished, so a
 *      caller could get a database with no tables in it.
 *
 * On device that surfaced as `NullPointerException` out of prepareAsync and
 * execAsync — an error message that points nowhere near the actual cause.
 */
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  return (dbPromise ??= openAndMigrate());
}

async function openAndMigrate(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync('protestchat.db');

  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS contacts (
      public_id  TEXT PRIMARY KEY NOT NULL,
      name       TEXT NOT NULL,
      verified   INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );

    -- peer_id is the conversation key and encodes the mode:
    --   "<base64 publicId>"  a direct conversation
    --   "#<channelId>"       a channel or public broadcast
    --   "~<groupId>"         a closed group
    -- sender_id is who actually wrote it, which only differs from peer_id in
    -- channels and groups where many people speak into one conversation.
    CREATE TABLE IF NOT EXISTS messages (
      id        TEXT PRIMARY KEY NOT NULL,
      peer_id   TEXT NOT NULL,
      sender_id TEXT,
      outgoing  INTEGER NOT NULL,
      text      TEXT NOT NULL,
      sent_at   INTEGER NOT NULL,
      state     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_by_peer ON messages (peer_id, sent_at);

    -- Who each outgoing message is still waiting on a delivery receipt from.
    -- One row per (message, recipient): one for a direct message, N for a group
    -- fan-out, none at all for a channel or broadcast, which never ack.
    -- Deliberately not a foreign key onto messages: it is swept with the
    -- messages it belongs to, and an orphan row here is inert.
    CREATE TABLE IF NOT EXISTS message_recipients (
      message_id TEXT NOT NULL,
      public_id  TEXT NOT NULL,
      acked      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (message_id, public_id)
    );

    -- Store-and-forward cache. Envelopes we carry on behalf of other people,
    -- plus our own outbound mail that has not found a next hop yet.
    CREATE TABLE IF NOT EXISTS envelopes (
      id         TEXT PRIMARY KEY NOT NULL,
      raw        TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      hop_count  INTEGER NOT NULL,
      is_ours    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS envelopes_by_expiry ON envelopes (expires_at);

    -- Channels and public broadcast. A channel is a cached symmetric key and a
    -- name; there is deliberately no owner column, because there is no owner.
    CREATE TABLE IF NOT EXISTS channels (
      id         TEXT PRIMARY KEY NOT NULL,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      key        TEXT NOT NULL,
      joined_at  INTEGER NOT NULL
    );

    -- Closed groups. Membership is local-only: this is *my* list of who I send
    -- to, not a synchronised roster. Two members can disagree about who is in
    -- the group, and that is an accepted limitation of fan-out.
    CREATE TABLE IF NOT EXISTS groups (
      id         TEXT PRIMARY KEY NOT NULL,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id  TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      public_id TEXT NOT NULL,
      PRIMARY KEY (group_id, public_id)
    );

    -- Dedup ledger. Kept after the envelope itself is dropped, otherwise an
    -- envelope that is still in flight elsewhere loops straight back to us.
    CREATE TABLE IF NOT EXISTS seen (
      id      TEXT PRIMARY KEY NOT NULL,
      seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS seen_by_time ON seen (seen_at);

    -- Content-level dedup, keyed on a hash of the DECRYPTED message. The seen
    -- table above dedups on the outer envelope id, which a replay attacker
    -- simply regenerates; this one catches the same plaintext arriving under a
    -- fresh envelope id. Swept on the same schedule as seen.
    CREATE TABLE IF NOT EXISTS seen_messages (
      hash    TEXT PRIMARY KEY NOT NULL,
      seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS seen_messages_by_time ON seen_messages (seen_at);

    -- Unread tracking. Stores, per conversation, how many INCOMING messages
    -- have been seen. Unread = incoming total minus this. Counting rather than
    -- timestamping deliberately: sent_at is minute-rounded and comes off the
    -- sender's clock, so a > comparison would miscount ties and clock skew; a
    -- count cannot. A missing row means nothing has been read yet.
    CREATE TABLE IF NOT EXISTS conversation_reads (
      peer_id    TEXT PRIMARY KEY NOT NULL,
      read_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export async function upsertContact(publicId: string, name: string): Promise<void> {
  const d = await getDb();
  const now = Date.now();
  await d.runAsync(
    // Does NOT overwrite an existing name. The mesh engine calls this on every
    // received message with a generated `anon-xxxxxx` label just to ensure the
    // sender exists, so updating the name here reverted any name the user had
    // set the moment that person spoke. Renaming goes through setContactName.
    `INSERT INTO contacts (public_id, name, verified, first_seen, last_seen)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(public_id) DO UPDATE SET last_seen = excluded.last_seen`,
    [publicId, name, now, now],
  );
}

/** Explicit rename, for the paths where the user chose the name. */
export async function setContactName(publicId: string, name: string): Promise<void> {
  const d = await getDb();
  await d.runAsync(`UPDATE contacts SET name = ? WHERE public_id = ?`, [name, publicId]);
}

export async function setContactVerified(publicId: string, verified: boolean): Promise<void> {
  const d = await getDb();
  await d.runAsync(`UPDATE contacts SET verified = ? WHERE public_id = ?`, [
    verified ? 1 : 0,
    publicId,
  ]);
}

export async function listContacts(): Promise<Contact[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<any>(`SELECT * FROM contacts ORDER BY last_seen DESC`);
  return rows.map((r) => ({
    publicId: r.public_id,
    name: r.name,
    verified: !!r.verified,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  }));
}

export async function getContact(publicId: string): Promise<Contact | null> {
  const d = await getDb();
  const r = await d.getFirstAsync<any>(`SELECT * FROM contacts WHERE public_id = ?`, [publicId]);
  if (!r) return null;
  return {
    publicId: r.public_id,
    name: r.name,
    verified: !!r.verified,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function insertMessage(m: Message): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    `INSERT OR IGNORE INTO messages (id, peer_id, sender_id, outgoing, text, sent_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [m.id, m.peerId, m.senderId, m.outgoing ? 1 : 0, m.text, m.sentAt, m.state],
  );
}

export async function setMessageState(id: string, state: MessageState): Promise<void> {
  const d = await getDb();
  await d.runAsync(`UPDATE messages SET state = ? WHERE id = ?`, [state, id]);
}

/** See MeshStore.addExpectedRecipients for why this ledger exists. */
export async function addExpectedRecipients(
  messageId: string,
  publicIds: string[],
): Promise<void> {
  if (publicIds.length === 0) return;
  const d = await getDb();
  for (const publicId of publicIds) {
    // OR IGNORE, not OR REPLACE: re-arming a row would erase an ack.
    await d.runAsync(
      `INSERT OR IGNORE INTO message_recipients (message_id, public_id, acked) VALUES (?, ?, 0)`,
      [messageId, publicId],
    );
  }
}

/** See MeshStore.recordReceipt. True only on the transition to fully delivered. */
export async function recordReceipt(messageId: string, fromPublicId: string): Promise<boolean> {
  const d = await getDb();
  // `acked = 0` makes this idempotent: a receipt that reaches us twice (the
  // mesh floods, and dedup only covers envelopes we have already seen) changes
  // nothing the second time.
  const updated = await d.runAsync(
    `UPDATE message_recipients SET acked = 1
     WHERE message_id = ? AND public_id = ? AND acked = 0`,
    [messageId, fromPublicId],
  );
  if (updated.changes === 0) return false;

  const row = await d.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ? AND acked = 0`,
    [messageId],
  );
  return (row?.n ?? 1) === 0;
}

export async function listMessages(peerId: string, limit = 500): Promise<Message[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<any>(
    `SELECT * FROM (
       SELECT * FROM messages WHERE peer_id = ? ORDER BY sent_at DESC LIMIT ?
     ) ORDER BY sent_at ASC`,
    [peerId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    peerId: r.peer_id,
    senderId: r.sender_id ?? null,
    outgoing: !!r.outgoing,
    text: r.text,
    sentAt: r.sent_at,
    state: r.state as MessageState,
  }));
}

export type Conversation = { peerId: string; lastText: string; lastAt: number; unread: number };

export async function listConversations(): Promise<Conversation[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<any>(`
    SELECT m.peer_id, m.text, m.sent_at,
      (SELECT COUNT(*) FROM messages mi WHERE mi.peer_id = m.peer_id AND mi.outgoing = 0)
        - COALESCE((SELECT read_count FROM conversation_reads r WHERE r.peer_id = m.peer_id), 0)
        AS unread
    FROM messages m
    JOIN (SELECT peer_id, MAX(sent_at) AS max_at FROM messages GROUP BY peer_id) latest
      ON m.peer_id = latest.peer_id AND m.sent_at = latest.max_at
    ORDER BY m.sent_at DESC
  `);
  return rows.map((r) => ({
    peerId: r.peer_id,
    lastText: r.text,
    lastAt: r.sent_at,
    // Clamp: a read_count ahead of the incoming total (should not happen) must
    // never surface as a negative badge.
    unread: Math.max(0, r.unread ?? 0),
  }));
}

/**
 * Marks a conversation fully read up to now: records that every incoming
 * message currently stored has been seen. Called when the chat is on screen.
 */
export async function markConversationRead(peerId: string): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    `INSERT INTO conversation_reads (peer_id, read_count)
     VALUES (?, (SELECT COUNT(*) FROM messages WHERE peer_id = ? AND outgoing = 0))
     ON CONFLICT(peer_id) DO UPDATE SET read_count = excluded.read_count`,
    [peerId, peerId],
  );
}

// ---------------------------------------------------------------------------
// Envelope cache (store-and-forward)
// ---------------------------------------------------------------------------

export async function storeEnvelope(e: Envelope, isOurs = false): Promise<void> {
  const d = await getDb();
  const now = Date.now();
  const claimed = e.createdAt + e.ttlSeconds * 1000;

  await d.runAsync(
    `INSERT OR REPLACE INTO envelopes (id, raw, created_at, expires_at, hop_count, is_ours)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      toBase64(e.id),
      toBase64(encodeEnvelope(e)),
      e.createdAt,
      Math.min(claimed, now + MAX_LOCAL_RETENTION_MS),
      e.hopCount,
      isOurs ? 1 : 0,
    ],
  );
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type ChannelKind = 'public' | 'channel';

export type Channel = {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Cached derived key. Deriving it costs ~200ms, so it is never recomputed. */
  key: Uint8Array;
  joinedAt: number;
};

export async function upsertChannel(
  id: string,
  name: string,
  kind: ChannelKind,
  key: Uint8Array,
): Promise<void> {
  const d = await getDb();
  await d.runAsync(
    `INSERT INTO channels (id, name, kind, key, joined_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, key = excluded.key`,
    [id, name, kind, toBase64(key), Date.now()],
  );
}

export async function listChannels(): Promise<Channel[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<any>(`SELECT * FROM channels ORDER BY joined_at ASC`);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind as ChannelKind,
    key: fromBase64(r.key),
    joinedAt: r.joined_at,
  }));
}

export async function leaveChannel(id: string): Promise<void> {
  const d = await getDb();
  await d.runAsync(`DELETE FROM channels WHERE id = ?`, [id]);
  await d.runAsync(`DELETE FROM messages WHERE peer_id = ?`, [`#${id}`]);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type Group = { id: string; name: string; members: string[]; createdAt: number };

export async function createGroup(id: string, name: string, members: string[]): Promise<void> {
  const d = await getDb();
  await d.runAsync(`INSERT OR REPLACE INTO groups (id, name, created_at) VALUES (?, ?, ?)`, [
    id,
    name,
    Date.now(),
  ]);
  await d.runAsync(`DELETE FROM group_members WHERE group_id = ?`, [id]);
  for (const m of members) {
    await d.runAsync(`INSERT OR IGNORE INTO group_members (group_id, public_id) VALUES (?, ?)`, [
      id,
      m,
    ]);
  }
}

export async function listGroups(): Promise<Group[]> {
  const d = await getDb();
  const groups = await d.getAllAsync<any>(`SELECT * FROM groups ORDER BY created_at DESC`);
  const members = await d.getAllAsync<any>(`SELECT * FROM group_members`);

  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    createdAt: g.created_at,
    members: members.filter((m) => m.group_id === g.id).map((m) => m.public_id),
  }));
}

export async function deleteGroup(id: string): Promise<void> {
  const d = await getDb();
  await d.runAsync(`DELETE FROM group_members WHERE group_id = ?`, [id]);
  await d.runAsync(`DELETE FROM groups WHERE id = ?`, [id]);
  // The receipt ledger names every member a message was fanned out to, so it is
  // a membership record in its own right and has to go with the group.
  await d.runAsync(
    `DELETE FROM message_recipients
     WHERE message_id IN (SELECT id FROM messages WHERE peer_id = ?)`,
    [`~${id}`],
  );
  await d.runAsync(`DELETE FROM messages WHERE peer_id = ?`, [`~${id}`]);
}

/** Envelopes we are still willing to pass on, newest first. */
export async function pendingEnvelopes(limit = 200): Promise<Envelope[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<any>(
    `SELECT raw FROM envelopes WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?`,
    [Date.now(), limit],
  );
  return rows
    .map((r) => decodeEnvelope(fromBase64(r.raw)))
    .filter((e): e is Envelope => e !== null);
}

export async function envelopeIds(): Promise<string[]> {
  const d = await getDb();
  const rows = await d.getAllAsync<any>(`SELECT id FROM envelopes WHERE expires_at > ?`, [
    Date.now(),
  ]);
  return rows.map((r) => r.id);
}

export async function getEnvelopesByIds(ids: string[]): Promise<Envelope[]> {
  if (ids.length === 0) return [];
  const d = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await d.getAllAsync<any>(
    `SELECT raw FROM envelopes WHERE id IN (${placeholders}) AND expires_at > ?`,
    [...ids, Date.now()],
  );
  return rows
    .map((r) => decodeEnvelope(fromBase64(r.raw)))
    .filter((e): e is Envelope => e !== null);
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/** Returns true if this envelope id is new, and records it. */
export async function markSeen(idB64: string): Promise<boolean> {
  const d = await getDb();
  const result = await d.runAsync(`INSERT OR IGNORE INTO seen (id, seen_at) VALUES (?, ?)`, [
    idB64,
    Date.now(),
  ]);
  return result.changes > 0;
}

export async function hasSeen(idB64: string): Promise<boolean> {
  const d = await getDb();
  const r = await d.getFirstAsync<any>(`SELECT 1 FROM seen WHERE id = ?`, [idB64]);
  return !!r;
}

/** Returns true the first time this decrypted-message hash is presented. */
export async function markMessageSeen(hashB64: string): Promise<boolean> {
  const d = await getDb();
  const result = await d.runAsync(
    `INSERT OR IGNORE INTO seen_messages (hash, seen_at) VALUES (?, ?)`,
    [hashB64, Date.now()],
  );
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Expiry and wipe
// ---------------------------------------------------------------------------

/** Drops everything past its TTL. Call on every foreground and on a timer. */
export async function sweepExpired(): Promise<void> {
  const d = await getDb();
  const now = Date.now();
  await d.runAsync(`DELETE FROM envelopes WHERE expires_at <= ?`, [now]);
  // Keep dedup entries a day past the longest TTL so nothing loops back.
  await d.runAsync(`DELETE FROM seen WHERE seen_at <= ?`, [now - SEEN_RETENTION_MS]);
  await d.runAsync(`DELETE FROM seen_messages WHERE seen_at <= ?`, [now - SEEN_RETENTION_MS]);
}

/**
 * The sqlite implementation of the mesh engine's storage contract.
 *
 * The annotation is the point: it is a compile-time check that db.ts and the
 * in-memory store used by the tests really do present the same surface, so a
 * green test suite cannot mean "the fake works".
 */
export const meshStore: MeshStore = {
  sweepExpired,
  envelopeIds,
  storeEnvelope,
  getEnvelopesByIds,
  markSeen,
  hasSeen,
  markMessageSeen,
  insertMessage,
  setMessageState,
  upsertContact,
  addExpectedRecipients,
  recordReceipt,
};

/**
 * Panic wipe. Deliberately does not try to be clever about secure erasure —
 * on a modern phone the filesystem is encrypted and the honest answer is that
 * dropping the tables plus the keychain entry is what we can actually promise.
 */
export async function wipeEverything(): Promise<void> {
  const d = await getDb();
  await d.execAsync(`
    DELETE FROM messages;
    DELETE FROM message_recipients;
    DELETE FROM envelopes;
    DELETE FROM seen;
    DELETE FROM seen_messages;
    DELETE FROM contacts;
    DELETE FROM group_members;
    DELETE FROM groups;
    DELETE FROM channels;
    DELETE FROM conversation_reads;
    VACUUM;
  `);
}
