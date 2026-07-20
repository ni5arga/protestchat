/**
 * TrustEngine — the core of the trust module.
 *
 * Manages entities, delegations, revocations, and emergency validations.
 * Verifies signed statements against the trust graph.
 *
 * This is the primary API surface that the rest of the app will call during
 * integration. Every incoming message goes through verify(); the result
 * determines how the message is displayed.
 */

import { ed25519 } from '@noble/curves/ed25519.js';

import type {
  KeyId,
  Entity,
  Statement,
  StatementType,
  SignedStatement,
  Delegation,
  Revocation,
  Validation,
  VerificationResult,
  VerificationStatus,
  Scope,
  TrustKind,
} from './types';
import {
  publicKeyFromKeyId,
  keyIdFromPublicKey,
  serializeStatement,
  hashSerialized,
  ALL_SCOPES,
} from './types';
import type { TrustStore } from './store';
import { createMemoryTrustStore } from './store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum depth of delegation chain we'll traverse. */
const MAX_CHAIN_DEPTH = 10;

/** Default threshold for emergency message validation. */
const DEFAULT_EMERGENCY_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// TrustEngine
// ---------------------------------------------------------------------------

export class TrustEngine {
  private store: TrustStore;

  constructor(store?: TrustStore) {
    this.store = store ?? createMemoryTrustStore();
  }

  /** Expose the store for persistence during integration. */
  getStore(): TrustStore {
    return this.store;
  }

  // -----------------------------------------------------------------------
  // Entity management
  // -----------------------------------------------------------------------

  /**
   * Subscribe to an entity. Adds them to the trust graph with the given
   * trust kind.
   *
   * `publicKey` is the raw 32-byte Ed25519 public key.
   */
  async subscribe(
    publicKey: Uint8Array,
    name: string,
    trustKind: TrustKind,
    metadata: Record<string, string> = {},
  ): Promise<Entity> {
    const id = keyIdFromPublicKey(publicKey);
    // Check if already exists — upgrade trust kind if so
    const existing = await this.store.getEntity(id);
    if (existing) {
      // Don't downgrade
      const mergedKind = trustKindPriority(existing.trustKind, trustKind);
      const updated: Entity = {
        ...existing,
        trustKind: mergedKind,
        name: name || existing.name,
        metadata: { ...existing.metadata, ...metadata },
      };
      await this.store.addEntity(updated);
      return updated;
    }

    const entity: Entity = {
      id,
      publicKey: new Uint8Array(publicKey),
      name,
      trustKind,
      addedAt: Date.now(),
      metadata,
    };
    await this.store.addEntity(entity);
    return entity;
  }

  /**
   * Unsubscribe from an entity. Removes them from the trust graph entirely
   * along with their delegations.
   */
  async unsubscribe(id: KeyId): Promise<void> {
    await this.store.removeEntity(id);
  }

  /**
   * Get an entity by their key ID.
   */
  async getEntity(id: KeyId): Promise<Entity | null> {
    return this.store.getEntity(id);
  }

  /**
   * List all entities, optionally filtered by trust kind.
   */
  async listEntities(trustKind?: TrustKind): Promise<Entity[]> {
    if (trustKind) {
      return this.store.listEntitiesByKind(trustKind);
    }
    return this.store.listEntities();
  }

  /**
   * Ensure an entity exists in the store with at minimum 'none' trust.
   * Used when we receive a message from an unknown key.
   */
  async ensureEntity(publicKey: Uint8Array): Promise<Entity> {
    const id = keyIdFromPublicKey(publicKey);
    const existing = await this.store.getEntity(id);
    if (existing) return existing;

    const entity: Entity = {
      id,
      publicKey: new Uint8Array(publicKey),
      name: shortName(id),
      trustKind: 'none',
      addedAt: Date.now(),
      metadata: {},
    };
    await this.store.addEntity(entity);
    return entity;
  }

