/**
 * Multi-node mesh tests.
 *
 * The mesh is the part of this app that cannot be reasoned about by reading one
 * function. "Does a message reach someone two hops away", "does a relay drop a
 * message it cannot read", "does an envelope loop forever in a triangle" are all
 * properties of several devices interacting, and until now the only way to check
 * any of them was to stand in a room holding three phones.
 *
 * So the radio is faked and the database is faked, and everything else is the
 * real engine. Each test builds a topology explicitly — including topologies
 * where two nodes can never see each other, because relaying is the whole point
 * and it is invisible in a fully connected test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromBase64, toBase64, toUtf8 } from '../bytes';
import type { Identity, PublicIdentity } from '../crypto-core';
import { PUBLIC_CHANNEL_KEY, identityFromSeed, randomId, seal } from '../crypto-core';
import { MeshEngine } from '../mesh';
import type { Envelope } from '../protocol';
import {
  DEFAULTS,
  EnvelopeType,
  PROTOCOL_VERSION,
  decodeEnvelope,
  encodeBody,
  encodeEnvelope,
  pad,
} from '../protocol';
import type { MemoryStore } from '../store';
import { createMemoryStore } from '../store';
import type { Peer, Transport, TransportEvents } from '../transport';

// ---------------------------------------------------------------------------
// A fake radio
// ---------------------------------------------------------------------------

/**
 * The world holds the topology. Two nodes exchange bytes only if the test has
 * explicitly linked them, which is what makes "A and C are not in range of each
 * other" expressible at all.
 */
class World {
  private nodes = new Map<string, FakeTransport>();
  private links = new Set<string>();
  private queue: (() => void)[] = [];

  /** Bumped on every delivered payload; `settle()` uses it to detect quiescence. */
  delivered = 0;

  private static link = (a: string, b: string): string => [a, b].sort().join('|');

  transport(id: string): FakeTransport {
    let t = this.nodes.get(id);
    if (!t) {
      t = new FakeTransport(id, this);
      this.nodes.set(id, t);
    }
    return t;
  }

  linked(a: string, b: string): boolean {
    return this.links.has(World.link(a, b));
  }

  connect(a: string, b: string): void {
    this.links.add(World.link(a, b));
    this.transport(a).fire('connected', { id: b, name: b });
    this.transport(b).fire('connected', { id: a, name: a });
  }

  disconnect(a: string, b: string): void {
    this.links.delete(World.link(a, b));
    this.transport(a).fire('disconnected', b);
    this.transport(b).fire('disconnected', a);
  }

  deliver(from: string, to: string, payloadBase64: string): void {
    // Radios are not synchronous. Delivering on a later turn is what lets the
    // dedup tests see genuinely concurrent arrivals rather than a tidy stack.
    this.queue.push(() => {
      this.delivered++;
      this.transport(to).fire('payload', from, payloadBase64);
    });
    queueMicrotask(() => this.queue.shift()?.());
  }

  /**
   * Runs the world until nothing is in flight.
   *
   * The engine handles payloads fire-and-forget (`void this.ingest(...)`), so
   * there is no promise to await; instead we spin the event loop until a full
   * round passes with no new delivery.
   */
  async settle(): Promise<void> {
    for (let round = 0; round < 100; round++) {
      const before = this.delivered;
      for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
      if (this.delivered === before) return;
    }
    throw new Error('mesh never settled — envelopes are circulating forever');
  }
}

class FakeTransport implements Transport {
  readonly available = true;
  readonly id: string;
  private world: World;
  private handlers = new Map<keyof TransportEvents, Set<(...a: any[]) => void>>();

  /** Every payload this node put on the air, for "did it stop forwarding" assertions. */
  sent: { to: string; payloadBase64: string }[] = [];

