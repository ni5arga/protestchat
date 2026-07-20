# Threat model

Written before the crypto, as promised. If you are reviewing this project, start here — a finding against this document is worth more than a finding against the code.

Status: **draft, unaudited.** No independent security review has happened. Do not present this app to anyone as safe until that changes.

## Who this is for

Someone at a protest or in a shutdown zone who needs to reach specific people they already know, when the cellular network is unavailable — either because an ISP-level suspension was ordered, or because a portable jammer is running nearby.

They are not a security expert. They are probably stressed, possibly moving, and holding the phone one-handed.

## What we are defending against

| # | Adversary | Capability | Our answer |
|---|---|---|---|
| A1 | Network operator / state | Orders a regional internet suspension | Never touch the internet. Device-to-device only. |
| A2 | Police with a portable jammer | Denies 3G/4G/5G in a radius | Operate on 2.4 GHz BLE, which those jammers do not target |
| A3 | Passive radio observer in the crowd | Records all BLE traffic | Payloads sealed; no sender, recipient, or content on the wire; sizes padded to buckets |
| A4 | Malicious participant | Runs the app, is a legitimate mesh peer, relays everything | Cannot decrypt what they relay; cannot attribute it; cannot forge a sender |
| A5 | Someone who hands you a fake contact code | Attempts MITM at introduction | In-person safety-number comparison; contact shown as **Unverified** until done |
| A6 | Phone seized after the fact | Reads storage | 6-hour TTL on everything, panic wipe, no cloud backup of the key |

## What we explicitly do NOT defend against

Stated plainly, and repeated inside the app on the Settings screen:

- **A seized unlocked phone.** There is no defence. Everything is readable.
- **Radio-frequency direction finding.** BLE is a radio. A well-equipped adversary can determine that *a device here is transmitting*, and can follow it, without breaking any cryptography. This is the single largest unsolved gap.
- **Traffic-confirmation over time.** An observer who records the mesh for hours and correlates who was present when messages moved can make statistical guesses about who talks to whom. Epidemic routing raises the cost but does not eliminate it.
- **Coercion.** Rubber-hose decryption works.
- **A malicious build.** Reproducible builds are not implemented. If you did not build it yourself, you are trusting whoever did.
- **Shoulder-surfing.** No hidden-message or decoy mode yet.

## Three modes, three threat models

The app has three ways to send, and conflating them is the most likely way it gets someone hurt. `src/lib/conversation.ts` derives the mode in one place and every screen renders its warning verbatim.

| Mode | Who can read it | Confidentiality | Sender authenticated |
|---|---|---|---|
| **Public broadcast** | Everyone in range, including a hostile phone running this app | **None.** Hardcoded key shipped in every install | Yes |
| **Channel** | Anyone holding the passphrase, including retroactively | Only as strong as the passphrase | Yes, within the channel |
| **Closed group** | The members you added, individually | Full | Yes |
| **Direct** | One person | Full | Yes |

**Channels have no owner, no admin, and no kick.** This is a direct response to BitChat, where privileged channel commands were validated only by the issuing client, letting any member seize a channel or strip its encryption. A construct with no privileged operations has none to forge. The accepted cost is that anyone with the key can flood a channel and cannot be removed; the answer is a new channel with a new passphrase.

**Channel key derivation** is scrypt (N=2^14) over the passphrase, salted with the channel name. Paid once at join and cached, so it is never on a message path. It is a compromise: it raises the cost of an offline dictionary attack on recorded traffic but does not rescue a genuinely weak passphrase. **Argon2id via a native binding is the single cheapest security upgrade available to this codebase.**

**Groups are fan-out** — one independently sealed copy per member, no group key. This means no rekeying problem and no group-membership cryptography to get wrong; removing someone is simply not sending to them. Membership is local, so two members can disagree about who is in a group. Injection is jittered over 0–3s because N envelopes leaving one device simultaneously reveals group size to an observer who cannot decrypt anything.

## Cryptographic design

**Identity.** One 32-byte seed in the OS keystore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, excluded from cloud backup). Ed25519 signing key is the seed directly; the X25519 agreement key is HKDF-derived from it. One secret to protect, one secret to wipe.

**Sealing.** Non-interactive, because store-and-forward means sender and recipient are frequently never online simultaneously:

```
eph        = X25519 keygen (fresh per message)
shared     = X25519(eph.secret, recipient.xPublic)
key        = HKDF-SHA256(shared, salt = eph.public || recipient.xPublic,
                         info = "protestchat/v1/seal")
signature  = Ed25519.sign("protestchat/v1/sender-auth" || eph.public
                          || recipient.xPublic || body,  sender.edSecret)
inner      = sender.edPublic || sender.xPublic || signature || body
wire       = eph.public || nonce(24) || XChaCha20-Poly1305(key, nonce, inner)
```

Three deliberate choices:

1. **The signature is inside the ciphertext.** Relays therefore cannot attribute a message to a sender. The cost is that relays cannot filter spam by identity — see the open problem below.
2. **The recipient's key is bound into both the KDF salt and the signed transcript.** A ciphertext cannot be re-addressed, and a signature cannot be lifted into a different envelope.
3. **No recipient field anywhere.** Devices find their own mail by trial decryption. This is more expensive and is the correct trade.

