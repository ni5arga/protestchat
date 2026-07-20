# Forward secrecy

Status: **implemented (signed receive keys), residual limits below.** Addresses GitHub issue #4.

## Approach

Store-and-forward means we cannot run a live Noise/X3DH handshake or Double Ratchet on the message path: sender and recipient are often never online together.

We use **signed receive keys** (Signal “signed prekey” style, without a server):

1. Each device holds a short-lived X25519 **receive key**, rotated about hourly.
2. The current receive public is **signed** by the long-term Ed25519 identity and distributed at introduction via QR **contact code v2**.
3. Direct/group seals ECDH to that receive public (not the long-term `xPublic`) when the sender knows one.
4. The recipient trial-decrypts with the ring of retained receive secrets, then the long-term secret (legacy / no-FS fallback).
5. Secrets older than **6 hours** (`RECEIVE_KEY_RETENTION_MS`, aligned with envelope TTL) are **deleted**. That deletion is the FS step.

Wire layout of sealed payloads is unchanged, so relays still cannot tell modes apart except by length.

## Pitfalls

| Pitfall | Handling |
|--------|----------|
| No key-distribution server | Bundle travels in QR v2 at intro; no automatic refresh until peers meet again |
| QR shown to many people | Same receive public shared — fine for SPK-style keys (not one-time) |
| In-flight mail after rotation | Retain old secrets for 6h before wipe |
| Legacy v1 contact codes | Still accepted; seals fall back to long-term key (**no FS**) until re-scan |
| Trial-decrypt cost | Ring stays small (rotation 1h × retention 6h ≈ handful of secrets) |
| Forged receive keys | Signature required; bad v2 codes rejected entirely |
| Channels / public broadcast | Shared symmetric keys — **no FS** by construction |

## Residuals (not solved)

- **Not per-message FS.** All messages sealed to one receive key fall if that secret is stolen before wipe.
- **No post-compromise security** (no Double Ratchet / healing).
- **Stale peer receive keys.** If Bob rotates and Alice never re-scans, Alice keeps sealing to Bob’s old public until she learns a new one; Bob can still open while he retains the secret, then those messages become unreadable to Bob too (delivery failure, not silent decrypt by attacker).
- **Long-term fallback** remains for compatibility; those messages have no FS.
- **Seized phone while secrets remain** still reads everything (unchanged A6 reality for unlocked devices).
- **Group FS** only as strong as each member’s receive-key state on the sender’s device.

## Follow-ups

- In-band receive-key updates inside sealed messages (refresh without re-meeting).
- Optional one-time prekeys after first contact (stronger FS; careful with QR reuse).
- UI indicator when a conversation is sealing with FS vs long-term fallback.