  /**
   * Create or update an entity with 'delegated' trust from a KeyId.
   * Called when a delegation is accepted — the delegate's public key
   * is embedded in the KeyId (hex of 32-byte Ed25519 public key).
   */
  private async ensureDelegatedEntity(id: KeyId): Promise<Entity> {
    const existing = await this.store.getEntity(id);
    const publicKey = publicKeyFromKeyId(id);

    if (existing) {
      // Upgrade to delegated only if currently 'none'.
      // 'direct' entities (trusted in person) are NOT auto-upgraded —
      // that would override explicit user intent.
      if (existing.trustKind === 'none') {
        const updated: Entity = {
          ...existing,
          trustKind: 'delegated',
          publicKey,
        };
        await this.store.addEntity(updated);
        return updated;
      }
      return existing;
    }

    const entity: Entity = {
      id,
      publicKey,
      name: shortName(id),
      trustKind: 'delegated',
      addedAt: Date.now(),
      metadata: {},
    };
    await this.store.addEntity(entity);
    return entity;
  }

  // -----------------------------------------------------------------------
  // Statement signing
  // -----------------------------------------------------------------------

  /**
   * Create a signed statement.
   *
   * @param secretKey - 32-byte Ed25519 secret key (seed)
   * @param type - statement type
   * @param payload - type-specific content (opaque to the module)
   * @param issuerId - the issuer's KeyId (must match public key derived from secret)
   */
  async sign(
    secretKey: Uint8Array,
    type: StatementType,
    payload: Uint8Array,
    issuerId: KeyId,
    expiresAt?: number,
  ): Promise<SignedStatement> {
    const statement: Statement = {
      id: '', // filled after serialization
      type,
      issuer: issuerId,
      payload: new Uint8Array(payload),
      issuedAt: Date.now(),
      expiresAt,
    };
    // Serialize once: hash and signing use the same canonical bytes.
    // The statement ID is not part of the canonical encoding, so it
    // doesn't need to be set before serialization.
    const serialized = serializeStatement(statement);
    statement.id = hashSerialized(serialized);
    const signature = ed25519.sign(serialized, secretKey);

    return { statement, signature };
  }

  /**
   * Verify an externally created statement (e.g. received from another device).
   * Re-computes the statement ID and signature check.
   */
  async verifyExternal(
    type: StatementType,
    issuer: KeyId,
    payload: Uint8Array,
    issuedAt: number,
    signature: Uint8Array,
    expiresAt?: number,
  ): Promise<VerificationResult> {
    const statement: Statement = {
      id: '',
      type,
      issuer,
      payload: new Uint8Array(payload),
      issuedAt,
      expiresAt,
    };
    // ID is set by verify() — no need to compute it here
    const signed: SignedStatement = { statement, signature: new Uint8Array(signature) };
    return this.verify(signed);
  }

  /**
   * Verify a signed statement against the trust graph.
   *
   * This is the core method. Every incoming message should pass through here.
   */
  async verify(signed: SignedStatement): Promise<VerificationResult> {
    const stmt = signed.statement;
    const signature = signed.signature;

    // ---- 1. Verify Ed25519 signature ----
    let issuerKey: Uint8Array;
    try {
      issuerKey = publicKeyFromKeyId(stmt.issuer);
    } catch {
      return reject(signed, 'unknown-issuer', 'Invalid issuer key ID');
    }

    // Serialize once and reuse: sig check + hash below use the same bytes.
    const serialized = serializeStatement(stmt);
    let valid: boolean;
    try {
      valid = ed25519.verify(signature, serialized, issuerKey);
    } catch {
      return reject(signed, 'untrusted', 'Signature verification threw');
    }
    if (!valid) {
      return reject(signed, 'untrusted', 'Ed25519 signature does not match');
    }

    // ---- 2. Statement ID integrity ----
    // The ID is not part of the canonical serialization, so it can be set
    // independently. We always use our own computed ID for local indexing.
    stmt.id = hashSerialized(serialized);

    // ---- 3. Look up issuer entity ----
    const entity = await this.store.getEntity(stmt.issuer);
    if (!entity) {
      // Auto-ensure the entity with 'none' trust so we remember the key
      await this.ensureEntity(issuerKey);
      return reject(signed, 'unknown-issuer', 'Unknown entity — auto-registered with no trust');
    }

    // ---- 4. Check revocation ----
    if (await this.store.isRevoked(stmt.issuer)) {
      return reject(signed, 'revoked', 'Issuer has been revoked');
    }

    // ---- 5. Check statement expiry ----
    if (stmt.expiresAt !== undefined && stmt.expiresAt <= Date.now()) {
      return reject(signed, 'expired', 'Statement has expired');
    }

    // ---- 6. Route by type ----
    switch (stmt.type) {
      case 'delegation':
        return this.verifyDelegation(signed, entity);
      case 'revocation':
        return this.verifyRevocation(signed, entity);
      case 'emergency':
        return this.verifyEmergency(signed, entity);
      case 'announcement':
        return this.verifyAnnouncement(signed, entity);
      case 'text':
        return this.verifyText(signed, entity);
      default:
        return reject(signed, 'untrusted', `Unknown statement type: ${stmt.type}`);
    }
  }