  constructor(id: string, world: World) {
    this.id = id;
    this.world = world;
  }

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as (...a: any[]) => void);
    return () => void set!.delete(handler as (...a: any[]) => void);
  }

  fire<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>): void {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(peerId: string, payloadBase64: string): Promise<void> {
    if (!this.world.linked(this.id, peerId)) throw new Error(`${this.id} is not in range of ${peerId}`);
    this.sent.push({ to: peerId, payloadBase64 });
    this.world.deliver(this.id, peerId, payloadBase64);
  }
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

type Node = {
  id: string;
  identity: Identity;
  pub: PublicIdentity;
  engine: MeshEngine;
  store: MemoryStore;
  transport: FakeTransport;
  /** Everything onMessage handed us, in order. */
  read: { conversationId: string; sender: string; text: string }[];
};

const publicOf = (i: Identity): PublicIdentity => ({
  edPublic: i.edPublic,
  xPublic: i.xPublic,
  publicId: i.publicId,
});

let seedCounter = 0;

async function spawn(world: World, id: string): Promise<Node> {
  const identity = identityFromSeed(new Uint8Array(32).fill((seedCounter++ % 250) + 1));
  const store = createMemoryStore();
  const transport = world.transport(id);
  const engine = new MeshEngine(transport, store);
  const read: Node['read'] = [];
  engine.onMessage = (conversationId, sender, text) => void read.push({ conversationId, sender, text });
  await engine.start(identity, id);
  return { id, identity, pub: publicOf(identity), engine, store, transport, read };
}

/**
 * Every engine holds a 60s sweep interval while running, so a leaked node would
 * hold the test runner open. Scenarios always tear down, including on failure.
 */
async function scenario(
  ids: string[],
  body: (nodes: Record<string, Node>, world: World) => Promise<void>,
): Promise<void> {
  const world = new World();
  const nodes: Record<string, Node> = {};
  try {
    for (const id of ids) nodes[id] = await spawn(world, id);
    await body(nodes, world);
  } finally {
    for (const n of Object.values(nodes)) await n.engine.stop();
  }
}

/** Incoming messages a node actually decrypted and filed. */
const inbox = (n: Node) => n.store.messages.filter((m) => !m.outgoing);

/** Sealed traffic a node put on the air, ignoring inventory/request chatter. */
const relayed = (n: Node) =>
  n.transport.sent.filter(
    (s) => decodeEnvelope(fromBase64(s.payloadBase64))?.type === EnvelopeType.Sealed,
  );

const plaintextAnywhere = (n: Node, text: string) =>
  n.store.messages.some((m) => m.text.includes(text));

/** Envelopes a node originated rather than relayed. A receipt shows up here. */
const injected = (n: Node) => n.store.envelopes.filter((e) => e.isOurs);

const stateOf = (n: Node, messageId: string) =>
  n.store.messages.find((m) => m.id === messageId)?.state;

// ---------------------------------------------------------------------------

describe('direct delivery', () => {
  it('delivers A -> B when they are connected', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      world.connect('A', 'B');
      await world.settle();

      await A.engine.sendText(B.pub, 'meet at the north gate');
      await world.settle();

      assert.deepEqual(
        inbox(B).map((m) => m.text),
        ['meet at the north gate'],
      );
      assert.equal(inbox(B)[0].senderId, A.identity.publicId);
      // A direct message files under the sender, not under a channel or group.
      assert.equal(inbox(B)[0].peerId, A.identity.publicId);
    }));

  it('marks an outgoing message sent once there is someone to send to', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      const lonely = await A.engine.sendText(B.pub, 'nobody around');
      assert.equal(A.store.messages.find((m) => m.id === lonely)?.state, 'queued');

      world.connect('A', 'B');
      await world.settle();

      const connected = await A.engine.sendText(B.pub, 'someone around');
      assert.equal(A.store.messages.find((m) => m.id === connected)?.state, 'sent');
    }));
});

describe('relaying', () => {
  it('carries A -> C through B when A and C are never in range', () =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      world.connect('A', 'B');
      world.connect('B', 'C');
      await world.settle();
      assert.equal(world.linked('A', 'C'), false);

      await A.engine.sendText(C.pub, 'the bridge is blocked');
      await world.settle();

      assert.deepEqual(
        inbox(C).map((m) => m.text),
        ['the bridge is blocked'],
      );
      // The hop actually happened rather than the fake radio cheating.
      assert.equal(A.transport.sent.every((s) => s.to === 'B'), true);
    }));

  it('does not let the relay read what it relays', () =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      world.connect('A', 'B');
      world.connect('B', 'C');
      await world.settle();

      await A.engine.sendText(C.pub, 'safehouse is on elm street');
      await world.settle();

      // B carried the ciphertext — the message one way and C's delivery
      // receipt back the other, both equally opaque to it...
      assert.equal(B.store.envelopes.length, 2);
      // ...and learned nothing from it: no plaintext, no message row, and not
      // even the existence of the sender as a contact.
      assert.equal(plaintextAnywhere(B, 'safehouse'), false);
      assert.deepEqual(B.store.messages, []);
      assert.deepEqual(B.store.contacts, []);
      assert.deepEqual(B.read, []);
      // Only the recipient learns who spoke to them.
      assert.deepEqual(
        C.store.contacts.map((c) => c.publicId),
        [A.identity.publicId],
      );
    }));
});

