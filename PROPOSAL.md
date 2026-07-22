# Proposal: an off-grid, jammer-resistant messenger — looking for holes in this

**tl;dr** — Delhi Police deployed portable cellular jammers at Jantar Mantar today (20 Jul) on top of a mobile internet restriction. The jammers only hit 3G/4G/5G bands. 2.4 GHz is untouched. That gap is a real design opening and I want to build into it. Roasting my threat model is more useful to me than agreement.

## What actually happened

- CJP's march to Parliament today: mobile internet restricted across parts of Central Delhi, and **portable jammers** deployed around Jantar Mantar. People reported walking ~2 km to get a bar of signal.
- IFF's point: **no suspension order was published.** Nobody knows which authority ordered it, on what grounds, or for how long — which is exactly what *Anuradha Bhasin* and the Telecom Suspension Rules were supposed to prevent.
- This is not a one-off. India ran 84 shutdowns in 2025 (~28% of the global total, per Access Now / #KeepItOn). SFLC's tracker has the full history since 2012.

## The technical opening

The reporting on the jammers says they interfere with **3G/4G/5G only**. They do not touch:

- Bluetooth LE (2.4 GHz)
- Wi-Fi Direct / Wi-Fi Aware (2.4/5 GHz)
- device-to-device generally

So a phone at Jantar Mantar today was cut off from the internet but was still perfectly capable of talking to the phone next to it. Nobody had an app to do it.

**Two distinct threats, and they need different answers:**

| | ISP/telco shutdown | Portable RF jammer |
|---|---|---|
| Scope | district / state, hours–weeks | ~100s of metres, hours |
| Kills | all cellular data | cellular in a bubble |
| Beaten by | any local transport | any non-cellular transport |
| Bonus | — | a phone 2 km out is a working uplink |

That second row matters: with a jammer, the *edge of the bubble is a gateway*. Store-and-forward means a message can ride in someone's pocket out of the jammed zone and hit the real internet when they clear it. That's a feature worth designing for explicitly, not an accident.

## What I want to build

One Expo/React Native app, ~85% shared TypeScript, with a thin native module per platform for the radio.

```
┌─────────────── shared TypeScript ───────────────┐
│  UI · SQLite store · crypto · dedup · relay      │
├──────────────────────┬───────────────────────────┤
│  Swift (iOS)         │  Kotlin (Android)         │
│  Nearby Connections  │  Nearby Connections       │
└──────────────────────┴───────────────────────────┘
         BLE / Wi-Fi Direct — no tower, no ISP
```

Google Nearby Connections ships on **both** iOS and Android, which is why it beats Multipeer Connectivity (Apple-only, so no Android peers — and Apple is pushing people to Network framework anyway).

Deliberately **not** in the native layer: any chat logic. Native does advertise / discover / connect / send bytes / receive bytes. Everything else — envelopes, dedup, hop limits, expiry, receipts, keys — lives in TypeScript so there's exactly one implementation to audit.

Milestone 1 is embarrassingly small on purpose: **two phones, airplane mode, "hello" arrives.** No mesh, no relay, no crypto. Prove the transport cross-platform first.

## Where I need the brainstorming

**1. Crypto — how do we not become Bridgefy?**
Bridgefy was *the* protest app in Hong Kong and during the CAA protests, and the Royal Holloway paper (eprint 2021/214) took it apart: deanonymisation, social-graph extraction, impersonation, MITM, network-wide DoS. They bolted on Signal Protocol afterwards and a 2022 follow-up showed they'd done that wrong too. People used it *at protests* while it was broken.

My leaning: X25519 + XChaCha20-Poly1305, Ed25519 identity, Noise-style handshake, safety numbers you verify in person. But "roll a protocol" is how you get owned. Is there a reviewed off-the-shelf option — Briar's BTP? MLS for groups? Something that survives a store-and-forward mesh where the sender may never be online at the same time as the recipient?

**2. Metadata is the actual threat, not content.**
Nobody at a protest gets arrested because their ciphertext was cracked. They get arrested because a BLE advertisement is a persistent identifier that puts a device at a place at a time. Rotating ephemeral IDs, à la the COVID exposure-notification schemes? Padding all packets to fixed size? Random relay jitter so timing doesn't reveal the origin hop? How much cover traffic before battery becomes the limiting factor?

**3. Sybil / flooding.**
Open mesh, no gatekeeper. One phone can pretend to be 500 peers and drown the network. Rate limits per identity are useless when identities are free. Proof-of-work on send? Web-of-trust so unvouched peers get a small slice of relay budget? This one I have the least conviction on.

**4. Panic/duress.**
Phones get taken and unlocked — sometimes by force. Instant local wipe, aggressive message TTL, a duress PIN that opens an innocuous decoy. What has actually held up in the field, versus what merely sounds good?

**5. iOS background.**
The killer. iOS aggressively suspends BLE in background. A relay only helps if it works with the phone in a pocket and the screen off. Does anyone have real-world numbers on background Nearby Connections / Core Bluetooth state-restoration behaviour on current iOS?
`
**6. Should this even be an app?**
Honest question. An app store listing is a chokepoint and a "possession = intent" artifact. Sideloaded APK? PWA (no, WebBluetooth can't do this)? Meshtastic + LoRa gets kilometres of range and totally sidesteps cellular, but needs hardware nobody has in their pocket. Is phone-only the right call, or is it just the *convenient* one?

## Ground rules

- **MIT, public repo from commit one.** Permissive on purpose — fork it, rename it, ship it to people who need it without asking me. Reach matters more here than control.
- **No accounts, no phone numbers, no server.** Nothing to subpoena, nothing to seize.
- Threat model written down *before* the crypto, and if a security researcher wants to break it, I'll take the finding and the credit split.
- Ships with an honest limitations section. "May not protect you against a state adversary" printed in the app, not buried in a README.

## Ask

Tear into it. Most valuable to me right now, in order:

1. Anyone who has shipped **cross-platform Nearby Connections** — what broke?
2. Anyone with **applied-crypto** background who'll sanity-check the handshake before I write it, not after
3. Anyone who's been in a **shutdown or jammed protest** — what did people actually do? What would they have used?
4. Anyone who wants to write the **threat model doc** with me

Scaffold is up. Milestone 1 in about a week. Reply here or DM.

---

### Sources
- Internet shutdown at Delhi Jantar Mantar protest march — https://www.medianama.com/2026/07/223-internet-shutdown-delhi-jantar-mantar-protest-march/
- What are the jammers Delhi Police is using at Jantar Mantar — https://www.digit.in/news/general/what-are-the-jammers-delhi-police-is-using-at-jantar-mantar-during-cjp-protests-and-how-do-they-work.html
- Lathicharge, chaos ahead of CJP's march; mobile internet restricted — https://www.ibtimes.co.in/lathicharge-by-cops-chaos-ahead-cjps-march-parliament-mobile-internet-services-have-been-904021
- SFLC.in Internet Shutdowns Tracker — https://internetshutdowns.in/
- Access Now / #KeepItOn, *Rising repression meets global resistance: shutdowns in 2025* — https://www.accessnow.org/issue/internet-shutdowns/
- *Mesh Messaging in Large-scale Protests: Breaking Bridgefy* — https://eprint.iacr.org/2021/214
- Google Nearby Connections (iOS + Android) — https://developers.google.com/nearby/connections/swift/get-started