  // -----------------------------------------------------------------------
  // Type-specific verification
  // -----------------------------------------------------------------------

  /**
   * Verify a delegation statement.
   * The issuer must have 'certify' scope.
   * If valid, the delegation is stored.
   */
  private async verifyDelegation(
    signed: SignedStatement,
    issuer: Entity,
  ): Promise<VerificationResult> {
    // Parse the delegation payload
    let delegate: KeyId;
    let scopes: Scope[];
    try {
      const parsed = JSON.parse(new TextDecoder().decode(signed.statement.payload));
      if (typeof parsed.delegate !== 'string') throw new Error();
      if (!Array.isArray(parsed.scope)) throw new Error();
      // Validate and deduplicate scopes
      const filtered: Scope[] = parsed.scope.filter((s: string): s is Scope =>
        (ALL_SCOPES as readonly string[]).includes(s)
      );
      scopes = [...new Set(filtered)];
      if (scopes.length === 0) throw new Error();
      delegate = parsed.delegate;

      // Reject self-delegation (would create cycle)
      if (delegate === issuer.id) {
        return reject(signed, 'untrusted', 'Self-delegation is not allowed');
      }
    } catch {
      return reject(signed, 'untrusted', 'Invalid delegation payload');
    }

    // Check issuer has certify scope
    const chain = await this.getTrustChain(issuer.id, 'certify');
    if (!chain) {
      return reject(signed, 'untrusted', 'Issuer does not have certify scope');
    }

    // Validate delegate key format before storing anything
    // (publicKeyFromKeyId validates length; may throw on bad hex)
    try {
      publicKeyFromKeyId(delegate);
    } catch {
      return reject(signed, 'untrusted', 'Invalid delegate key ID');
    }

    // Auto-ensure the delegate entity exists with 'delegated' trust.
    // The delegate's public key is embedded in the KeyId (hex of 32 bytes).
    await this.ensureDelegatedEntity(delegate);

    // Create the delegation record
    const delegation: Delegation = {
      id: signed.statement.id,
      issuer: issuer.id,
      delegate,
      scope: scopes,
      issuedAt: signed.statement.issuedAt,
      expiresAt: signed.statement.expiresAt,
      statementId: signed.statement.id,
    };
    await this.store.addDelegation(delegation);

    return {
      status: 'trusted',
      signed,
      trustChain: chain,
      reason: `Delegation accepted: ${delegate} granted [${scopes.join(', ')}]`,
    };
  }

