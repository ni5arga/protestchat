/**
 * Trust store tests.
 *
 * Tests the in-memory TrustStore implementation independently.
 * Every storage operation is covered: add, get, list, remove.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMemoryTrustStore } from '../store';
import type { Entity, Delegation, SignedStatement } from '../types';
import { createKeys } from './fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function makeEntity(overrides: Partial<Entity> & { id: string; publicKey: Uint8Array }): Entity {
  return {
    name: 'test',
    trustKind: 'none',
    addedAt: Date.now(),
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryTrustStore', () => {
  describe('entities', () => {
    it('adds and gets an entity', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);
      const entity = makeEntity({ id: key.id, publicKey: key.publicKey, name: 'Alice', trustKind: 'root' });

      await s.addEntity(entity);
      const got = await s.getEntity(key.id);
      assert.ok(got);
      assert.equal(got!.id, key.id);
      assert.equal(got!.name, 'Alice');
      assert.equal(got!.trustKind, 'root');
    });

    it('returns null for a missing entity', async () => {
      const s = createMemoryTrustStore();
      assert.equal(await s.getEntity('nonexistent'), null);
    });

    it('overwrites an existing entity on add', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);
      await s.addEntity(makeEntity({ id: key.id, publicKey: key.publicKey, name: 'First', trustKind: 'none' }));
      await s.addEntity(makeEntity({ id: key.id, publicKey: key.publicKey, name: 'Second', trustKind: 'root' }));

      const got = await s.getEntity(key.id);
      assert.equal(got!.name, 'Second');
      assert.equal(got!.trustKind, 'root');
    });

    it('removes an entity', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);
      await s.addEntity(makeEntity({ id: key.id, publicKey: key.publicKey }));
      await s.removeEntity(key.id);
      assert.equal(await s.getEntity(key.id), null);
    });

    it('lists all entities', async () => {
      const s = createMemoryTrustStore();
      const [a, b] = createKeys(2);
      await s.addEntity(makeEntity({ id: a.id, publicKey: a.publicKey }));
      await s.addEntity(makeEntity({ id: b.id, publicKey: b.publicKey }));

      const all = await s.listEntities();
      assert.equal(all.length, 2);
    });

    it('lists entities by kind', async () => {
      const s = createMemoryTrustStore();
      const [a, b, c] = createKeys(3);
      await s.addEntity(makeEntity({ id: a.id, publicKey: a.publicKey, trustKind: 'root' }));
      await s.addEntity(makeEntity({ id: b.id, publicKey: b.publicKey, trustKind: 'direct' }));
      await s.addEntity(makeEntity({ id: c.id, publicKey: c.publicKey, trustKind: 'none' }));

      const roots = await s.listEntitiesByKind('root');
      assert.equal(roots.length, 1);
      assert.equal(roots[0].id, a.id);

      const directs = await s.listEntitiesByKind('direct');
      assert.equal(directs.length, 1);
      assert.equal(directs[0].id, b.id);
    });

    it('clones publicKey so mutations do not affect store', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);
      await s.addEntity(makeEntity({ id: key.id, publicKey: key.publicKey }));

      const got = await s.getEntity(key.id);
      got!.publicKey[0] ^= 0xff; // mutate

      const got2 = await s.getEntity(key.id);
      assert.equal(got2!.publicKey[0], key.publicKey[0]); // unchanged
    });
  });

  describe('delegations', () => {
    it('adds and retrieves delegations for a delegate', async () => {
      const s = createMemoryTrustStore();
      const [issuer, delegate] = createKeys(2);

      const d: Delegation = {
        id: 'd1',
        issuer: issuer.id,
        delegate: delegate.id,
        scope: ['announce'],
        issuedAt: Date.now(),
        statementId: 's1',
      };
      await s.addDelegation(d);

      const forDelegate = await s.getDelegationsForDelegate(delegate.id);
      assert.equal(forDelegate.length, 1);
      assert.equal(forDelegate[0].id, 'd1');
    });

    it('retrieves delegations by issuer', async () => {
      const s = createMemoryTrustStore();
      const [issuer, d1, d2] = createKeys(3);

      await s.addDelegation({
        id: 'd1', issuer: issuer.id, delegate: d1.id, scope: ['announce'],
        issuedAt: Date.now(), statementId: 's1',
      });
      await s.addDelegation({
        id: 'd2', issuer: issuer.id, delegate: d2.id, scope: ['certify'],
        issuedAt: Date.now(), statementId: 's2',
      });

      const byIssuer = await s.getDelegationsByIssuer(issuer.id);
      assert.equal(byIssuer.length, 2);
    });

    it('removes a delegation', async () => {
      const s = createMemoryTrustStore();
      const [issuer, delegate] = createKeys(2);

      await s.addDelegation({
        id: 'd1', issuer: issuer.id, delegate: delegate.id, scope: ['announce'],
        issuedAt: Date.now(), statementId: 's1',
      });
      await s.removeDelegation('d1');

      assert.equal((await s.getDelegationsForDelegate(delegate.id)).length, 0);
    });

    it('lists all delegations', async () => {
      const s = createMemoryTrustStore();
      const [issuer, d1, d2] = createKeys(3);

      await s.addDelegation({
        id: 'd1', issuer: issuer.id, delegate: d1.id, scope: ['announce'],
        issuedAt: Date.now(), statementId: 's1',
      });
      await s.addDelegation({
        id: 'd2', issuer: issuer.id, delegate: d2.id, scope: ['certify'],
        issuedAt: Date.now(), statementId: 's2',
      });

      assert.equal((await s.listDelegations()).length, 2);
    });

    it('cleans up delegation indexes when entity is removed', async () => {
      const s = createMemoryTrustStore();
      const [issuer, delegate] = createKeys(2);

      await s.addEntity(makeEntity({ id: issuer.id, publicKey: issuer.publicKey }));
      await s.addEntity(makeEntity({ id: delegate.id, publicKey: delegate.publicKey }));

      await s.addDelegation({
        id: 'd1', issuer: issuer.id, delegate: delegate.id, scope: ['announce'],
        issuedAt: Date.now(), statementId: 's1',
      });

      await s.removeEntity(delegate.id);

      // Delegation should be cleaned up
      assert.equal((await s.getDelegationsForDelegate(delegate.id)).length, 0);
      assert.equal((await s.listDelegations()).length, 0);
    });
  });

  describe('revocations', () => {
    it('adds and checks revocations', async () => {
      const s = createMemoryTrustStore();
      const [issuer, target] = createKeys(2);

      await s.addRevocation({
        id: 'r1',
        issuer: issuer.id,
        target: target.id,
        reason: 'test',
        issuedAt: Date.now(),
        statementId: 's1',
      });

      assert.ok(await s.isRevoked(target.id));
      assert.equal(await s.isRevoked(issuer.id), false);
    });

    it('lists revocations', async () => {
      const s = createMemoryTrustStore();
      const [issuer, t1, t2] = createKeys(3);

      await s.addRevocation({ id: 'r1', issuer: issuer.id, target: t1.id, reason: 'a', issuedAt: Date.now(), statementId: 's1' });
      await s.addRevocation({ id: 'r2', issuer: issuer.id, target: t2.id, reason: 'b', issuedAt: Date.now(), statementId: 's2' });

      assert.equal((await s.listRevocations()).length, 2);
    });

    it('filters revocations by target', async () => {
      const s = createMemoryTrustStore();
      const [issuer, target] = createKeys(2);

      await s.addRevocation({ id: 'r1', issuer: issuer.id, target: target.id, reason: 'x', issuedAt: Date.now(), statementId: 's1' });

      const forTarget = await s.getRevocationsForTarget(target.id);
      assert.equal(forTarget.length, 1);
      assert.equal(forTarget[0].id, 'r1');
    });
  });

  describe('emergency validations', () => {
    it('adds and counts validations', async () => {
      const s = createMemoryTrustStore();
      const [v1, v2] = createKeys(2);

      await s.addValidation({ statementId: 'em1', validator: v1.id, validatedAt: Date.now(), signature: new Uint8Array(64) });
      await s.addValidation({ statementId: 'em1', validator: v2.id, validatedAt: Date.now(), signature: new Uint8Array(64) });

      assert.equal(await s.getValidationCount('em1'), 2);
    });

    it('does not duplicate validations', async () => {
      const s = createMemoryTrustStore();
      const [v] = createKeys(1);

      await s.addValidation({ statementId: 'em1', validator: v.id, validatedAt: Date.now(), signature: new Uint8Array(64) });
      await s.addValidation({ statementId: 'em1', validator: v.id, validatedAt: Date.now(), signature: new Uint8Array(64) });

      assert.equal(await s.getValidationCount('em1'), 1);
    });

    it('retrieves validations for a statement', async () => {
      const s = createMemoryTrustStore();
      const [v] = createKeys(1);

      await s.addValidation({ statementId: 'em1', validator: v.id, validatedAt: Date.now(), signature: new Uint8Array(64) });

      const vals = await s.getValidationsForStatement('em1');
      assert.equal(vals.length, 1);
      assert.equal(vals[0].validator, v.id);
    });
  });

  describe('pending emergencies', () => {
    it('adds and lists pending emergencies', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);

      const signed: SignedStatement = {
        statement: {
          id: 'e1',
          type: 'emergency',
          issuer: key.id,
          payload: encoder.encode('help'),
          issuedAt: Date.now(),
        },
        signature: new Uint8Array(64).fill(1),
      };

      await s.addPendingEmergency(signed);
      const pending = await s.getPendingEmergencies();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].statement.id, 'e1');
    });

    it('removes a pending emergency', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);

      const signed: SignedStatement = {
        statement: {
          id: 'e1', type: 'emergency', issuer: key.id,
          payload: encoder.encode('help'), issuedAt: Date.now(),
        },
        signature: new Uint8Array(64).fill(1),
      };

      await s.addPendingEmergency(signed);
      await s.removePendingEmergency('e1');
      assert.equal((await s.getPendingEmergencies()).length, 0);
    });

    it('gets a specific pending emergency by id', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);

      const signed: SignedStatement = {
        statement: {
          id: 'e1', type: 'emergency', issuer: key.id,
          payload: encoder.encode('help'), issuedAt: Date.now(),
        },
        signature: new Uint8Array(64).fill(1),
      };

      await s.addPendingEmergency(signed);
      const got = await s.getPendingEmergency('e1');
      assert.ok(got);
      assert.equal(got!.statement.id, 'e1');

      assert.equal(await s.getPendingEmergency('nonexistent'), null);
    });
  });

  describe('getDelegation by id', () => {
    it('returns a delegation by its id', async () => {
      const s = createMemoryTrustStore();
      const [issuer, delegate] = createKeys(2);
      const d: Delegation = {
        id: 'd1', issuer: issuer.id, delegate: delegate.id,
        scope: ['announce'], issuedAt: Date.now(), statementId: 's1',
      };
      await s.addDelegation(d);
      const got = await s.getDelegation('d1');
      assert.ok(got);
      assert.equal(got!.id, 'd1');
    });

    it('returns null for non-existent id', async () => {
      const s = createMemoryTrustStore();
      assert.equal(await s.getDelegation('nonexistent'), null);
    });
  });

  describe('getRevocation by id', () => {
    it('returns a revocation by its id', async () => {
      const s = createMemoryTrustStore();
      const [issuer, target] = createKeys(2);
      await s.addRevocation({
        id: 'r1', issuer: issuer.id, target: target.id,
        reason: 'test', issuedAt: Date.now(), statementId: 's1',
      });
      const got = await s.getRevocation('r1');
      assert.ok(got);
      assert.equal(got!.id, 'r1');
    });

    it('returns null for non-existent id', async () => {
      const s = createMemoryTrustStore();
      assert.equal(await s.getRevocation('nonexistent'), null);
    });
  });

  describe('removeRevocation', () => {
    it('removes a revocation', async () => {
      const s = createMemoryTrustStore();
      const [issuer, target] = createKeys(2);
      await s.addRevocation({
        id: 'r1', issuer: issuer.id, target: target.id,
        reason: 'test', issuedAt: Date.now(), statementId: 's1',
      });
      await s.removeRevocation('r1');
      assert.equal(await s.getRevocation('r1'), null);
    });

    it('is a no-op for non-existent id', async () => {
      const s = createMemoryTrustStore();
      await s.removeRevocation('nonexistent');
      // Should not throw
    });
  });

  describe('removeEntity non-existent', () => {
    it('is a no-op for non-existent id', async () => {
      const s = createMemoryTrustStore();
      await s.removeEntity('nonexistent');
      // Should not throw
    });
  });

  describe('removeDelegation non-existent', () => {
    it('is a no-op for non-existent id', async () => {
      const s = createMemoryTrustStore();
      await s.removeDelegation('nonexistent');
      // Should not throw
    });
  });

  describe('empty collection queries', () => {
    it('returns empty arrays from all query methods on empty store', async () => {
      const s = createMemoryTrustStore();
      assert.deepEqual(await s.listEntities(), []);
      assert.deepEqual(await s.listEntitiesByKind('root'), []);
      assert.deepEqual(await s.listDelegations(), []);
      assert.deepEqual(await s.listRevocations(), []);
      assert.deepEqual(await s.getPendingEmergencies(), []);
      assert.deepEqual(await s.getDelegationsForDelegate('nonexistent'), []);
      assert.deepEqual(await s.getDelegationsByIssuer('nonexistent'), []);
      assert.deepEqual(await s.getRevocationsForTarget('nonexistent'), []);
      assert.deepEqual(await s.getValidationsForStatement('nonexistent'), []);
    });
  });

  describe('cleanup on entity removal', () => {
    it('removes revocations targeting the removed entity', async () => {
      const s = createMemoryTrustStore();
      const [issuer, target] = createKeys(2);
      await s.addEntity({ id: target.id, publicKey: target.publicKey, name: 'T', trustKind: 'none', addedAt: Date.now(), metadata: {} });
      await s.addRevocation({
        id: 'r1', issuer: issuer.id, target: target.id,
        reason: 'test', issuedAt: Date.now(), statementId: 's1',
      });
      await s.removeEntity(target.id);
      assert.equal((await s.listRevocations()).length, 0);
    });

    it('removes pending emergencies from the removed entity', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);
      await s.addEntity({ id: key.id, publicKey: key.publicKey, name: 'E', trustKind: 'none', addedAt: Date.now(), metadata: {} });
      const signed: SignedStatement = {
        statement: {
          id: 'em1', type: 'emergency', issuer: key.id,
          payload: encoder.encode('help'), issuedAt: Date.now(),
        },
        signature: new Uint8Array(64).fill(1),
      };
      await s.addPendingEmergency(signed);
      await s.removeEntity(key.id);
      assert.equal((await s.getPendingEmergencies()).length, 0);
    });
  });

  describe('cleanup on delegation removal', () => {
    it('removes validations keyed by the delegation statement ID', async () => {
      const s = createMemoryTrustStore();
      const [issuer, delegate] = createKeys(2);
      await s.addDelegation({
        id: 'd1', issuer: issuer.id, delegate: delegate.id,
        scope: ['announce'], issuedAt: Date.now(), statementId: 'stmt1',
      });
      await s.addValidation({ statementId: 'stmt1', validator: issuer.id, validatedAt: Date.now(), signature: new Uint8Array(64) });
      await s.removeDelegation('d1');
      assert.equal((await s.getValidationsForStatement('stmt1')).length, 0);
    });
  });

  describe('mutation safety', () => {
    it('returned delegations are not affected by external mutation', async () => {
      const s = createMemoryTrustStore();
      const [issuer, delegate] = createKeys(2);
      await s.addDelegation({
        id: 'd1', issuer: issuer.id, delegate: delegate.id,
        scope: ['announce'], issuedAt: Date.now(), statementId: 's1',
      });
      const got = (await s.getDelegationsForDelegate(delegate.id))[0];
      got.scope.push('certify');
      const got2 = (await s.getDelegationsForDelegate(delegate.id))[0];
      assert.equal(got2.scope.length, 1); // unchanged
    });

    it('added entity is not affected by external mutation after add', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);
      const entity: Entity = {
        id: key.id, publicKey: key.publicKey, name: 'Test',
        trustKind: 'none', addedAt: Date.now(), metadata: {},
      };
      await s.addEntity(entity);
      entity.name = 'Mutated';
      const got = await s.getEntity(key.id);
      assert.equal(got!.name, 'Test');
    });
  });

  describe('clearAll', () => {
    it('removes all data from the store', async () => {
      const s = createMemoryTrustStore();
      const [key] = createKeys(1);
      await s.addEntity({ id: key.id, publicKey: key.publicKey, name: 'Test', trustKind: 'none', addedAt: Date.now(), metadata: {} });
      await s.addDelegation({ id: 'd1', issuer: key.id, delegate: 'other', scope: ['announce'], issuedAt: Date.now(), statementId: 's1' });
      await s.addRevocation({ id: 'r1', issuer: key.id, target: 'other', reason: 'x', issuedAt: Date.now(), statementId: 's1' });

      await s.clearAll();

      assert.equal((await s.listEntities()).length, 0);
      assert.equal((await s.listDelegations()).length, 0);
      assert.equal((await s.listRevocations()).length, 0);
    });
  });

  describe('isPersistent', () => {
    it('returns false for memory store', () => {
      const s = createMemoryTrustStore();
      assert.equal(s.isPersistent(), false);
    });
  });
});
