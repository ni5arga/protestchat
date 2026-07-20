# Forward secrecy

Status: **per-message FS for direct/group via one-time prekeys**, with mesh e2e coverage. Addresses GitHub issue #4.

## Approach

Store-and-forward rules out a live Double Ratchet on every path (parties are often never online together). We use an X3DH-shaped design **without a key server**:

1. **Signed prekey (SPK)** — medium-term X25519 key, rotated ~hourly, retained 6h, signed by the long-term Ed25519 identity.
2. **One-time prekeys (OTKs)** — X25519 keys issued **per peer** in-band. Sender seals to an OTK public; recipient **deletes the OTK secret on successful open**. That delete is per-message forward secrecy.
3. **Distribution**
   - **QR contact code v2:** signed SPK only (no OTKs). A plaque is multi-scan; OTKs on a QR would silently undeliver every sealer after the first consume.
   - **In-band:** every sealed direct/group/receipt body may carry a `prekeys` update (fresh SPK + OTKs dedicated to that peer) so conversations replenish without re-meeting.
4. **Seal preference:** unused peer OTK → SPK → long-term identity (legacy / no FS).
5. **Open:** trial-decrypt with newest OTK secrets (capped), then SPK ring, then long-term.

Wire layout of sealed payloads is unchanged (relays still cannot tell modes apart except by length).

## Guarantees

| Claim | Held? |
|------|-------|
| After an OTK is consumed, compromise of the recipient’s long-term identity seed cannot open that ciphertext | **Yes** (unit + mesh e2e) |
| Two seals do not reuse the same OTK public | **Yes** |
| OTKs issued to peer A are not issued to peer B | **Yes** |
| Two scanners of the same QR can both deliver (via SPK) | **Yes** |
| Long conversations stay on OTKs via receipt/message replenishment | **Yes** (mesh e2e, 40 messages) |
| Relays cannot read OTK-sealed mail | **Yes** (mesh e2e) |
| Channels / public broadcast | **No FS** (shared symmetric key) |
| Post-compromise security / Double Ratchet healing | **No** |
| Legacy v1 contact codes | Fall back to long-term (**no FS**) until re-scan |

## Pitfalls

| Pitfall | Handling |
|--------|----------|
| No key server | QR SPK + in-band OTK replenishment |
| Same QR scanned by two people | SPK only on QR — both deliver; OTKs are exclusive in-band |
| In-flight after SPK rotation | SPK ring retained 6h |
| Trial-decrypt cost | OTK pool ceiling (24) + `OPEN_SECRET_CAP` (28); newest-first |
| Forged prekeys | SPK signature required; bad bundles rejected |

## Trial-decrypt cost

Every sealed envelope on the air is tried against every agreement secret we hold (opacity: no prekey-id hint). With the ceiling above, worst case is ~28 X25519 ops + AEAD fails per envelope before the long-term try — see the `trial-open cost` unit test for a host-side measurement. A flooder can still amplify this into battery drain; ingress budgets remain a separate hardening track.

## Tests

- `src/lib/__tests__/forward-secrecy.test.ts` — OTK consume, replenish, per-peer isolation, multi-scan QR, cost, stress
- `src/lib/__tests__/mesh.test.ts` → `forward secrecy (mesh e2e)` — introduce, deliver, compromise, replenish, group, relay

## Residuals

- No Double Ratchet / PCS after device compromise while keys remain live.
- Channel and public modes cannot have FS under a shared passphrase/key.
- UI does not yet show whether a conversation is sealing with OTK vs SPK vs long-term.
- First post-QR message (and SPK fallback when the peer OTK pool is empty) has weaker FS (window = SPK lifetime).
- Flood / trial-decrypt DoS is bounded but not eliminated; needs mesh ingress limits.