  /**
   * Verify a revocation statement.
   * The issuer must either:
   *   a) Have 'certify' scope, OR
   *   b) Be the original delegator of the target
   */
  private async verifyRevocation(
    signed: SignedStatement,
    issuer: Entity,
  ): Promise<VerificationResult> {
    let target: KeyId;
    let reason: string;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(signed.statement.payload));
      if (typeof parsed.target !== 'string') throw new Error();
      if (typeof parsed.reason !== 'string') throw new Error();
      target = parsed.target;
      reason = parsed.reason;
      // Validate target is a valid KeyId
      publicKeyFromKeyId(target);
    } catch {
      return reject(signed, 'untrusted', 'Invalid revocation payload');
    }

    // Check if issuer has certify scope (case a)
    const chain = await this.getTrustChain(issuer.id, 'certify');

    // If no certify chain, check if issuer is the original delegator (case b)
    if (!chain) {
      const delegations = await this.store.getDelegationsForDelegate(target);
      const isOriginalDelegator = delegations.some((d) => d.issuer === issuer.id);
      if (!isOriginalDelegator) {
        return reject(
          signed,
          'untrusted',
          'Issuer lacks certify scope and is not the original delegator',
        );
      }
    }

    // Create the revocation
    const revocation: Revocation = {
      id: signed.statement.id,
      issuer: issuer.id,
      target,
      reason,
      issuedAt: signed.statement.issuedAt,
      statementId: signed.statement.id,
    };
    await this.store.addRevocation(revocation);

    // Remove delegations for the revoked delegate.
    // When the revoker has 'certify' scope (case a), remove ALL delegations
    // for that target. When the revoker is the original delegator (case b),
    // only remove their own delegations.
    const existingDelegations = await this.store.getDelegationsForDelegate(target);
    if (chain) {
      // Case a: certify scope — broad authority, remove all
      for (const d of existingDelegations) {
        await this.store.removeDelegation(d.id);
      }
    } else {
      // Case b: original delegator — only remove our own
      for (const d of existingDelegations) {
        if (d.issuer === issuer.id) {
          await this.store.removeDelegation(d.id);
        }
      }
    }

    return {
      status: 'trusted',
      signed,
      trustChain: chain ?? undefined,
      reason: `Revocation accepted: ${target} revoked by ${issuer.id}`,
    };
  }

  /**
   * Verify an emergency statement.
   * Emergency statements are always accepted as pending; they become
   * verified-emergency once enough validations accumulate.
   */
  private async verifyEmergency(
    signed: SignedStatement,
    issuer: Entity,
  ): Promise<VerificationResult> {
    // Check if already enough validations first
    const count = await this.store.getValidationCount(signed.statement.id);
    const threshold = DEFAULT_EMERGENCY_THRESHOLD;

    if (count >= threshold) {
      return {
        status: 'verified-emergency',
        signed,
        validations: await this.store.getValidationsForStatement(signed.statement.id),
        reason: `Emergency verified: ${count}/${threshold} validations`,
      };
    }

    // Store as pending emergency (only if not already verified)
    await this.store.addPendingEmergency(signed);

    return {
      status: 'pending-emergency',
      signed,
      validations: await this.store.getValidationsForStatement(signed.statement.id),
      reason: `Emergency pending: ${count}/${threshold} validations needed`,
    };
  }

  /**
   * Verify an announcement statement.
   * The issuer needs 'announce' scope for it to be trusted.
   */
  private async verifyAnnouncement(
    signed: SignedStatement,
    issuer: Entity,
  ): Promise<VerificationResult> {
    const chain = await this.getTrustChain(issuer.id, 'announce');
    if (chain) {
      return {
        status: 'trusted',
        signed,
        trustChain: chain,
        reason: `Announcement from trusted entity ${issuer.name}`,
      };
    }

    // Fall back based on trust kind.
    // Both 'direct' (in-person contact) and 'delegated' (no announce scope)
    // entities are known but not trusted authorities.
    if (issuer.trustKind === 'direct' || issuer.trustKind === 'delegated') {
      return {
        status: 'known',
        signed,
        reason: `Announcement from ${issuer.trustKind} entity (no announce scope)`,
      };
    }

    return reject(signed, 'untrusted', 'Announcement from untrusted entity');
  }

  /**
   * Verify a text message.
   * Same logic as announcement but with different status for 'direct' entities.
   */
  private async verifyText(
    signed: SignedStatement,
    issuer: Entity,
  ): Promise<VerificationResult> {
    const chain = await this.getTrustChain(issuer.id, 'announce');
    if (chain) {
      return {
        status: 'trusted',
        signed,
        trustChain: chain,
      };
    }

    if (issuer.trustKind === 'direct' || issuer.trustKind === 'delegated') {
      return {
        status: 'known',
        signed,
        reason: 'Message from a known entity (no announce scope)',
      };
    }

    return {
      status: 'untrusted',
      signed,
      reason: 'Message from untrusted entity',
    };
  }

  // -----------------------------------------------------------------------
  // Trust chain resolution
  // -----------------------------------------------------------------------

  /**
   * Trace a delegation chain from `entityId` up to a root entity that grants
   * the required `scope`.
   *
   * Returns the chain (entity → delegator → ... → root) if found, or null
   * if no valid chain exists.
   */
  async getTrustChain(
    entityId: KeyId,
    scope: Scope,
  ): Promise<Entity[] | null> {
    // Check revocation at every level, including the starting entity
    if (await this.store.isRevoked(entityId)) return null;

    // Root entities have all scopes implicitly
    const root = await this.store.getEntity(entityId);
    if (root?.trustKind === 'root') return [root];

    const chain: Entity[] = [];
    let current = entityId;
    let requiredScope: Scope = scope;
    const visited = new Set<KeyId>();

    for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth++) {
      if (visited.has(current)) return null; // cycle detected
      visited.add(current);

      // Check revocation before using this entity
      if (await this.store.isRevoked(current)) return null;

      const entity = await this.store.getEntity(current);
      if (!entity) return null;

      chain.push(entity);

      // Found a root — chain complete
      if (entity.trustKind === 'root') {
        return chain;
      }

      // 'direct' entities don't delegate upward — they're trusted in person
      if (entity.trustKind === 'direct') {
        return null;
      }

      // Find a delegation that gives this entity the required scope.
      // The first level (target entity) must have the requested scope.
      // Every level above must have 'certify' scope (to be allowed to delegate).
      const delegations = await this.store.getDelegationsForDelegate(current);

      const valid = delegations.filter((d) => {
        if (!d.scope.includes(requiredScope)) return false;
        if (d.expiresAt !== undefined && d.expiresAt <= Date.now()) return false;
        return true;
      });

      if (valid.length === 0) return null;

      // Use the newest valid delegation
      const delegation = valid.reduce((a, b) =>
        a.issuedAt > b.issuedAt ? a : b,
      );

      // Levels above need 'certify' to delegate further
      requiredScope = 'certify';

      // Move up to the delegator
      current = delegation.issuer;
    }

    return null; // chain too deep
  }

  /**
   * Check if an entity has a specific scope via delegation chain.
   */
  async isAuthorized(entityId: KeyId, scope: Scope): Promise<boolean> {
    const chain = await this.getTrustChain(entityId, scope);
    return chain !== null;
  }

  // -----------------------------------------------------------------------
  // Delegation helpers
  // -----------------------------------------------------------------------

  /**
   * Create a delegation signed statement manually.
   * Useful for the app layer to issue delegations from a root entity.
   */
  async delegate(
    secretKey: Uint8Array,
    issuerId: KeyId,
    delegatePublicKey: Uint8Array,
    scope: Scope[],
    expiresAt?: number,
  ): Promise<SignedStatement> {
    const delegateId = keyIdFromPublicKey(delegatePublicKey);
    const payload = new TextEncoder().encode(
      JSON.stringify({ delegate: delegateId, scope }),
    );
    return this.sign(secretKey, 'delegation', payload, issuerId, expiresAt);
  }

  /**
   * Create a revocation signed statement manually.
   */
  async revoke(
    secretKey: Uint8Array,
    issuerId: KeyId,
    targetId: KeyId,
    reason: string,
  ): Promise<SignedStatement> {
    const payload = new TextEncoder().encode(
      JSON.stringify({ target: targetId, reason }),
    );
    return this.sign(secretKey, 'revocation', payload, issuerId);
  }

  // -----------------------------------------------------------------------
  // Emergency validation
  // -----------------------------------------------------------------------

  /**
   * Validate an emergency statement. The validator must have 'validate' scope.
   *
   * Returns the updated VerificationResult, or null if the validator is not
   * authorized.
   */
  async validateEmergency(
    validatorSecret: Uint8Array,
    validatorId: KeyId,
    statementId: string,
  ): Promise<VerificationResult> {
    // Check validator has validate scope
    const authorized = await this.isAuthorized(validatorId, 'validate');
    if (!authorized) {
      return {
        status: 'untrusted',
        signed: await this.store.getPendingEmergency(statementId) ?? this.emptySigned(),
        reason: 'Validator lacks validate scope',
      };
    }

    const pending = await this.store.getPendingEmergency(statementId);
    if (!pending) {
      return {
        status: 'untrusted',
        signed: this.emptySigned(),
        reason: 'Unknown emergency statement',
      };
    }

    // Verify proof of possession: the secret key must match the validator's
    // public key. This prevents attackers from injecting fake validations
    // using only a known public KeyId.
    const derivedPublic = ed25519.getPublicKey(validatorSecret);
    const validatorPublic = publicKeyFromKeyId(validatorId);
    if (!constantTimeEqual(derivedPublic, validatorPublic)) {
      return {
        status: 'untrusted',
        signed: pending,
        reason: 'Validator secret does not match public key',
      };
    }

    // Sign the statementId as cryptographic proof of validation
    const sigPayload = new TextEncoder().encode(`protestchat/v1/validate:${statementId}`);
    const validationSignature = ed25519.sign(sigPayload, validatorSecret);

    // Record the validation
    const validation: Validation = {
      statementId,
      validator: validatorId,
      validatedAt: Date.now(),
      signature: validationSignature,
    };
    await this.store.addValidation(validation);

    // Check if threshold is now met (no need to re-verify signatures)
    const count = await this.store.getValidationCount(statementId);
    const threshold = DEFAULT_EMERGENCY_THRESHOLD;

    if (count >= threshold) {
      // Move from pending to verified
      await this.store.removePendingEmergency(statementId);
      return {
        status: 'verified-emergency',
        signed: pending,
        validations: await this.store.getValidationsForStatement(statementId),
        reason: `Emergency verified: ${count}/${threshold} validations`,
      };
    }

    return {
      status: 'pending-emergency',
      signed: pending,
      validations: await this.store.getValidationsForStatement(statementId),
      reason: `Emergency pending: ${count}/${threshold} validations needed`,
    };
  }

  /**
   * Get the current validation status of an emergency statement.
   */
  async getEmergencyStatus(
    statementId: string,
    threshold = DEFAULT_EMERGENCY_THRESHOLD,
  ): Promise<{ count: number; threshold: number; met: boolean }> {
    const count = await this.store.getValidationCount(statementId);
    return { count, threshold, met: count >= threshold };
  }

  /**
   * List all pending emergency statements.
   */
  async getPendingEmergencies(): Promise<SignedStatement[]> {
    return this.store.getPendingEmergencies();
  }

  /**
   * Re-check all pending emergencies against an updated threshold.
   * Returns statements that newly met the threshold.
   */
  async checkPendingEmergencies(
    threshold = DEFAULT_EMERGENCY_THRESHOLD,
  ): Promise<SignedStatement[]> {
    const pending = await this.store.getPendingEmergencies();
    const newlyVerified: SignedStatement[] = [];

    for (const p of pending) {
      const count = await this.store.getValidationCount(p.statement.id);
      if (count >= threshold) {
        newlyVerified.push(p);
        await this.store.removePendingEmergency(p.statement.id);
      }
    }

    return newlyVerified;
  }

  // -----------------------------------------------------------------------
  // Revocation helpers
  // -----------------------------------------------------------------------

  /**
   * Check if an entity is revoked.
   */
  async isRevoked(entityId: KeyId): Promise<boolean> {
    return this.store.isRevoked(entityId);
  }

  /** Build a placeholder SignedStatement for error results. */
  private emptySigned(): SignedStatement {
    return {
      statement: {
        id: '', type: 'text', issuer: '',
        payload: new Uint8Array(0), issuedAt: 0,
      },
      signature: new Uint8Array(0),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reject(
  signed: SignedStatement,
  status: VerificationStatus,
  reason: string,
): VerificationResult {
  return { status, signed, reason };
}

function shortName(id: KeyId): string {
  return `unknown-${id.slice(0, 6)}`;
}

/**
 * Merge two trust kinds, preferring the one with higher authority.
 */
function trustKindPriority(a: TrustKind, b: TrustKind): TrustKind {
  const order: Record<TrustKind, number> = {
    root: 3,
    delegated: 2,
    direct: 1,
    none: 0,
  };
  return order[a] >= order[b] ? a : b;
}

/**
 * Constant-time byte array comparison. Used for comparing derived public keys
 * in validateEmergency to prevent timing side-channel attacks.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
