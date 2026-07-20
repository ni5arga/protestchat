# Trust module design

## What this is for

Emergency-broadcast authentication for a mesh messaging app used during
protests. The one real gap this closes: when someone broadcasts "tear gas at
Gate 4 — move north" over the public channel, there is currently no way to
know whether that came from a trusted source or from someone walking the
crowd into a kettle. A threshold-signed emergency notice fixes exactly that.

## What this is NOT

A general-purpose PKI or identity framework. The trust module provides the
*mechanism* for delegation chains, scopes, and verification — but the app
decides whether and how to surface those concepts to users.

The app already has a trust model for ordinary contacts: in-person key
exchange + safety number comparison. Nothing in this module replaces that.
The `VerificationResult` statuses (`trusted`, `known`, `untrusted`, etc.)
are the engine's internal assessment; the app chooses what to display.

## Subscription model, not global authority

There are no pre-loaded root keys in the binary. `PRELOADED_ROOTS` is
deliberately empty. Trust anchors arrive the same way any contact does:
- Scanning a QR code
- Pasting a public key
- Accepting a signed delegation from someone you already trust

Every user curates their own trust graph. There is no global "Coordinating
Committee" key shipped to all installs. If a protest ecosystem needs one,
it is distributed out-of-band (a link, a poster, a news article) and the
user subscribes to it via `subscribe()`.

This means:
- No single subpoena target (no central key to seize)
- No binary update needed to change the trust anchor
- Users can independently verify and choose their sources

## Delegation graph is memory-only

Delegations (who authorized whom) are STORED IN MEMORY ONLY. They are never
written to disk. On app restart, the delegation graph is rebuilt from signed
delegation statements received over the mesh.

This is a deliberate tradeoff:
- **Availability cost**: on a cold start in a jammed zone with no peers, the
  graph is empty until delegation statements arrive via the mesh.
- **Security gain**: a seized phone reveals no organizational hierarchy —
  no map of who authorized whom, which is precisely the data structure the
  mesh layer works hard to never create.

Entities (identities) MAY be persisted — knowing "I have communicated with
publicKey X" is a contact list, not an org chart. But the relationships
between them (delegations, revocations) live in memory only.

## Emergency pipeline

Anyone can broadcast an emergency message. It enters the `pending-emergency`
state — the app does not display it by default (but the user can view it).

Entities the user has subscribed to can validate (counter-sign) the
emergency. Each validation includes an Ed25519 signature proving the
validator actually holds their private key (proof of possession).

When a configurable threshold of validations is reached (default: 3), the
emergency transitions to `verified-emergency`. The app can then display it
with a verified badge.

Emergency messages receive the lowest transmission priority in the mesh
(handled by the integration layer, not the trust module). Unvalidated
emergencies are not tracked or relayed after a timeout.

## Trust kinds are engine internals

The engine uses `TrustKind` (root, delegated, direct, none) internally to
resolve delegation chains. These are NOT user-facing identity labels.

The app's contact trust model is:
1. Scan someone's QR code → you have their public key
2. Compare safety numbers in person → you know the key belongs to them
3. Messages from verified contacts are displayed normally

The trust module's labels (`root`, `delegated`) describe what an entity
can DO in the delegation graph — not how much the user should trust them.
The app should not display these labels to users. Use `VerificationResult`
to decide rendering, not `TrustKind`.

## Relationship to the threat model

The existing threat model (docs/THREAT-MODEL.md) lists 6 adversaries.
This module does not change any of those — it adds a new capability
(authenticated emergency broadcast) that operates within the same
constraints. Specifically:

- **No new network surface**: trust statements travel inside existing
  sealed envelopes, through the same epidemic mesh.
- **No new persistence**: delegation graph is memory-only.
- **No new central authority**: trust is per-user, via subscription.
- **No new metadata on the wire**: signed statements are opaque payloads
  inside sealed envelopes — relays cannot read them.

The one new adversary to document when integrating:

| A7 | Attacker who compromises | Can forge delegations, sign fake |
|    | a subscribed entity's    | emergency broadcasts, validate    |
|    | Ed25519 secret key        | malicious emergencies. Scope is   |
|    |                           | limited to what that entity was   |
|    |                           | authorized to do.                 |

Mitigation: threshold validation (t-of-n) means no single compromised key
can verify a fake emergency. The subscription model lets users unsubscribe
from a compromised entity.
