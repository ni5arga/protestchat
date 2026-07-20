/**
 * Trust engine tests.
 *
 * Tests every function individually, plus end-to-end pipelines:
 *   - Delegation chain: root → intermediate → leaf
 *   - Revocation lifecycle
 *   - Emergency message validation
 *   - Trust chain resolution
 *   - Scope checking
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ed25519 } from '@noble/curves/ed25519.js';

import { TrustEngine } from '../engine';
import { createMemoryTrustStore } from '../store';
import type { TrustStore } from '../store';
import {
  serializeStatement,
  hashStatement,
} from '../types';
import type { Statement, StatementType, SignedStatement, Scope } from '../types';
import { createKeys, type TestKeyPair } from './fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngine(store?: TrustStore): TrustEngine {
  return new TrustEngine(store ?? createMemoryTrustStore());
}

/**
 * Sign a statement with the given key pair.
 */
function sign(
  key: TestKeyPair,
  type: Statement['type'],
  payload: Uint8Array,
  expiresAt?: number,
): SignedStatement {
  // We need the engine to sign, but we can also do it directly
  const stmt: Statement = {
    id: '',
    type,
    issuer: key.id,
    payload,
    issuedAt: Date.now(),
    expiresAt,
  };
  stmt.id = hashStatement(stmt);
  const serialized = serializeStatement(stmt);
  const signature = ed25519.sign(serialized, key.secretKey);
  return { statement: stmt, signature };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrustEngine', () => {
  describe('entity management', () => {
    it('subscribes a root entity', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);

      const entity = await e.subscribe(root.publicKey, 'Coordinating Committee', 'root');

      assert.equal(entity.id, root.id);
      assert.equal(entity.name, 'Coordinating Committee');
      assert.equal(entity.trustKind, 'root');
      assert.ok(entity.addedAt > 0);
    });

    it('gets an entity by id', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Test Root', 'root');

      const found = await e.getEntity(root.id);
      assert.ok(found);
      assert.equal(found!.name, 'Test Root');
    });

    it('returns null for unknown entity', async () => {
      const e = makeEngine();
      const [unknown] = createKeys(99);
      assert.equal(await e.getEntity(unknown.id), null);
    });

    it('lists entities filtered by trust kind', async () => {
      const e = makeEngine();
      const [a, b, c] = createKeys(3);
      await e.subscribe(a.publicKey, 'Root', 'root');
      await e.subscribe(b.publicKey, 'Direct', 'direct');
      await e.subscribe(c.publicKey, 'None', 'none');

      const roots = await e.listEntities('root');
      assert.equal(roots.length, 1);
      assert.equal(roots[0].id, a.id);

      const directs = await e.listEntities('direct');
      assert.equal(directs.length, 1);
      assert.equal(directs[0].id, b.id);
    });

    it('lists all entities', async () => {
      const e = makeEngine();
      const [a, b] = createKeys(2);
      await e.subscribe(a.publicKey, 'A', 'root');
      await e.subscribe(b.publicKey, 'B', 'direct');

      const all = await e.listEntities();
      assert.equal(all.length, 2);
    });

    it('unsubscribes an entity', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Root', 'root');
      assert.ok(await e.getEntity(root.id));

      await e.unsubscribe(root.id);
      assert.equal(await e.getEntity(root.id), null);
    });

    it('upgrades trust kind on re-subscribe', async () => {
      const e = makeEngine();
      const [key] = createKeys(1);
      await e.subscribe(key.publicKey, 'Start', 'direct');
      await e.subscribe(key.publicKey, 'Upgraded', 'root');

      const entity = await e.getEntity(key.id);
      assert.equal(entity!.trustKind, 'root');
      assert.equal(entity!.name, 'Upgraded');
    });

    it('does not downgrade trust kind on re-subscribe', async () => {
      const e = makeEngine();
      const [key] = createKeys(1);
      await e.subscribe(key.publicKey, 'Root', 'root');
      await e.subscribe(key.publicKey, 'Try downgrade', 'none');

      const entity = await e.getEntity(key.id);
      assert.equal(entity!.trustKind, 'root');
    });

    it('ensures an entity exists with none trust', async () => {
      const e = makeEngine();
      const [key] = createKeys(1);

      const entity = await e.ensureEntity(key.publicKey);
      assert.equal(entity.id, key.id);
      assert.equal(entity.trustKind, 'none');

      // Second call returns the same entity
      const again = await e.ensureEntity(key.publicKey);
      assert.equal(again.id, key.id);
      assert.equal(again.trustKind, 'none');
    });
  });

  describe('statement verification', () => {
    it('rejects a statement with an invalid signature', async () => {
      const e = makeEngine();
      const [alice, bob] = createKeys(2);
      await e.subscribe(alice.publicKey, 'Alice', 'root');

      // Sign with Bob's key but claim Alice as issuer
      const stmt: Statement = {
        id: '',
        type: 'text',
        issuer: alice.id,
        payload: new TextEncoder().encode('hello'),
        issuedAt: Date.now(),
      };
      stmt.id = hashStatement(stmt);
      const serialized = serializeStatement(stmt);
      const badSig = ed25519.sign(serialized, bob.secretKey);

      const result = await e.verify({ statement: stmt, signature: badSig });
      assert.equal(result.status, 'untrusted');
      assert.ok(result.reason?.includes('signature'));
    });

    it('rejects a statement from an unknown issuer', async () => {
      const e = makeEngine();
      const [alice] = createKeys(1);
      const signed = sign(alice, 'text', new TextEncoder().encode('hello'));

      const result = await e.verify(signed);
      assert.equal(result.status, 'unknown-issuer');
    });

    it('rejects an expired statement', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Root', 'root');

      const signed = sign(root, 'text', new TextEncoder().encode('too late'), Date.now() - 1000);

      const result = await e.verify(signed);
      assert.equal(result.status, 'expired');
    });

    it('rejects a statement from a revoked entity', async () => {
      const e = makeEngine();
      const [root, target] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(target.publicKey, 'Target', 'direct');

      // Revoke target
      const revokePayload = new TextEncoder().encode(
        JSON.stringify({ target: target.id, reason: 'compromised' }),
      );
      const revokedSigned = sign(root, 'revocation', revokePayload);
      const revResult = await e.verify(revokedSigned);
      assert.equal(revResult.status, 'trusted', 'Revocation must be accepted');

      // Now target's message should be revoked
      const signed = sign(target, 'text', new TextEncoder().encode('hello'));
      const result = await e.verify(signed);
      assert.equal(result.status, 'revoked');
    });
  });

  describe('trust chain resolution', () => {
    it('root entity has all scopes implicitly', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Root', 'root');

      const chain = await e.getTrustChain(root.id, 'certify');
      assert.ok(chain);
      assert.equal(chain!.length, 1);
      assert.equal(chain![0].id, root.id);

      assert.ok(await e.isAuthorized(root.id, 'certify'));
      assert.ok(await e.isAuthorized(root.id, 'announce'));
      assert.ok(await e.isAuthorized(root.id, 'validate'));
    });

    it('resolves a two-level delegation chain', async () => {
      const e = makeEngine();
      const [root, intermediate, leaf] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(leaf.publicKey, 'Leaf', 'none');

      // Root delegates certify to intermediate
      const delegation1 = await e.delegate(
        root.secretKey, root.id, intermediate.publicKey, ['certify'],
      );
      await e.verify(delegation1);

      // Intermediate delegates announce to leaf
      const delegation2 = await e.delegate(
        intermediate.secretKey, intermediate.id, leaf.publicKey, ['announce'],
      );
      await e.verify(delegation2);

      // Verify the chain
      const chain = await e.getTrustChain(leaf.id, 'announce');
      assert.ok(chain, 'trust chain should exist');
      assert.equal(chain!.length, 3); // leaf → intermediate → root
      assert.equal(chain![0].id, leaf.id);
      assert.equal(chain![1].id, intermediate.id);
      assert.equal(chain![2].id, root.id);
      assert.equal(chain![2].trustKind, 'root');
    });

    it('resolves a three-level delegation chain', async () => {
      const e = makeEngine();
      const [r, a, b, c] = createKeys(4);
      await e.subscribe(r.publicKey, 'Root', 'root');
      await e.subscribe(c.publicKey, 'Leaf', 'none');

      // Root → A (certify)
      await e.verify(await e.delegate(r.secretKey, r.id, a.publicKey, ['certify']));
      // A → B (certify)
      await e.verify(await e.delegate(a.secretKey, a.id, b.publicKey, ['certify']));
      // B → C (announce)
      await e.verify(await e.delegate(b.secretKey, b.id, c.publicKey, ['announce']));

      const chain = await e.getTrustChain(c.id, 'announce');
      assert.ok(chain);
      assert.equal(chain!.length, 4);
      assert.equal(chain![3].id, r.id);
    });

    it('returns null for entity with no delegation chain', async () => {
      const e = makeEngine();
      const [root, leaf] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(leaf.publicKey, 'Leaf', 'none');

      // Leaf has no delegation at all
      const chain = await e.getTrustChain(leaf.id, 'announce');
      assert.equal(chain, null);
    });

    it('returns null for a chain where scope is missing', async () => {
      const e = makeEngine();
      const [root, intermediate, leaf] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(leaf.publicKey, 'Leaf', 'none');

      // Root delegates to intermediate but only 'announce' (not 'certify')
      await e.verify(await e.delegate(root.secretKey, root.id, intermediate.publicKey, ['announce']));
      // Intermediate delegates to leaf — this should fail because intermediate
      // doesn't have 'certify'
      const delegation = await e.delegate(
        intermediate.secretKey, intermediate.id, leaf.publicKey, ['announce'],
      );
      const result = await e.verify(delegation);
      assert.equal(result.status, 'untrusted');
      assert.ok(result.reason?.includes('certify'));
    });

    it('fails chain for entity with only direct trust', async () => {
      const e = makeEngine();
      const [contact] = createKeys(1);
      await e.subscribe(contact.publicKey, 'Contact', 'direct');

      const chain = await e.getTrustChain(contact.id, 'announce');
      assert.equal(chain, null);
    });

    it('detects pure cycles (no root in any path)', async () => {
      const store = createMemoryTrustStore();
      const [a, b, c] = createKeys(3);

      // Create a pure cycle: A -> B -> C -> A (delegated, no root)
      for (const key of [a, b, c]) {
        await store.addEntity({
          id: key.id, publicKey: key.publicKey, name: 'node',
          trustKind: 'delegated', addedAt: Date.now(), metadata: {},
        });
      }
      await store.addDelegation({ id: 'ab', issuer: a.id, delegate: b.id, scope: ['certify'], issuedAt: Date.now(), statementId: 's1' });
      await store.addDelegation({ id: 'bc', issuer: b.id, delegate: c.id, scope: ['certify'], issuedAt: Date.now(), statementId: 's2' });
      await store.addDelegation({ id: 'ca', issuer: c.id, delegate: a.id, scope: ['certify'], issuedAt: Date.now(), statementId: 's3' });

      const eng = new TrustEngine(store);
      assert.equal(await eng.getTrustChain(a.id, 'certify'), null);
      assert.equal(await eng.getTrustChain(b.id, 'certify'), null);
      assert.equal(await eng.getTrustChain(c.id, 'certify'), null);
    });
  });

  describe('delegation', () => {
    it('accepts a delegation from a root entity', async () => {
      const e = makeEngine();
      const [root, delegate] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');

      const signed = await e.delegate(root.secretKey, root.id, delegate.publicKey, ['announce']);
      const result = await e.verify(signed);

      assert.equal(result.status, 'trusted');
      assert.ok(result.reason?.includes('Delegation accepted'));
    });

    it('rejects a delegation from an entity without certify scope', async () => {
      const e = makeEngine();
      const [a, b] = createKeys(2);
      await e.subscribe(a.publicKey, 'A', 'direct');
      await e.subscribe(b.publicKey, 'B', 'none');

      const signed = await e.delegate(a.secretKey, a.id, b.publicKey, ['announce']);
      const result = await e.verify(signed);

      assert.equal(result.status, 'untrusted');
      assert.ok(result.reason?.includes('certify scope'));
    });

    it('stores delegation for later chain resolution', async () => {
      const e = makeEngine();
      const [root, delegate] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');

      const signed = await e.delegate(root.secretKey, root.id, delegate.publicKey, ['announce']);
      await e.verify(signed);

      const delegations = await e.getStore().getDelegationsForDelegate(delegate.id);
      assert.equal(delegations.length, 1);
      assert.deepEqual(delegations[0].scope, ['announce']);
    });

    it('rejects delegation with invalid scope values', async () => {
      const e = makeEngine();
      const [root, delegate] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');

      // Directly sign a delegation with bad scope
      const payload = new TextEncoder().encode(
        JSON.stringify({ delegate: delegate.id, scope: ['invalid_scope'] }),
      );
      const signed = sign(root, 'delegation', payload);
      const result = await e.verify(signed);
      assert.equal(result.status, 'untrusted');
    });
  });

  describe('revocation', () => {
    it('revokes a delegation and makes the delegate untrusted', async () => {
      const e = makeEngine();
      const [root, delegate] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(delegate.publicKey, 'Delegate', 'none');

      // Delegate
      const delegation = await e.delegate(root.secretKey, root.id, delegate.publicKey, ['announce']);
      await e.verify(delegation);

      // Delegate should now have announce scope via chain
      assert.ok(await e.isAuthorized(delegate.id, 'announce'));

      // Revoke
      const revocation = await e.revoke(root.secretKey, root.id, delegate.id, 'no longer needed');
      const revResult = await e.verify(revocation);
      assert.equal(revResult.status, 'trusted');

      // Delegate should no longer have announce scope
      assert.equal(await e.isAuthorized(delegate.id, 'announce'), false);
      assert.ok(await e.isRevoked(delegate.id));
    });

    it('allows a delegator with certify scope to revoke their own delegation', async () => {
      const e = makeEngine();
      const [root, middle, leaf] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(middle.publicKey, 'Middle', 'none');
      await e.subscribe(leaf.publicKey, 'Leaf', 'none');

      // Root → Middle (certify)
      await e.verify(await e.delegate(root.secretKey, root.id, middle.publicKey, ['certify']));
      // Middle → Leaf (announce)
      await e.verify(await e.delegate(middle.secretKey, middle.id, leaf.publicKey, ['announce']));

      // Middle (original delegator) revokes Leaf — should work even without root-level certify
      // because Middle IS the original delegator
      const revocation = await e.revoke(middle.secretKey, middle.id, leaf.id, 'unreliable');
      const result = await e.verify(revocation);
      assert.equal(result.status, 'trusted');
    });

    it('rejects revocation from an unrelated entity', async () => {
      const e = makeEngine();
      const [root, delegate, stranger] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(delegate.publicKey, 'Delegate', 'none');
      await e.subscribe(stranger.publicKey, 'Stranger', 'none');

      // Root delegates to delegate
      await e.verify(await e.delegate(root.secretKey, root.id, delegate.publicKey, ['announce']));

      // Stranger tries to revoke delegate — should fail
      const revocation = await e.revoke(stranger.secretKey, stranger.id, delegate.id, 'hack');
      const result = await e.verify(revocation);
      assert.equal(result.status, 'untrusted');
    });
  });

  describe('announcements', () => {
    it('marks an announcement as trusted from an entity with announce scope', async () => {
      const e = makeEngine();
      const [root, announcer] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');

      // Root delegates announce to announcer
      await e.verify(await e.delegate(root.secretKey, root.id, announcer.publicKey, ['announce']));

      // Announcer signs an announcement
      const signed = sign(announcer, 'announcement', new TextEncoder().encode('meeting at 6pm'));
      const result = await e.verify(signed);

      assert.equal(result.status, 'trusted');
      assert.ok(result.trustChain);
      assert.equal(result.trustChain!.length, 2); // announcer → root
    });

    it('marks an announcement as known from a direct entity', async () => {
      const e = makeEngine();
      const [contact] = createKeys(1);
      await e.subscribe(contact.publicKey, 'Contact', 'direct');

      const signed = sign(contact, 'announcement', new TextEncoder().encode('hello'));
      const result = await e.verify(signed);

      assert.equal(result.status, 'known');
    });

    it('marks an announcement as untrusted from an unknown entity', async () => {
      const e = makeEngine();
      const [stranger] = createKeys(1);
      await e.subscribe(stranger.publicKey, 'Stranger', 'none');

      const signed = sign(stranger, 'announcement', new TextEncoder().encode('fake news'));
      const result = await e.verify(signed);

      assert.equal(result.status, 'untrusted');
    });
  });

  describe('text messages', () => {
    it('marks text as trusted from an entity with announce scope', async () => {
      const e = makeEngine();
      const [root, announcer] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.verify(await e.delegate(root.secretKey, root.id, announcer.publicKey, ['announce']));

      const signed = sign(announcer, 'text', new TextEncoder().encode('go to gate 4'));
      const result = await e.verify(signed);
      assert.equal(result.status, 'trusted');
    });

    it('marks text as known from a direct contact', async () => {
      const e = makeEngine();
      const [contact] = createKeys(1);
      await e.subscribe(contact.publicKey, 'Friend', 'direct');

      const signed = sign(contact, 'text', new TextEncoder().encode('meet me'));
      const result = await e.verify(signed);
      assert.equal(result.status, 'known');
    });

    it('marks text as untrusted from a stranger with none trust', async () => {
      const e = makeEngine();
      const [stranger] = createKeys(1);
      await e.subscribe(stranger.publicKey, 'Stranger', 'none');

      const signed = sign(stranger, 'text', new TextEncoder().encode('spam'));
      const result = await e.verify(signed);
      assert.equal(result.status, 'untrusted');
    });
  });

  describe('emergency messages', () => {
    it('accepts an emergency as pending from any entity', async () => {
      const e = makeEngine();
      const [anyone] = createKeys(1);
      await e.subscribe(anyone.publicKey, 'Anyone', 'none');

      const signed = sign(anyone, 'emergency', new TextEncoder().encode('tear gas at gate 3'));
      const result = await e.verify(signed);

      assert.equal(result.status, 'pending-emergency');
    });

    it('upgrades to verified-emergency when threshold is met', async () => {
      const e = makeEngine();
      const [root, v1, v2, v3, sender] = createKeys(5);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(sender.publicKey, 'Sender', 'none');

      // Grant validate scope to v1, v2, v3
      for (const v of [v1, v2, v3]) {
        await e.verify(await e.delegate(root.secretKey, root.id, v.publicKey, ['validate']));
      }

      // Emergency from anyone
      const emergency = sign(sender, 'emergency', new TextEncoder().encode('fire'));
      const firstResult = await e.verify(emergency);
      assert.equal(firstResult.status, 'pending-emergency');

      // Three validators validate
      for (const v of [v1, v2, v3]) {
        const result = await e.validateEmergency(v.secretKey, v.id, emergency.statement.id);
        assert.notEqual(result.status, 'untrusted', 'validator should be able to validate');
        // After third validation, should be verified
      }

      // Re-verify to get updated status
      const finalResult = await e.verify(emergency);
      assert.equal(finalResult.status, 'verified-emergency');
    });

    it('rejects validation from an entity without validate scope', async () => {
      const e = makeEngine();
      const [root, sender, nonValidator] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(sender.publicKey, 'Sender', 'none');
      await e.subscribe(nonValidator.publicKey, 'Normal', 'direct');

      const emergency = sign(sender, 'emergency', new TextEncoder().encode('help'));
      await e.verify(emergency);

      const result = await e.validateEmergency(nonValidator.secretKey, nonValidator.id, emergency.statement.id);
      assert.equal(result.status, 'untrusted');
      assert.ok(result.reason?.includes('validate scope'));
    });

    it('checks pending emergencies against a threshold', async () => {
      const e = makeEngine();
      const [root, v1, v2, sender] = createKeys(4);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(sender.publicKey, 'Sender', 'none');
      await e.verify(await e.delegate(root.secretKey, root.id, v1.publicKey, ['validate']));
      await e.verify(await e.delegate(root.secretKey, root.id, v2.publicKey, ['validate']));

      const emergency = sign(sender, 'emergency', new TextEncoder().encode('flood'));
      await e.verify(emergency);

      // Only 2 validations with threshold 3
      await e.validateEmergency(v1.secretKey, v1.id, emergency.statement.id);
      await e.validateEmergency(v2.secretKey, v2.id, emergency.statement.id);

      const status = await e.getEmergencyStatus(emergency.statement.id, 3);
      assert.equal(status.met, false);
      assert.equal(status.count, 2);

      // Check with threshold 2 — should be met
      const status2 = await e.getEmergencyStatus(emergency.statement.id, 2);
      assert.equal(status2.met, true);
    });

    it('lists pending emergencies', async () => {
      const e = makeEngine();
      const [anyone] = createKeys(1);
      await e.subscribe(anyone.publicKey, 'Anyone', 'none');

      const e1 = sign(anyone, 'emergency', new TextEncoder().encode('first'));
      const e2 = sign(anyone, 'emergency', new TextEncoder().encode('second'));
      await e.verify(e1);
      await e.verify(e2);

      const pending = await e.getPendingEmergencies();
      assert.equal(pending.length, 2);
    });

    it('re-checks pending emergencies against threshold', async () => {
      const e = makeEngine();
      const [root, v1, v2, v3, sender] = createKeys(5);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(sender.publicKey, 'Sender', 'none');
      for (const v of [v1, v2, v3]) {
        await e.verify(await e.delegate(root.secretKey, root.id, v.publicKey, ['validate']));
      }

      const emergency = sign(sender, 'emergency', new TextEncoder().encode('danger'));
      await e.verify(emergency);

      // Validate one
      await e.validateEmergency(v1.secretKey, v1.id, emergency.statement.id);

      // Check with threshold 1
      const verified = await e.checkPendingEmergencies(1);
      assert.equal(verified.length, 1);
      assert.equal(verified[0].statement.id, emergency.statement.id);

      // Should no longer be pending
      const pending = await e.getPendingEmergencies();
      assert.equal(pending.length, 0);
    });
  });

  describe('sign and verify round-trip', () => {
    it('signs and verifies a text statement', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Root', 'root');

      const payload = new TextEncoder().encode('hello world');
      const signed = await e.sign(root.secretKey, 'text', payload, root.id);
      assert.ok(signed.signature.length > 0);

      const result = await e.verify(signed);
      assert.equal(result.status, 'trusted');
    });

    it('signs and verifies via verifyExternal', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Root', 'root');

      const pk = root.secretKey;
      const payload = new TextEncoder().encode('external');
      const now = Date.now();

      // Manually create what verifyExternal expects
      const { serializeStatement, hashStatement } = await import('../types');
      const stmt: Statement = {
        id: '',
        type: 'text',
        issuer: root.id,
        payload,
        issuedAt: now,
      };
      stmt.id = hashStatement(stmt);
      const serialized = serializeStatement(stmt);
      const signature = ed25519.sign(serialized, pk);

      const result = await e.verifyExternal('text', root.id, payload, now, signature);
      assert.equal(result.status, 'trusted');
    });
  });

  describe('statement ID integrity', () => {
    it('overwrites a forged statement ID with the computed value', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Root', 'root');

      // Create a statement with a deliberately wrong ID
      const payload = new TextEncoder().encode('hello');
      const stmt: Statement = {
        id: 'forged-id-that-is-wrong',
        type: 'text',
        issuer: root.id,
        payload,
        issuedAt: Date.now(),
      };
      const realId = hashStatement(stmt);
      const serialized = serializeStatement(stmt);
      const signature = ed25519.sign(serialized, root.secretKey);

      const signed: SignedStatement = { statement: stmt, signature };
      const result = await e.verify(signed);
      assert.equal(result.status, 'trusted');
      // The ID should now be the real computed one, not the forged one
      assert.notEqual(signed.statement.id, 'forged-id-that-is-wrong');
      assert.equal(signed.statement.id, realId);
    });
  });

  describe('revocation scope', () => {
    it('root with certify scope can revoke any delegation (broad authority)', async () => {
      const e = makeEngine();
      const [root, delegator, target] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(target.publicKey, 'Target', 'none');

      // Root delegates certify to delegator
      await e.verify(await e.delegate(root.secretKey, root.id, delegator.publicKey, ['certify']));
      // Delegator delegates announce to target
      await e.verify(await e.delegate(delegator.secretKey, delegator.id, target.publicKey, ['announce']));

      // Root revokes target using certify scope (case A)
      const revokeResult = await e.verify(
        await e.revoke(root.secretKey, root.id, target.id, 'clean sweep')
      );
      assert.equal(revokeResult.status, 'trusted');
      assert.ok(await e.isRevoked(target.id));
      assert.equal((await e.getStore().getDelegationsForDelegate(target.id)).length, 0);
    });

    it('certify scope removes ALL delegations for the target', async () => {
      const e = makeEngine();
      const [root, delegator, target] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(target.publicKey, 'Target', 'none');

      // Root delegates certify to delegator
      await e.verify(await e.delegate(root.secretKey, root.id, delegator.publicKey, ['certify']));

      // Delegator delegates announce to target
      await e.verify(await e.delegate(delegator.secretKey, delegator.id, target.publicKey, ['announce']));

      // Root (has certify scope) revokes target — removes ALL delegations
      const revResult = await e.verify(
        await e.revoke(root.secretKey, root.id, target.id, 'clean sweep')
      );
      assert.equal(revResult.status, 'trusted');
      assert.equal((await e.getStore().getDelegationsForDelegate(target.id)).length, 0);
    });
  });

  describe('trust chain with revocation', () => {
    it('returns null when a revoked entity is queried directly', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Root', 'root');

      // Revoke root
      // Root can't self-revoke through normal API, so add directly to store
      await e.getStore().addRevocation({
        id: 'r1', issuer: 'someone', target: root.id,
        reason: 'compromised', issuedAt: Date.now(), statementId: 's1',
      });

      // Root being revoked should make chain fail even though root has all scopes
      const chain = await e.getTrustChain(root.id, 'certify');
      assert.equal(chain, null);
    });

    it('returns null when an intermediate entity is revoked', async () => {
      const e = makeEngine();
      const [root, mid, leaf] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(leaf.publicKey, 'Leaf', 'none');

      await e.verify(await e.delegate(root.secretKey, root.id, mid.publicKey, ['certify']));
      await e.verify(await e.delegate(mid.secretKey, mid.id, leaf.publicKey, ['announce']));

      // Chain works
      assert.ok(await e.getTrustChain(leaf.id, 'announce'));

      // Revoke mid
      await e.verify(await e.revoke(root.secretKey, root.id, mid.id, 'compromised'));

      // Chain should now fail because mid is revoked
      assert.equal(await e.getTrustChain(leaf.id, 'announce'), null);
    });
  });

  describe('chain depth boundary', () => {
    it('succeeds with MAX_CHAIN_DEPTH levels', async () => {
      const depth = 10;
      const keys = createKeys(depth + 1); // +1 for root
      const e = makeEngine();

      // keys[0] = root, keys[1..9] = intermediate, keys[10] = leaf
      await e.subscribe(keys[0].publicKey, 'Root', 'root');
      await e.subscribe(keys[depth].publicKey, 'Leaf', 'none');

      // Build chain: root → k1 → k2 → ... → k9 → leaf
      for (let i = 0; i < depth; i++) {
        const issuer = keys[i];
        const delegate = keys[i + 1];
        const scope: Scope[] = i < depth - 1 ? ['certify'] : ['announce'];
        await e.verify(await e.delegate(issuer.secretKey, issuer.id, delegate.publicKey, scope));
      }

      const chain = await e.getTrustChain(keys[depth].id, 'announce');
      assert.ok(chain, 'chain should resolve at MAX_CHAIN_DEPTH');
      assert.equal(chain!.length, depth + 1); // all nodes including root
    });
  });

  describe('unknown statement type', () => {
    it('returns untrusted for an unknown statement type', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Root', 'root');

      const payload = new TextEncoder().encode('test');
      // Create with a valid type for signing, then swap it.
      // This tests how verify() handles a mutated statement type.
      const stmt: Statement = {
        id: '',
        type: 'text',
        issuer: root.id,
        payload,
        issuedAt: Date.now(),
      };
      stmt.id = hashStatement(stmt);
      const serialized = serializeStatement(stmt);
      const signature = ed25519.sign(serialized, root.secretKey);
      // Swap the type after signing to simulate a malformed statement
      stmt.type = 'unknown_type' as unknown as StatementType;

      const result = await e.verify({ statement: stmt, signature });
      assert.equal(result.status, 'untrusted');
      assert.ok(result.reason?.includes('Cannot serialize'));
    });
  });

  describe('delegated without announce scope returns known', () => {
    it('text from a delegated entity without announce scope is known', async () => {
      const e = makeEngine();
      const [root, deleg, leaf] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(leaf.publicKey, 'Leaf', 'none');

      // Root delegates to 'deleg' with only 'validate' scope (not 'announce')
      await e.verify(await e.delegate(root.secretKey, root.id, deleg.publicKey, ['validate']));

      // Deleg sends a text message
      const signed = await e.sign(deleg.secretKey, 'text', new TextEncoder().encode('hello'), deleg.id);
      const result = await e.verify(signed);
      // Deleg is in the store (auto-ensured) with trustKind='delegated' but no announce chain
      assert.equal(result.status, 'known');
    });
  });

  describe('ensureDelegatedEntity does not upgrade direct', () => {
    it('keeps a direct entity as direct when a delegation targets them', async () => {
      const e = makeEngine();
      const [root, contact] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(contact.publicKey, 'Contact', 'direct');

      // Root tries to delegate to contact — contact should stay 'direct'
      const del = await e.delegate(root.secretKey, root.id, contact.publicKey, ['validate']);
      await e.verify(del);

      const entity = await e.getEntity(contact.id);
      assert.equal(entity!.trustKind, 'direct');
    });
  });

  describe('verifyEmergency with pre-existing validations', () => {
    it('returns verified-emergency when threshold is already met', async () => {
      const e = makeEngine();
      const [root, v1, v2, v3, sender] = createKeys(5);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(sender.publicKey, 'Sender', 'none');
      for (const v of [v1, v2, v3]) {
        await e.verify(await e.delegate(root.secretKey, root.id, v.publicKey, ['validate']));
      }

      // Create emergency, verify once to get it pending
      const emergency = await e.sign(sender.secretKey, 'emergency', new TextEncoder().encode('fire'), sender.id);
      await e.verify(emergency);

      // Validate by all three
      for (const v of [v1, v2, v3]) {
        await e.validateEmergency(v.secretKey, v.id, emergency.statement.id);
      }

      // Re-verify — should be already verified
      const result = await e.verify(emergency);
      assert.equal(result.status, 'verified-emergency');
    });
  });

  describe('revocation test asserts verify result', () => {
    it('asserts the revocation itself is trusted', async () => {
      const e = makeEngine();
      const [root, target] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');

      const revokeSigned = await e.revoke(root.secretKey, root.id, target.id, 'test');
      const revResult = await e.verify(revokeSigned);
      assert.equal(revResult.status, 'trusted', 'Revocation statement must be verified as trusted');
    });
  });

  describe('subscribe with invalid public key', () => {
    it('throws when given a key of wrong length', async () => {
      const e = makeEngine();
      await assert.rejects(
        () => e.subscribe(new Uint8Array(16), 'Bad', 'none'),
        /must be 32 bytes/,
      );
    });
  });

  describe('subscribeRoot and addContact', () => {
    it('subscribeRoot creates a root entity', async () => {
      const e = makeEngine();
      const [key] = createKeys(1);
      const entity = await e.subscribeRoot(key.publicKey, 'Committee');
      assert.equal(entity.trustKind, 'root');
    });

    it('addContact creates a direct entity', async () => {
      const e = makeEngine();
      const [key] = createKeys(1);
      const entity = await e.addContact(key.publicKey, 'Alice');
      assert.equal(entity.trustKind, 'direct');
    });
  });

  describe('listSubscribed', () => {
    it('returns only root and direct entities', async () => {
      const e = makeEngine();
      const [r, d, del, n] = createKeys(4);
      await e.subscribeRoot(r.publicKey, 'Root');
      await e.addContact(d.publicKey, 'Direct');
      await e.subscribe(del.publicKey, 'Delegated', 'delegated');
      await e.subscribe(n.publicKey, 'None', 'none');

      const subscribed = await e.listSubscribed();
      assert.equal(subscribed.length, 2);
      const kinds = subscribed.map((e) => e.trustKind).sort();
      assert.deepEqual(kinds, ['direct', 'root']);
    });
  });

  describe('ensureEntity then subscribe upgrade', () => {
    it('upgrades from none to root', async () => {
      const e = makeEngine();
      const [key] = createKeys(1);

      const auto = await e.ensureEntity(key.publicKey);
      assert.equal(auto.trustKind, 'none');

      const upgraded = await e.subscribe(key.publicKey, 'Now Root', 'root');
      assert.equal(upgraded.trustKind, 'root');
      assert.equal(upgraded.name, 'Now Root');
    });

    it('subscribe does not downgrade an existing root', async () => {
      const e = makeEngine();
      const [key] = createKeys(1);

      await e.subscribe(key.publicKey, 'Root', 'root');
      const result = await e.subscribe(key.publicKey, 'Try Downgrade', 'direct');
      assert.equal(result.trustKind, 'root');
    });
  });

  describe('validateEmergency PoP rejection', () => {
    it('throws when validator secret does not match validatorId', async () => {
      const e = makeEngine();
      const [root, validator, wrongKey, sender] = createKeys(4);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(sender.publicKey, 'Sender', 'none');
      await e.verify(await e.delegate(root.secretKey, root.id, validator.publicKey, ['validate']));

      const emergency = await e.sign(sender.secretKey, 'emergency', new TextEncoder().encode('help'), sender.id);
      await e.verify(emergency);

      // Call with a different secret key than the validator owns
      await assert.rejects(
        () => e.validateEmergency(wrongKey.secretKey, validator.id, emergency.statement.id),
        /does not match/,
      );
    });
  });

  describe('validateEmergency unknown statement', () => {
    it('returns untrusted without signed field for unknown id', async () => {
      const e = makeEngine();
      const [root, v] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.verify(await e.delegate(root.secretKey, root.id, v.publicKey, ['validate']));

      const result = await e.validateEmergency(v.secretKey, v.id, 'nonexistent-statement');
      assert.equal(result.status, 'untrusted');
      assert.equal(result.signed, undefined);
    });
  });

  describe('two-level delegation through verify', () => {
    it('returns trusted for message signed by two-level delegation chain', async () => {
      const e = makeEngine();
      const [root, intermediate, leaf] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(leaf.publicKey, 'Leaf', 'none');

      // Root delegates certify to intermediate
      const d1 = await e.delegate(root.secretKey, root.id, intermediate.publicKey, ['certify']);
      await e.verify(d1);

      // Intermediate delegates announce to leaf
      const d2 = await e.delegate(intermediate.secretKey, intermediate.id, leaf.publicKey, ['announce']);
      await e.verify(d2);

      // Leaf signs an announcement — verify() should return trusted
      const announcement = await e.sign(
        leaf.secretKey,
        'announcement',
        new TextEncoder().encode('rally at 6pm'),
        leaf.id,
      );
      const result = await e.verify(announcement);

      assert.equal(result.status, 'trusted');
      assert.ok(result.trustChain);
      assert.equal(result.trustChain!.length, 3); // leaf → intermediate → root
      assert.equal(result.trustChain![2].trustKind, 'root');
    });
  });

  describe('serializeStatement guard', () => {
    it('throws on unknown statement type', () => {
      const stmt: Statement = {
        id: '',
        type: 'bogus_type' as unknown as StatementType,
        issuer: 'abc',
        payload: new Uint8Array(0),
        issuedAt: 0,
      };
      assert.throws(
        () => serializeStatement(stmt),
        /Unknown statement type/,
      );
    });
  });

  describe('getTrustChain backtracking', () => {
    it('tries alternative delegation when newest path fails', async () => {
      const e = makeEngine();
      const [rootA, rootB, entity] = createKeys(3);
      await e.subscribe(rootA.publicKey, 'RootA', 'root');
      await e.subscribe(rootB.publicKey, 'RootB', 'root');
      await e.subscribe(entity.publicKey, 'Entity', 'none');

      // RootA delegates certify to entity (older)
      const delA = await e.delegate(rootA.secretKey, rootA.id, entity.publicKey, ['certify']);
      await e.verify(delA);

      // RootB delegates certify to entity (newer — will be tried first)
      const delB = await e.delegate(rootB.secretKey, rootB.id, entity.publicKey, ['certify']);
      await e.verify(delB);

      // Revoke RootB (breaks the newer chain)
      const revokeB = await e.revoke(rootA.secretKey, rootA.id, rootB.id, 'compromised');
      await e.verify(revokeB);

      // Chain should still resolve via RootA (older path)
      const chain = await e.getTrustChain(entity.id, 'certify');
      assert.ok(chain, 'should backtrack to older valid delegation');
      assert.equal(chain!.length, 2);
      assert.equal(chain![1].id, rootA.id);
    });
  });

  describe('self-delegation rejection', () => {
    it('rejects delegation where issuer equals delegate', async () => {
      const e = makeEngine();
      const [root] = createKeys(1);
      await e.subscribe(root.publicKey, 'Root', 'root');

      const delegation = await e.delegate(root.secretKey, root.id, root.publicKey, ['announce']);
      const result = await e.verify(delegation);
      assert.equal(result.status, 'untrusted');
      assert.ok(result.reason?.includes('Self-delegation'));
    });
  });

  describe('expired delegation in chain', () => {
    it('filters out expired delegations during chain resolution', async () => {
      const e = makeEngine();
      const [root, mid, leaf] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(leaf.publicKey, 'Leaf', 'none');

      // Accept the delegation chain first (valid expiry far in the future)
      const del1 = await e.delegate(root.secretKey, root.id, mid.publicKey, ['certify'], Date.now() + 86400000);
      await e.verify(del1);
      const del2 = await e.delegate(mid.secretKey, mid.id, leaf.publicKey, ['announce']);
      await e.verify(del2);

      // Chain works before expiry
      assert.ok(await e.getTrustChain(leaf.id, 'announce'));

      // Manually expire mid's delegation by modifying the store
      const delegations = await e.getStore().getDelegationsForDelegate(mid.id);
      for (const d of delegations) {
        if (d.issuer === root.id) {
          // Remove the valid delegation and re-add with past expiry
          await e.getStore().removeDelegation(d.id);
          await e.getStore().addDelegation({
            ...d,
            expiresAt: Date.now() - 1000,
          });
        }
      }

      // Chain should now fail due to expired delegation
      assert.equal(await e.getTrustChain(leaf.id, 'announce'), null);
    });
  });

  describe('validateEmergency with direct entity', () => {
    it('rejects validation from a direct entity (no validate scope)', async () => {
      const e = makeEngine();
      const [root, direct, sender] = createKeys(3);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(direct.publicKey, 'Direct', 'direct');
      await e.subscribe(sender.publicKey, 'Sender', 'none');

      const emergency = await e.sign(sender.secretKey, 'emergency', new TextEncoder().encode('help'), sender.id);
      await e.verify(emergency);

      const result = await e.validateEmergency(direct.secretKey, direct.id, emergency.statement.id);
      assert.equal(result.status, 'untrusted');
      assert.ok(result.reason?.includes('validate scope'));
    });
  });

  describe('validateEmergency with root entity', () => {
    it('allows root to validate (root has all scopes)', async () => {
      const e = makeEngine();
      const [root, sender] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(sender.publicKey, 'Sender', 'none');

      const emergency = await e.sign(sender.secretKey, 'emergency', new TextEncoder().encode('emergency'), sender.id);
      await e.verify(emergency);

      const result = await e.validateEmergency(root.secretKey, root.id, emergency.statement.id);
      assert.notEqual(result.status, 'untrusted');
    });
  });

  describe('engine.clearAll', () => {
    it('removes all entities and state', async () => {
      const e = makeEngine();
      const [root, leaf] = createKeys(2);
      await e.subscribe(root.publicKey, 'Root', 'root');
      await e.subscribe(leaf.publicKey, 'Leaf', 'none');
      await e.verify(await e.delegate(root.secretKey, root.id, leaf.publicKey, ['announce']));

      assert((await e.listEntities()).length > 0);
      await e.clearAll();
      assert.equal((await e.listEntities()).length, 0);
    });
  });
});