describe('dedup', () => {
  it('processes an envelope once when it arrives from two directions', () =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      // Fully connected triangle: C hears the message straight from A and again
      // via B, and B hears it from A and again via C.
      world.connect('A', 'B');
      world.connect('B', 'C');
      world.connect('A', 'C');
      await world.settle();

      await A.engine.sendText(C.pub, 'twice over');
      await world.settle();

      assert.deepEqual(
        inbox(C).map((m) => m.text),
        ['twice over'],
      );
      assert.equal(C.read.length, 1);
      // One envelope per distinct thing on the air, not one per arrival: the
      // message, and C's delivery receipt heading back to A.
      assert.equal(B.store.envelopes.length, 2);
      assert.equal(C.store.envelopes.length, 2);
    }));

  it('stops an envelope circulating in a loop', () =>
    scenario(['A', 'B', 'C'], async ({ A, C }, world) => {
      world.connect('A', 'B');
      world.connect('B', 'C');
      world.connect('A', 'C');
      await world.settle();

      const before = world.delivered;
      await A.engine.sendText(C.pub, 'round and round');
      // settle() itself throws if the mesh never goes quiet, so reaching this
      // line is most of the assertion.
      await world.settle();

      // Two envelopes now circulate — the message and C's receipt — and each of
      // the three nodes forwards each at most to its two neighbours. Anything
      // beyond that means the dedup ledger is not holding.
      assert.ok(world.delivered - before <= 12, `too much traffic: ${world.delivered - before}`);
    }));

  it('does not deliver a replayed message twice', () =>
    scenario(['A', 'C'], async ({ A, C }, world) => {
      world.connect('A', 'C');
      await world.settle();

      await A.engine.sendText(C.pub, 'we move at nine');
      await world.settle();
      assert.equal(inbox(C).length, 1);

      // The replay: take the exact sealed envelope A put on the air and re-wrap
      // the identical ciphertext in a FRESH envelope id, so the envelope-id
      // dedup misses it — then hand it to C as if a peer re-broadcast it.
      const original = A.transport.sent
        .map((s) => decodeEnvelope(fromBase64(s.payloadBase64)))
        .find((e): e is Envelope => !!e && e.type === EnvelopeType.Sealed && e.payload.length > 200);
      assert.ok(original, 'no sealed message captured');

      const replay = encodeEnvelope({ ...original, id: fromBase64(randomId()) });
      world.transport('C').fire('payload', 'A', toBase64(replay));
      await world.settle();

      // Content-level dedup must keep this from becoming a second copy — a stale
      // "we move at nine" resurfacing later is exactly the danger.
      assert.equal(inbox(C).length, 1, 'replay was delivered as a duplicate');
    }));
});

describe('store and forward', () => {
  it('holds a message for a peer who is not there yet', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      // Nobody in range: the envelope goes into the carry cache and no further.
      await A.engine.sendText(B.pub, 'later, then');
      await world.settle();
      assert.equal(A.store.envelopes.length, 1);
      assert.deepEqual(inbox(B), []);

      world.connect('A', 'B');
      await world.settle();

      assert.deepEqual(
        inbox(B).map((m) => m.text),
        ['later, then'],
      );
    }));

  it('still delivers after the sender has walked away, via a courier', () =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      // A hands the message to B and leaves. B never knew what it was carrying.
      world.connect('A', 'B');
      await world.settle();
      await A.engine.sendText(C.pub, 'carried by a stranger');
      await world.settle();
      world.disconnect('A', 'B');

      world.connect('B', 'C');
      await world.settle();

      assert.deepEqual(
        inbox(C).map((m) => m.text),
        ['carried by a stranger'],
      );
    }));
});