**Known weakness — no forward secrecy.** Compromise of a recipient's long-term X25519 secret decrypts every recorded past message to them. Fixing this requires a ratchet, which requires liveness we do not have. Currently mitigated only by the 6-hour TTL. **This is the top item for review.**

## Metadata handling

| Exposed | Mitigation |
|---|---|
| Display name | **Not exposed.** Local-only label; the BLE transport never advertises or transmits it (peers see only the rotating tag). Was previously advertised under Google Nearby; that path is gone. |
| Message size | Padded to 256 B / 512 B / … / 16 KiB buckets |
| Timestamp | Rounded down to 60 s |
| Hop count | Visible, capped at 6 |
| Group size | Hidden by jittered fan-out injection (0–3 s) |
| Conversation mode | Hidden — direct and channel layouts differ only in length, and there is no discriminator byte on the wire |
| Envelope id | Random, unlinkable to sender or recipient |
| BLE advertising tag | Rotated every 15 min from fresh CSPRNG bytes, not derivable across rotations. No name and no key material is ever advertised. |

## Open problems

1. **Forward secrecy.** As above. The most valuable thing a cryptographer could help with.
2. **Rotating endpoint identifiers — largely addressed, unverified on hardware.** This was the single strongest reason to drop Google Nearby, which gave no control over its advertisement. We now own the radio (`modules/ble-mesh`) and rotate the advertised tag every 15 minutes from fresh CSPRNG bytes, with no counter or hash chain linking one to the next, and no display name or key material in the advertisement at all. Peer identity is established in-band via HELLO instead.

   What remains unproven: whether stopping and restarting advertising actually prompts each OS to re-randomise the link-layer BLE address. That is the only lever an app has, and it is not a guarantee. **Someone with a BLE sniffer and two phones could settle this in an afternoon, and it would be a genuinely valuable contribution.**
3. **Sybil resistance.** Identities are free, so per-identity rate limits are worthless. One device can present as hundreds and flood the mesh. Candidates: proof-of-work on send, web-of-trust relay budgets. Unsolved.
4. **iOS background operation.** iOS suspends BLE aggressively. A relay that only works with the screen on is a much weaker relay.
5. **Duress / decoy mode.** Panic wipe exists; a duress PIN opening a plausible decoy does not.
6. **Reproducible builds.**
7. **Channel passphrase strength.** No strength meter, no enforced minimum. At a protest passphrases spread by shouting and will be weak.

## Fixed

- **Message replay (found 20 Jul 2026, security audit).** Dedup was only on the random outer envelope id, which a replay attacker simply regenerates — so a captured ciphertext, re-wrapped in a fresh envelope id, was re-decrypted and filed as a new message. A months-old "we move at nine" could be resurrected at will. Now each device also dedups on a hash of the *decrypted* body (`seen_messages` in `db.ts`), so an exact replay is dropped while genuine resends (fresh per-message id) are unaffected.

- **Display name was documented as broadcast, but is not (found 20 Jul 2026, security audit).** Under the old Nearby transport the name was advertised; the BLE transport never transmits it (peers see only the rotating tag). The Settings hint and the metadata table above claimed it was "broadcast in the clear," a false statement about what the app leaks. Corrected in both.

- **In-memory keys outlived a wipe (found 20 Jul 2026, security audit).** `mesh.stop()` cleared peers but left `identity` and cached channel keys live in the engine; panic wipe erased disk but the process still held the keys. `stop()` now drops those references. (JS cannot zero memory, so the seized-unlocked-phone case remains out of scope.)

- **Android auto-backup was uploading the message database (found 20 Jul 2026).** `allowBackup` defaulted to true, so Android's automatic backup would copy the SQLite database — every message, contact and channel key — to the user's Google Drive. That silently recreated the exact thing this design exists to avoid: a copy on a third-party server, subject to subpoena, outliving the 6-hour TTL and surviving a panic wipe. Now `allowBackup: false` in `app.json`.

- **Google Nearby Connections removed as the transport (20 Jul 2026).** On iOS it only ever brings up the Wi-Fi LAN medium, requiring both phones to already share a Wi-Fi network — no use whatsoever in a jammed square with no infrastructure. Replaced with our own CoreBluetooth / BLE GATT transport, which also made identifier rotation possible for the first time (see open problem 2).

- **Unauthenticated TTL (found 20 Jul 2026).** The outer header is unauthenticated by necessity — relays mutate `hopCount` and cannot verify a signature sealed inside the ciphertext — so a hostile relay could rewrite `ttlSeconds` upward and make every phone in the mesh hoard a message far past its sender's intent, defeating the expiry defence above. Fixed without cryptography: each device now caps retention from *first sight* (`MAX_LOCAL_RETENTION_MS` in `db.ts`), which an attacker cannot forge.

## Reporting

Open an issue, or contact the maintainers privately if you would rather. Findings will be published with credit. We would much rather hear it from you than from a paper written after people relied on this.
