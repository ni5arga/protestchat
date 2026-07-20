# Trust module design

## Why

The mesh layer provides transport — phones talking without internet — but no
authenticity. On the public broadcast channel, anyone can claim anything.
A rumour that the protest is cancelled, or a false direction to walk into a
kettle, is indistinguishable from a genuine leadership alert.

This module provides cryptographic authentication of who said what.
Participants subscribe to keys they trust; signed messages from those keys
(or from a delegation chain rooted at those keys) are verifiable. Messages
from unknown or revoked keys are distinguishable from authenticated ones.

## Core mechanism

- **Subscribe** to an entity's Ed25519 public key. They become a trust anchor
  in your local graph.
- **Delegations** let that entity certify other keys with specific scopes
  (certify, announce, validate). Trust flows through the chain, always
  traceable back to a key you subscribed to.
- **Verified announcements** carry the signer's identity and chain. The
  integration layer can badge them differently from unsigned messages.
- **Emergency threshold**: anyone can broadcast an emergency. The engine
  returns `pending-emergency`; the integration layer decides whether to
  display it immediately with a pending indicator or hide it until the
  threshold is met. It transitions to `verified-emergency` once N subscribed
  validators counter-sign it (proof of possession required — validations
  are Ed25519-signed).
- **Revocation**: a compromised key can be revoked by its delegator or by
  any entity with certify scope along the same chain.

## Design constraints

- **Memory-only graph**: delegations are never persisted. On restart the
  graph is rebuilt from signed statements received over the mesh. Prevents
  a seized phone from revealing the authorization hierarchy.
- **No pre-loaded roots**: `PRELOADED_ROOTS` is empty. Users subscribe to
  trust anchors at runtime, the same way they add any contact.
- **Subscription model**: every user curates their own trust graph. There is
  no global authority.
- **Trust kinds are engine-internal**: `root`/`delegated`/`direct`/`none`
  describe where an entity sits in the delegation graph. The `VerificationResult`
  status is what the app uses for rendering, not the trust kind.

## Relationship to the threat model

Existing adversaries (A1–A6) are unchanged — the module operates within the
same mesh constraints (no new network surface, no new metadata on the wire,
no new persistence). New adversary:

| A7 | Attacker who compromises a subscribed entity's Ed25519 secret key | Can forge delegations and announcements within that entity's scope. Threshold validation limits damage — no single key can verify an emergency alone. |