describe('inventory sync', () => {
  it('reconciles what two nodes carry when they meet', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      // Both compose while apart, so neither broadcast reaches anyone.
      await A.engine.sendText(B.pub, 'from A');
      await B.engine.sendText(A.pub, 'from B');
      await world.settle();

      world.connect('A', 'B');
      await world.settle();

      assert.deepEqual(
        inbox(B).map((m) => m.text),
        ['from A'],
      );
      assert.deepEqual(
        inbox(A).map((m) => m.text),
        ['from B'],
      );
      // Both now carry both messages plus both receipts.
      assert.equal(A.store.envelopes.length, 4);
      assert.equal(B.store.envelopes.length, 4);
    }));

  it('does not re-request an envelope it already carries', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      world.connect('A', 'B');
      await world.settle();
      await A.engine.sendText(B.pub, 'only once');
      await world.settle();

      // A reconnection makes both sides offer their inventory again.
      world.disconnect('A', 'B');
      const before = world.delivered;
      world.connect('A', 'B');
      await world.settle();

      // Two inventory offers and nothing else: no envelope is re-sent.
      assert.equal(world.delivered - before, 2);
      assert.equal(inbox(B).length, 1);
    }));
});

describe('hop limit', () => {
  it('dies after maxHops rather than crossing an arbitrarily long chain', () => {
    const chain = ['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7'];
    return scenario(chain, async (n, world) => {
      for (let i = 0; i + 1 < chain.length; i++) world.connect(chain[i], chain[i + 1]);
      await world.settle();

      // Sealed to the far end of the chain, which is maxHops + 1 links away.
      await n.N0.engine.sendText(n.N7.pub, 'too far');
      await world.settle();

      const carriers = chain.filter((id) => n[id].store.envelopes.length > 0);
      // Injector plus one relay per hop, and no further.
      assert.deepEqual(carriers, chain.slice(0, DEFAULTS.maxHops + 1));

      // The intended recipient is simply out of reach. That is the design: reach
      // is bounded by hops, not by who the message is for.
      assert.deepEqual(inbox(n.N7), []);
      // The last node to see it did not put it back on the air.
      assert.deepEqual(relayed(n[chain[DEFAULTS.maxHops]]), []);
    });
  });

  it('refuses to forward an envelope that arrives at its hop limit', () =>
    scenario(['B', 'C'], async ({ B, C }, world) => {
      world.connect('B', 'C');
      await world.settle();

      // A hostile or exhausted envelope handed to B directly by a node with no
      // engine of its own.
      const ghost = world.transport('ghost');
      world.connect('ghost', 'B');
      await world.settle();

      const spent: Envelope = {
        version: PROTOCOL_VERSION,
        type: EnvelopeType.Sealed,
        id: fromBase64('AAAAAAAAAAAAAAAAAAAAAA=='),
        createdAt: Date.now(),
        ttlSeconds: 600,
        hopCount: 3,
        maxHops: 4,
        payload: pad(toUtf8('opaque')),
      };
      const before = C.store.envelopes.length;
      await ghost.send('B', toBase64(encodeEnvelope(spent)));
      await world.settle();

      // B keeps it — it may still hand it to someone by inventory sync — but it
      // does not put it back on the air.
      assert.equal(B.store.envelopes.length, 1);
      assert.equal(C.store.envelopes.length, before);
      assert.deepEqual(relayed(B), []);
    }));
});

describe('expiry', () => {
  it('does not relay or store an envelope past its TTL', () =>
    scenario(['B', 'C'], async ({ B, C }, world) => {
      world.connect('B', 'C');
      const ghost = world.transport('ghost');
      world.connect('ghost', 'B');
      await world.settle();

      const stale: Envelope = {
        version: PROTOCOL_VERSION,
        type: EnvelopeType.Sealed,
        id: fromBase64('BBBBBBBBBBBBBBBBBBBBBB=='),
        // Two hours old with a one minute TTL. Dead on arrival.
        createdAt: Date.now() - 2 * 3600_000,
        ttlSeconds: 60,
        hopCount: 0,
        maxHops: 6,
        payload: pad(toUtf8('opaque')),
      };
      await ghost.send('B', toBase64(encodeEnvelope(stale)));
      await world.settle();

      assert.deepEqual(B.store.envelopes, []);
      assert.deepEqual(C.store.envelopes, []);
    }));

  it('caps retention at first sight however long the envelope claims to live', () =>
    scenario(['B'], async ({ B }, world) => {
      const ghost = world.transport('ghost');
      world.connect('ghost', 'B');
      await world.settle();

      const greedy: Envelope = {
        version: PROTOCOL_VERSION,
        type: EnvelopeType.Sealed,
        id: fromBase64('CCCCCCCCCCCCCCCCCCCCCC=='),
        createdAt: Date.now(),
        // Six days. The outer header is unauthenticated, so a relay can claim
        // anything; the local cap is what stops a phone becoming an archive.
        ttlSeconds: 6 * 24 * 3600,
        hopCount: 0,
        maxHops: 6,
        payload: pad(toUtf8('opaque')),
      };
      await ghost.send('B', toBase64(encodeEnvelope(greedy)));
      await world.settle();

      const [stored] = B.store.envelopes;
      assert.ok(stored, 'envelope should have been carried');
      assert.ok(stored.expiresAt <= Date.now() + 6 * 3600_000 + 1000);
    }));
});

