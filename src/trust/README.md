# Trust module

Standalone identity, authorization, and trust management for protestchat.

This module is **completely independent** of the mesh protocol — it doesn't import anything from `src/lib/`, doesn't know about envelopes, BLE, or the mesh. It depends only on `@noble/curves` (Ed25519) and `@noble/hashes` (SHA-256).

During integration, every incoming message passes through `TrustEngine.verify()` which determines how it should be displayed — trusted, known, untrusted, revoked, or emergency.

## Model

```
┌──────────────────────────────────────────┐
│  Entity (Ed25519 key pair)               │
│  - trustKind: root | delegated          │
│               direct | none              │
│  - name, metadata                        │
└──────────┬───────────────────────────────┘
           │ signs
           ▼
┌──────────────────────────────────────────┐
│  Statement (signed claim)                │
│  - type: text | delegation | revocation │
│          announcement | emergency         │
│  - payload: type-specific bytes          │
│  - Ed25519 signature                     │
└──────────────────────────────────────────┘
```

### Entity trust kinds

| Kind | Meaning |
|---|---|
| `root` | Pre-loaded or manually subscribed. Ultimate trust anchor. All scopes implicitly. |
| `delegated` | Trusted because a root entity vouched for them via a signed delegation. |
| `direct` | Trusted because we met in person and exchanged keys. Not an authority. |
| `none` | Known but not trusted. Default for unsolicited messages. |

### Scopes (what an entity can do)

| Scope | Authority |
|---|---|
| `certify` | Can delegate authority to other entities (create delegations). |
| `announce` | Can sign statements shown to users as "trusted". |
| `validate` | Can counter-sign emergency messages. |

### Trust chain resolution

```
Root (Coordinating Committee)
  └── delegates certify → Zone Coordinator A
        └── delegates announce → Safety Lead B
              └── signs "Tear gas at Gate 4"
                    ↓
TrustEngine.verify():
  1. Verify Ed25519 signature
  2. Look up entity B
  3. Follow delegation chain: B → A → Root
  4. Every level checked: not revoked, not expired
  5. Root found → status: 'trusted'
```

## Module structure

```
src/trust/
├── index.ts          # Public API exports
├── types.ts          # Core types, canonical serialization, KeyId helpers
├── engine.ts         # TrustEngine — the main API surface
├── store.ts          # TrustStore interface + MemoryTrustStore
├── roots.ts          # Pre-loaded root keys (integration point)
├── README.md
└── __tests__/
    ├── engine.test.ts    # 68 tests
    ├── store.test.ts     # 21 tests
    └── fixtures.ts       # Deterministic Ed25519 key pairs
```

## TrustEngine API

### Entity management

```typescript
const engine = new TrustEngine();

// Subscribe to a root entity (pre-loaded or scanned QR)
const entity = await engine.subscribe(publicKey, 'Coordinating Committee', 'root');

// Ensure an entity exists (auto-register with 'none' trust)
await engine.ensureEntity(unknownPublicKey);

// Look up and list
const e = await engine.getEntity(keyId);
const all = await engine.listEntities();
const roots = await engine.listEntities('root');

// Unsubscribe
await engine.unsubscribe(keyId);
```

### Statement verification (core method)

```typescript
// Verify any incoming signed statement
const result = await engine.verify(signedStatement);

// Result tells you what to do:
switch (result.status) {
  case 'trusted':          // Show with trusted badge
  case 'known':            // Show from a known contact
  case 'untrusted':        // Show with warning
  case 'revoked':          // Do not show
  case 'expired':          // Do not show
  case 'unknown-issuer':   // Auto-registered, show with warning
  case 'verified-emergency': // Show with emergency badge
  case 'pending-emergency': // Hold pending validation
}
```

### Delegation

```typescript
// Root delegates announce scope to an organizer
const delegation = await engine.delegate(
  rootSecretKey, rootId, organizerPublicKey, ['announce']
);
const result = await engine.verify(delegation);
// → { status: 'trusted' }

// The organizer can now sign trusted announcements:
const announcement = await engine.sign(
  organizerSecretKey, 'announcement', payload, organizerId
);
```

### Revocation

```typescript
// Revoke a delegation (case A: has certify scope → removes all)
// Revoke a delegation (case B: original delegator → removes only own)
const revocation = await engine.revoke(
  issuerSecretKey, issuerId, targetId, 'compromised'
);
await engine.verify(revocation);

// Check revocation status
const revoked = await engine.isRevoked(entityId);
```

### Emergency messages

```typescript
// Anyone can create an emergency
const emergency = await engine.sign(
  senderKey, 'emergency', payload, senderId
);
const result = await engine.verify(emergency);
// → { status: 'pending-emergency' }

// Trusted validators validate
const validationResult = await engine.validateEmergency(
  validatorSecretKey, validatorId, emergency.statement.id
);

// When threshold (default 3) is met:
const updatedResult = await engine.verify(emergency);
// → { status: 'verified-emergency' }
```

## Storage

The module uses the same pattern as the app's `MeshStore`:

```typescript
interface TrustStore {
  addEntity(entity): Promise<void>;
  getEntity(id): Promise<Entity | null>;
  listEntities(): Promise<Entity[]>;
  // ... delegations, revocations, validations, emergencies
}
```

`MemoryTrustStore` is included for testing. During integration, a SQLite-backed implementation is wired in using the same `db.ts` pattern.

## Testing

```bash
# Run trust module tests only
node --experimental-strip-types --import ./scripts/ts-resolver.mjs --test 'src/trust/__tests__/*.test.ts'

# Run all tests (trust + existing)
npm test
```

89 tests covering:
- Entity CRUD, trust kind upgrades, key validation
- Delegation/revocation lifecycle (scope checking, trust chain, original delegator path)
- Trust chain resolution (two-level, three-level, cycles, scope gaps, revocation at every level, max depth boundary)
- Emergency pipeline (pending, validation with PoP, threshold, re-check)
- Statement signing round-trip, forged ID overwrite, invalid signature rejection
- Store: deep-clone safety, index consistency, cleanup on removal, empty collections
