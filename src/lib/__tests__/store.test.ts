/**
 * Retention semantics of the in-memory MeshStore.
 *
 * The SQL layer and the in-memory layer must obey the same retention policy —
 * see the long note in store.ts. Anything enforced here is a contract the SQL
 * layer must also meet; the duplicate is the point.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Message } from '../store';
import { MESSAGE_RETENTION_MS, createMemoryStore } from '../store';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  peerId: 'alice',
  senderId: 'alice',
  outgoing: false,
  text: 'hi',
  sentAt: 0,
  state: 'sent',
  ...over,
});

describe('message retention', () => {
  it('drops a message whose first-sight age exceeds the retention window', async () => {
    let t = 1_000_000;
    const store = createMemoryStore(() => t);
    await store.insertMessage(msg());
    // Within the window: still present.
    t += MESSAGE_RETENTION_MS - 1_000;
    await store.sweepExpired();
    assert.equal(store.messages.length, 1, 'message still inside retention');

    // One millisecond past the window: gone.
    t += 1_000;
    await store.sweepExpired();
    assert.equal(store.messages.length, 0, 'message aged out');
  });

  it('measures retention from first sight, not from the sender wall clock', async () => {
    let t = 5_000_000;
    const store = createMemoryStore(() => t);
    // sentAt is the sender's clock, four hours in the past. A message that took
    // four hours to reach us over the mesh is a normal occurrence: deleting it
    // on arrival because sentAt is "old" would silently drop delayed mail.
    await store.insertMessage(msg({ sentAt: t - 4 * 3600_000 }));
    await store.sweepExpired();
    assert.equal(store.messages.length, 1, 'delayed message must not be aged by sentAt');
  });

  it('does not reset the retention clock on re-delivery', async () => {
    let t = 1_000_000;
    const store = createMemoryStore(() => t);
    await store.insertMessage(msg());
    const originalWindow = MESSAGE_RETENTION_MS;
    t += originalWindow - 5_000;
    // Re-delivery near the end of the original window: must NOT reset the clock
    // by re-stamping firstSeen, or a peer could keep plaintext alive forever by
    // simply re-flooding the same id every few hours.
    await store.insertMessage(msg());
    t += 10_000;
    await store.sweepExpired();
    assert.equal(store.messages.length, 0, 're-delivery did not extend retention');
  });

  it('sweeps the expected-recipient ledger with the message it belongs to', async () => {
    let t = 1_000_000;
    const store = createMemoryStore(() => t);
    await store.insertMessage(msg({ id: 'm1', outgoing: true }));
    await store.addExpectedRecipients('m1', ['bob']);
    // Sanity: a receipt against a live message updates state.
    assert.equal(await store.recordReceipt('m1', 'bob'), true);

    // Re-arm an un-acked outgoing message, then age it out.
    await store.insertMessage(msg({ id: 'm2', outgoing: true }));
    await store.addExpectedRecipients('m2', ['carol']);
    t += MESSAGE_RETENTION_MS + 1_000;
    await store.sweepExpired();
    assert.equal(store.messages.length, 0, 'all messages aged out');

    // A late receipt for the aged-out message must NOT register as a delivery
    // — the expected-recipient ledger is gone with the message, so the engine
    // treats it as the no-op the SQL layer documents recordReceipt as.
    assert.equal(
      await store.recordReceipt('m2', 'carol'),
      false,
      'ledger swept with its message',
    );
  });
});