describe('channels', () => {
  const channelKey = new Uint8Array(32).fill(9);
  const otherKey = new Uint8Array(32).fill(8);

  it('is readable by every holder of the key and by nobody else', () =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      // C sits between A and B, so it has to relay a channel it is not in.
      world.connect('A', 'C');
      world.connect('C', 'B');
      A.engine.setChannelKeys([{ id: 'chan', key: channelKey }]);
      B.engine.setChannelKeys([{ id: 'chan', key: channelKey }]);
      C.engine.setChannelKeys([{ id: 'other', key: otherKey }]);
      await world.settle();

      await A.engine.sendToChannel('chan', channelKey, 'rally at six');
      await world.settle();

      assert.deepEqual(
        inbox(B).map((m) => m.text),
        ['rally at six'],
      );
      // Channel messages file under the channel, not under the sender.
      assert.equal(inbox(B)[0].peerId, '#chan');
      assert.equal(inbox(B)[0].senderId, A.identity.publicId);

      // The relay held the wrong key: it forwarded and understood nothing.
      assert.equal(C.store.envelopes.length, 1);
      assert.deepEqual(C.store.messages, []);
    }));

  it('delivers a public broadcast to a stranger', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      world.connect('A', 'B');
      A.engine.setChannelKeys([{ id: 'public', key: PUBLIC_CHANNEL_KEY }]);
      B.engine.setChannelKeys([{ id: 'public', key: PUBLIC_CHANNEL_KEY }]);
      await world.settle();
      // B has never heard of A — that is the point of broadcast.
      assert.deepEqual(B.store.contacts, []);

      await A.engine.sendToChannel('public', PUBLIC_CHANNEL_KEY, 'police at the east exit');
      await world.settle();

      assert.deepEqual(
        B.read.map((m) => [m.conversationId, m.text]),
        [['#public', 'police at the east exit']],
      );
    }));
});

describe('groups', () => {
  it('reaches every member by fan-out and nobody else', (t) =>
    scenario(['A', 'B', 'C', 'D'], async ({ A, B, C, D }, world) => {
      // D is not a member but is the only path from A to C.
      world.connect('A', 'B');
      world.connect('A', 'D');
      world.connect('D', 'C');
      await world.settle();

      // Fan-out jitters each copy by up to 3s on purpose; drive that clock
      // rather than waiting on it.
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const sending = A.engine.sendToGroup('g1', [B.pub, C.pub], 'we move at nine');
      await world.settle();
      t.mock.timers.tick(4000);
      await sending;
      await world.settle();
      t.mock.timers.reset();

      assert.deepEqual(
        inbox(B).map((m) => m.text),
        ['we move at nine'],
      );
      assert.deepEqual(
        inbox(C).map((m) => m.text),
        ['we move at nine'],
      );
      // The sender's own copy is filed under the group, so all three see it.
      assert.equal(A.store.messages.filter((m) => m.peerId === '~g1').length, 1);

      // The non-member relayed both sealed copies and both receipts coming back
      // (C's through it, B's forwarded on by A) and could read none of them.
      assert.equal(D.store.envelopes.length, 4);
      assert.deepEqual(D.store.messages, []);
      assert.deepEqual(D.read, []);
    }));

  it('seals one independent copy per member', (t) =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      world.connect('A', 'B');
      world.connect('A', 'C');
      await world.settle();

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const sending = A.engine.sendToGroup('g2', [B.pub, C.pub], 'separate copies');
      await world.settle();
      t.mock.timers.tick(4000);
      await sending;
      await world.settle();
      t.mock.timers.reset();

      // Two distinct envelopes with two distinct ciphertexts: there is no group
      // key, so there is nothing to leak by adding or removing a member.
      // Filtered to what A itself injected, since A is now also carrying the
      // two receipts that came back.
      const raws = new Set(A.store.envelopes.filter((e) => e.isOurs).map((e) => e.raw));
      assert.equal(raws.size, 2);
      assert.equal(inbox(B).length, 1);
      assert.equal(inbox(C).length, 1);
      // Members see the message as a plain direct message from the sender: the
      // group is a local notion and never appears on the wire.
      assert.equal(inbox(B)[0].peerId, A.identity.publicId);
    }));
});

