/**
 * Storage interface for the trust module.
 *
 * Same pattern as MeshStore/MemoryStore in src/lib/: define an interface,
 * provide an in-memory implementation for tests, and let the integration
 * layer provide a SQLite-backed implementation later.
 *
 * The trust module never imports src/lib/ — this is a standalone module.
 */

import type {
  KeyId,
  Entity,
  Delegation,
  Revocation,
  Validation,
  SignedStatement,
  Scope,
} from './types';

// ---------------------------------------------------------------------------
// Deep-clone helpers
// ---------------------------------------------------------------------------

/** Clone a Uint8Array (creates an independent copy). */
function cloneBytes(b: Uint8Array): Uint8Array {
  return new Uint8Array(b);
}

/** Deep-clone a Delegation (all fields are primitives or string arrays). */
function cloneDelegation(d: Delegation): Delegation {
  return { ...d, scope: [...d.scope] };
}

/** Deep-clone a Revocation (all primitives). */
function cloneRevocation(r: Revocation): Revocation {
  return { ...r };
}

/** Deep-clone a Validation (has signature Uint8Array). */
function cloneValidation(v: Validation): Validation {
  return { ...v, signature: cloneBytes(v.signature) };
}

/** Deep-clone a SignedStatement (has Uint8Array fields). */
function cloneSignedStatement(s: SignedStatement): SignedStatement {
  return {
    statement: {
      ...s.statement,
      payload: cloneBytes(s.statement.payload),
    },
    signature: cloneBytes(s.signature),
  };
}

/** Deep-clone an Entity (has Uint8Array publicKey and metadata object). */
function cloneEntity(e: Entity): Entity {
  return { ...e, publicKey: cloneBytes(e.publicKey), metadata: { ...e.metadata } };
}

// ---------------------------------------------------------------------------
// TrustStore interface
// ---------------------------------------------------------------------------

export interface TrustStore {
  // ---- Entities ----
  addEntity(entity: Entity): Promise<void>;
  removeEntity(id: KeyId): Promise<void>;
  getEntity(id: KeyId): Promise<Entity | null>;
  listEntities(): Promise<Entity[]>;
  listEntitiesByKind(kind: Entity['trustKind']): Promise<Entity[]>;

  // ---- Delegations ----
  // WARNING: Delegations encode the organizational hierarchy (who authorized
  // whom). In production they MUST NOT be persisted to disk — that would turn
  // a seized unlocked phone into a complete map of the trust graph.
  // MemoryTrustStore correctly keeps them in memory only (isPersistent=false).
  // A SQLite adapter MUST keep this table in memory or skip persistence.
  addDelegation(d: Delegation): Promise<void>;
  removeDelegation(id: string): Promise<void>;
  getDelegation(id: string): Promise<Delegation | null>;
  getDelegationsForDelegate(delegate: KeyId): Promise<Delegation[]>;
  getDelegationsByIssuer(issuer: KeyId): Promise<Delegation[]>;
  listDelegations(): Promise<Delegation[]>;

  // ---- Revocations ----
  addRevocation(r: Revocation): Promise<void>;
  removeRevocation(id: string): Promise<void>;
  getRevocation(id: string): Promise<Revocation | null>;
  getRevocationsForTarget(target: KeyId): Promise<Revocation[]>;
  isRevoked(entityId: KeyId): Promise<boolean>;
  listRevocations(): Promise<Revocation[]>;

  // ---- Emergency validations ----
  addValidation(v: Validation): Promise<void>;
  getValidationsForStatement(statementId: string): Promise<Validation[]>;
  getValidationCount(statementId: string): Promise<number>;

  // ---- Statements (for emergency pending queue) ----
  addPendingEmergency(signed: SignedStatement): Promise<void>;
  removePendingEmergency(statementId: string): Promise<void>;
  getPendingEmergencies(): Promise<SignedStatement[]>;
  getPendingEmergency(statementId: string): Promise<SignedStatement | null>;

