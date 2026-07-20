# Trust module

Emergency-broadcast authentication and trust management for protestchat.

This module is **completely independent** of the mesh protocol — it doesn't import anything from `src/lib/`, doesn't know about envelopes, BLE, or the mesh. It depends only on `@noble/curves` (Ed25519) and `@noble/hashes` (SHA-256).

## Subscription model, not global authority

- **No pre-loaded root keys.** `PRELOADED_ROOTS` is deliberately empty — a shipped root key is a single compromise target.
- **Every user curates their own trust graph** via `subscribe()`. Trust anchors arrive the same way any contact does: QR code, paste, or signed delegation from someone you already trust.
- **Delegations are memory only.** Never persisted to disk. On restart the graph is rebuilt from signed statements received over the mesh. A seized phone reveals no organizational hierarchy.
- **Trust kinds are engine internals.** The app's contact trust model (in-person key exchange + safety numbers) is separate and orthogonal. The engine reports `VerificationResult`; the app decides what to display.

See [`DESIGN.md`](DESIGN.md) for the full rationale.

## Important: trust kinds are engine internals

The trust kinds (`root`, `delegated`, `direct`, `none`) describe where an
entity sits in the delegation graph — what it can DO (certify, announce,
validate). They are NOT user-facing identity labels and the app should not
display them as such.

The app's contact trust model is separate and orthogonal:
1. Scan a QR code → you have their public key
2. Compare safety numbers in person → you know the key is theirs
3. Messages from verified contacts are displayed normally

The engine's `VerificationResult` is what the app should use for rendering
decisions. `TrustKind` is for engine-internal chain resolution.

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

### Entity trust kinds (engine-internal)

| Kind | Meaning |
|---|---|
| `root` | Manually subscribed trust anchor. Can certify other keys. |
| `delegated` | Trusted because a root-certified entity vouched for them. |
| `direct` | Known via in-person key exchange. Not an authority in the graph. |
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

### Subscription (primary API)

Users control their own trust graph. There is no global authority.

```typescript
const engine = new TrustEngine();

// Subscribe to an entity you trust. This is how trust anchors are added —
// there are NO pre-loaded keys in the binary.
const committee = await engine.subscribe(
  committeePublicKey,
  'Coordinating Committee',
  'root',
);

// Add a contact you met in person (QR scan + safety numbers)
const contact = await engine.subscribe(
  contactPublicKey,
  'Alice',
  'direct',
);

// List entities you've explicitly subscribed to
const subscribed = await engine.listSubscribed();

// Unsubscribe — your choice, no one can override it
await engine.unsubscribe(committee.id);

// Look up and list all entities (including auto-registered)
const e = await engine.getEntity(keyId);
const all = await engine.listEntities();
const roots = await engine.listEntities('root');

// Auto-register a key we received a message from (no trust assigned)
await engine.ensureEntity(unknownPublicKey);
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