describe('delivery receipts', () => {
  it('advances a direct message to delivered once the recipient acks', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      world.connect('A', 'B');
      await world.settle();

      const id = await A.engine.sendText(B.pub, 'are you there');
      await world.settle();

      assert.equal(stateOf(A, id), 'delivered');
      // The ack is one sealed envelope B put on the air itself.
      assert.equal(injected(B).length, 1);
    }));

  it('rides store-and-forward home when sender and recipient never meet', () =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      // A and C are never in range of each other; B is the only path, and it is
      // the path the receipt has to take back as well.
      world.connect('A', 'B');
      world.connect('B', 'C');
      await world.settle();
      assert.equal(world.linked('A', 'C'), false);

      const id = await A.engine.sendText(C.pub, 'the bridge is blocked');
      await world.settle();

      assert.equal(inbox(C).length, 1);
      assert.equal(stateOf(A, id), 'delivered');
      // The courier learned nothing by carrying the ack either.
      assert.deepEqual(B.store.messages, []);
    }));

  it('carries an ack across a gap in time, not just in space', () =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      // A composes with nobody in range at all: the message is queued and stays
      // queued, which is the case where the indicator matters most.
      const id = await A.engine.sendText(C.pub, 'later, then');
      await world.settle();
      assert.equal(stateOf(A, id), 'queued');

      // B walks past A, takes the message, walks away, and meets C.
      world.connect('A', 'B');
      await world.settle();
      world.disconnect('A', 'B');
      world.connect('B', 'C');
      await world.settle();
      assert.equal(inbox(C).length, 1);
      // A still has no idea: nothing has come back yet, and 'queued' is only
      // ever upgraded by news from outside, never by time passing.
      assert.equal(stateOf(A, id), 'queued');

      // B walks back. Only now does A learn the message landed.
      world.disconnect('B', 'C');
      world.connect('A', 'B');
      await world.settle();

      assert.equal(stateOf(A, id), 'delivered');
    }));

  it('sends no receipt for a channel message', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      const channelKey = new Uint8Array(32).fill(9);
      world.connect('A', 'B');
      A.engine.setChannelKeys([{ id: 'chan', key: channelKey }]);
      B.engine.setChannelKeys([{ id: 'chan', key: channelKey }]);
      await world.settle();

      const id = await A.engine.sendToChannel('chan', channelKey, 'rally at six');
      await world.settle();

      assert.equal(inbox(B).length, 1);
      // Acking here would hand every key-holder a per-message read log of every
      // other member, so B originates nothing at all.
      assert.deepEqual(injected(B), []);
      assert.equal(stateOf(A, id), 'sent');
      assert.equal(A.store.envelopes.length, 1);
    }));

  it('sends no receipt for a public broadcast', () =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      world.connect('A', 'B');
      world.connect('A', 'C');
      for (const n of [A, B, C]) n.engine.setChannelKeys([{ id: 'public', key: PUBLIC_CHANNEL_KEY }]);
      await world.settle();

      const id = await A.engine.sendToChannel('public', PUBLIC_CHANNEL_KEY, 'police at the east exit');
      await world.settle();

      // Every device running the app holds this key. One ack per listener per
      // broadcast is a storm, and it would name the audience of a megaphone.
      assert.equal(inbox(B).length, 1);
      assert.equal(inbox(C).length, 1);
      assert.deepEqual(injected(B), []);
      assert.deepEqual(injected(C), []);
      assert.equal(stateOf(A, id), 'sent');
    }));

  it('does not ack an ack', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      world.connect('A', 'B');
      await world.settle();

      await A.engine.sendText(B.pub, 'ping');
      // settle() throws if traffic never stops, so an ack-of-ack loop fails here
      // rather than merely being counted.
      await world.settle();

      // Exactly two things were ever put on the air: the message and its ack.
      assert.equal(injected(A).length, 1);
      assert.equal(injected(B).length, 1);
      assert.equal(A.store.envelopes.length, 2);
      assert.equal(B.store.envelopes.length, 2);
      // The ack is not filed as a message by either side.
      assert.deepEqual(inbox(A), []);
      assert.equal(inbox(B).length, 1);
    }));

  it('ignores a receipt for a message it never sent', () =>
    scenario(['A', 'B'], async ({ A, B }, world) => {
      const ghostIdentity = identityFromSeed(new Uint8Array(32).fill(201));
      const ghost = world.transport('ghost');
      world.connect('ghost', 'A');
      await world.settle();

      // B is not in range; the ghost is, so this counts as handed to the mesh.
      const id = await A.engine.sendText(B.pub, 'nobody around');
      assert.equal(stateOf(A, id), 'sent');

      const forge = async (messageId: string, envelopeId: string) => {
        const body = pad(
          toUtf8(encodeBody({ kind: 'receipt', messageId, receivedAt: Date.now() })),
        );
        const e: Envelope = {
          version: PROTOCOL_VERSION,
          type: EnvelopeType.Sealed,
          id: fromBase64(envelopeId),
          createdAt: Date.now(),
          ttlSeconds: 600,
          hopCount: 0,
          maxHops: 6,
          payload: seal(ghostIdentity, A.pub, body),
        };
        await ghost.send('A', toBase64(encodeEnvelope(e)));
        await world.settle();
      };

      // A message id A has never issued.
      await forge('bm90LWEtcmVhbC1pZA==', 'DDDDDDDDDDDDDDDDDDDDDD==');
      assert.equal(stateOf(A, id), 'sent');

      // And A's real message id, acked by someone it was never addressed to.
      // The ledger keys on (message, recipient) precisely so this does nothing:
      // "delivered" is a claim the user acts on, so a stranger must not be able
      // to make it.
      await forge(id, 'EEEEEEEEEEEEEEEEEEEEEE==');
      assert.equal(stateOf(A, id), 'sent');
      assert.deepEqual(inbox(A), []);
    }));

  it('gives a relay nothing to tell a receipt and a message apart by', () =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      world.connect('A', 'B');
      world.connect('B', 'C');
      await world.settle();

      await A.engine.sendText(C.pub, 'meet at the north gate');
      await world.settle();

      // B holds the message on its way out and the receipt on its way back.
      const carried = B.store.envelopes.map((e) => decodeEnvelope(fromBase64(e.raw))!);
      assert.equal(carried.length, 2);

      // Same envelope type: there is no receipt bit on the wire.
      assert.deepEqual(new Set(carried.map((e) => e.type)), new Set([EnvelopeType.Sealed]));
      // Same size, because both bodies are padded into the same bucket. A
      // distinctive small envelope coming straight back would let an observer
      // pair up both endpoints of a conversation by traffic analysis alone.
      assert.equal(new Set(carried.map((e) => e.payload.length)).size, 1);
      // And still entirely opaque to the relay.
      assert.deepEqual(B.store.messages, []);
      assert.deepEqual(B.read, []);
    }));

  it('holds a group message at sent until every member has acked', (t) =>
    scenario(['A', 'B', 'C'], async ({ A, B, C }, world) => {
      // C is out of range at send time, so only B can ack to begin with.
      world.connect('A', 'B');
      await world.settle();

      t.mock.timers.enable({ apis: ['setTimeout'] });
      const sending = A.engine.sendToGroup('g3', [B.pub, C.pub], 'we move at nine');
      await world.settle();
      t.mock.timers.tick(4000);
      const id = await sending;
      await world.settle();
      t.mock.timers.reset();

      assert.equal(inbox(B).length, 1);
      assert.equal(inbox(C).length, 0);
      // One of two members has confirmed. A group message is one row in the UI
      // and its state has to be the weakest guarantee that holds across the
      // whole fan-out, so a partial ack is still just 'sent'.
      assert.equal(stateOf(A, id), 'sent');

      world.connect('A', 'C');
      await world.settle();

      assert.equal(inbox(C).length, 1);
      assert.equal(stateOf(A, id), 'delivered');
    }));
});
