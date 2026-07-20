# Forward secrecy

Status: **per-message FS for direct/group via one-time prekeys**, with mesh e2e coverage. Addresses GitHub issue #4.

## Approach

Store-and-forward rules out a live Double Ratchet on every path (parties are often never online together). We use an X3DH-shaped design **without a key server**:

1. **Signed prekey (SPK)** — medium-term X25519 key, rotated ~hourly, retained 6h, signed by the long-term Ed25519 identity.
2. **One-time prekeys (OTKs)** — X25519 keys issued per peer (or for a single QR intro). Sender seals to an OTK public; recipient **deletes the OTK secret on successful open**. That delete is per-message forward secrecy.
3. **Distribution**
   - **QR contact code v2:** SPK + 24 OTK publics.
   - **In-band:** every sealed direct/group/receipt body may carry a `prekeys` update (fresh SPK + OTKs dedicated to that peer) so conversations replenish without re-meeting.
4. **Seal preference:** unused peer OTK → SPK → long-term identity (legacy / no FS).
5. **Open:** trial-decrypt with OTK secrets, then SPK ring, then long-term.

Wire layout of sealed payloads is unchanged (relays still cannot tell modes apart except by length).

## Guarantees

| Claim | Held? |
|------|-------|
| After an OTK is consumed, compromise of the recipient’s long-term identity seed cannot open that ciphertext | **Yes** (unit + mesh e2e) |
| Two seals do not reuse the same OTK public | **Yes** |
| OTKs issued to peer A are not issued to peer B | **Yes** |
| Long conversations stay on OTKs via receipt/message replenishment | **Yes** (mesh e2e, 40 messages) |
| Relays cannot read OTK-sealed mail | **Yes** (mesh e2e) |
| Channels / public broadcast | **No FS** (shared symmetric key) |
| Post-compromise security / Double Ratchet healing | **No** |
| Legacy v1 contact codes | Fall back to long-term (**no FS**) until re-scan |

## Pitfalls

| Pitfall | Handling |
|--------|----------|
| No key server | QR + in-band replenishment |
| Same QR scanned by two people | Shared intro OTK set — second sealer loses if first consumed; prefer one intro pair, then in-band |
| In-flight after SPK rotation | SPK ring retained 6h |
| Trial-decrypt cost | Small OTK+SPK set per device |
| Forged prekeys | SPK signature required; bad bundles rejected |

## Tests

- `src/lib/__tests__/forward-secrecy.test.ts` — OTK consume, replenish, per-peer isolation, 100-message stress
- `src/lib/__tests__/mesh.test.ts` → `forward secrecy (mesh e2e)` — introduce, deliver, compromise, replenish, group, relay

## Residuals

- No Double Ratchet / PCS after device compromise while keys remain live.
- Channel and public modes cannot have FS under a shared passphrase/key.
- UI does not yet show whether a conversation is sealing with OTK vs SPK vs long-term.
- SPK-only messages (OTK pool empty and no replenishment yet) have weaker FS (window = SPK lifetime).