  // ---- Lifecycle ----
  /** Remove all data from the store. For panic wipe and testing. */
  clearAll(): Promise<void>;
  /**
   * Whether data persists across restarts. Memory stores return false;
   * SQLite adapters return true. Used by the engine to decide whether
   * to cache/copy sensitive trust graph data.
   */
  isPersistent(): boolean;
}

// ---------------------------------------------------------------------------
// MemoryTrustStore
// ---------------------------------------------------------------------------

/** Maximum pending emergencies before eviction (oldest dropped). */
const MAX_PENDING_EMERGENCIES = 500;

export function createMemoryTrustStore(): TrustStore {
  const entities = new Map<KeyId, Entity>();
  const delegations = new Map<string, Delegation>();
  const revocations = new Map<string, Revocation>();
  const validations = new Map<string, Validation[]>();
  const pendingEmergencies = new Map<string, SignedStatement>();

  // Per-delegate index: delegate KeyId → Set<delegation ID>
  const byDelegate = new Map<KeyId, Set<string>>();
  // Per-issuer index: issuer KeyId → Set<delegation ID>
  const byIssuer = new Map<KeyId, Set<string>>();
  // Per-target index: target KeyId → Set<revocation ID>
  const byRevokedTarget = new Map<KeyId, Set<string>>();
  // Per-issuer index: issuer KeyId → Set<revocation ID>
  const byRevocationIssuer = new Map<KeyId, Set<string>>();

  /** Remove a delegation ID from an index map, cleaning up empty Sets. */
  function removeFromIndex(map: Map<KeyId, Set<string>>, key: KeyId, id: string): void {
    const set = map.get(key);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) map.delete(key);
  }

  return {
    // ---- Entities ----
    async addEntity(entity) {
      entities.set(entity.id, cloneEntity(entity));
    },

    async removeEntity(id) {
      entities.delete(id);

      // Remove delegations involving this entity using indexes (O(m) not O(n))
      const delIds = new Set<string>();
      for (const did of (byDelegate.get(id) ?? [])) delIds.add(did);
      for (const did of (byIssuer.get(id) ?? [])) delIds.add(did);
      for (const dId of delIds) {
        const d = delegations.get(dId);
        if (d) {
          // Clean up validations keyed by this delegation's statement ID
          validations.delete(d.statementId);
          removeFromIndex(byDelegate, d.delegate, dId);
          removeFromIndex(byIssuer, d.issuer, dId);
          delegations.delete(dId);
        }
      }

      // Remove revocations targeting this entity
      const targetRevIds = byRevokedTarget.get(id);
      if (targetRevIds) {
        for (const rId of targetRevIds) revocations.delete(rId);
        byRevokedTarget.delete(id);
      }

      // Remove revocations issued BY this entity (O(m) via index)
      const issuerRevIds = byRevocationIssuer.get(id);
      if (issuerRevIds) {
        for (const rId of issuerRevIds) {
          const r = revocations.get(rId);
          if (r) {
            revocations.delete(rId);
            removeFromIndex(byRevokedTarget, r.target, rId);
          }
        }
        byRevocationIssuer.delete(id);
      }

      // Remove pending emergencies from this entity (and their validations)
      for (const [stmtId, s] of pendingEmergencies) {
        if (s.statement.issuer === id) {
          pendingEmergencies.delete(stmtId);
          validations.delete(stmtId);
        }
      }
    },

    async getEntity(id) {
      const e = entities.get(id);
      return e ? cloneEntity(e) : null;
    },

    async listEntities() {
      return [...entities.values()].map(cloneEntity);
    },

    async listEntitiesByKind(kind) {
      return [...entities.values()]
        .filter((e) => e.trustKind === kind)
        .map(cloneEntity);
    },

    // ---- Delegations ----
    async addDelegation(d) {
      const cloned = cloneDelegation(d);
      delegations.set(d.id, cloned);

      const delSet = byDelegate.get(d.delegate) ?? new Set();
      delSet.add(d.id);
      byDelegate.set(d.delegate, delSet);

      const issSet = byIssuer.get(d.issuer) ?? new Set();
      issSet.add(d.id);
      byIssuer.set(d.issuer, issSet);
    },

    async removeDelegation(id) {
      const d = delegations.get(id);
      if (d) {
        removeFromIndex(byDelegate, d.delegate, id);
        removeFromIndex(byIssuer, d.issuer, id);
        // Remove validations keyed by this delegation's statement ID
        validations.delete(d.statementId);
      }
      delegations.delete(id);
    },

    async getDelegation(id) {
      const d = delegations.get(id);
      return d ? cloneDelegation(d) : null;
    },

    async getDelegationsForDelegate(delegate) {
      const ids = byDelegate.get(delegate);
      if (!ids) return [];
      return [...ids]
        .map((id) => delegations.get(id)!)
        .filter(Boolean)
        .map(cloneDelegation);
    },

    async getDelegationsByIssuer(issuer) {
      const ids = byIssuer.get(issuer);
      if (!ids) return [];
      return [...ids]
        .map((id) => delegations.get(id)!)
        .filter(Boolean)
        .map(cloneDelegation);
    },

    async listDelegations() {
      return [...delegations.values()].map(cloneDelegation);
    },

    // ---- Revocations ----
    async addRevocation(r) {
      const cloned = cloneRevocation(r);
      revocations.set(r.id, cloned);

      const targetSet = byRevokedTarget.get(r.target) ?? new Set();
      targetSet.add(r.id);
      byRevokedTarget.set(r.target, targetSet);

      const issuerSet = byRevocationIssuer.get(r.issuer) ?? new Set();
      issuerSet.add(r.id);
      byRevocationIssuer.set(r.issuer, issuerSet);
    },

    async removeRevocation(id) {
      const r = revocations.get(id);
      if (r) {
        removeFromIndex(byRevokedTarget, r.target, id);
        removeFromIndex(byRevocationIssuer, r.issuer, id);
      }
      revocations.delete(id);
    },

    async getRevocation(id) {
      const r = revocations.get(id);
      return r ? cloneRevocation(r) : null;
    },

    async getRevocationsForTarget(target) {
      const ids = byRevokedTarget.get(target);
      if (!ids) return [];
      return [...ids]
        .map((id) => revocations.get(id)!)
        .filter(Boolean)
        .map(cloneRevocation);
    },

    async isRevoked(entityId) {
      const ids = byRevokedTarget.get(entityId);
      return ids !== undefined && ids.size > 0;
    },

    async listRevocations() {
      return [...revocations.values()].map(cloneRevocation);
    },

    // ---- Emergency validations ----
    async addValidation(v) {
      const list = validations.get(v.statementId) ?? [];
      // Don't duplicate validators
      if (!list.some((existing) => existing.validator === v.validator)) {
        list.push(cloneValidation(v));
        validations.set(v.statementId, list);
      }
    },

    async getValidationsForStatement(statementId) {
      const list = validations.get(statementId);
      return list ? list.map(cloneValidation) : [];
    },

    async getValidationCount(statementId) {
      return validations.get(statementId)?.length ?? 0;
    },

    // ---- Pending emergencies ----
    async addPendingEmergency(signed) {
      // Evict oldest if at cap (protect against flood DoS)
      if (pendingEmergencies.size >= MAX_PENDING_EMERGENCIES) {
        const oldest = pendingEmergencies.keys().next().value;
        if (oldest) {
          pendingEmergencies.delete(oldest);
          validations.delete(oldest);
        }
      }
      pendingEmergencies.set(signed.statement.id, cloneSignedStatement(signed));
    },

    async removePendingEmergency(statementId) {
      pendingEmergencies.delete(statementId);
    },

    async getPendingEmergencies() {
      return [...pendingEmergencies.values()].map(cloneSignedStatement);
    },

    async getPendingEmergency(statementId) {
      const s = pendingEmergencies.get(statementId);
      return s ? cloneSignedStatement(s) : null;
    },

    // ---- Lifecycle ----
    async clearAll() {
      entities.clear();
      delegations.clear();
      revocations.clear();
      validations.clear();
      pendingEmergencies.clear();
      byDelegate.clear();
      byIssuer.clear();
      byRevokedTarget.clear();
      byRevocationIssuer.clear();
    },

    isPersistent() {
      return false;
    },
  };
}
