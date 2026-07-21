---
title: What this will not do
description: Honest limits — unaudited software, Bluetooth reality, and threat gaps.
---

import { Aside } from '@astrojs/starlight/components';

<Aside type="danger" title="Above the fold">
This will **not** make you invisible. Bluetooth can be observed. A wrong mode can expose your words. The code is **not** independently audited. Plan as if a sophisticated opponent may still hurt you.
</Aside>

## Will not protect you from

| Risk | Reality |
| --- | --- |
| Being seen using a phone | A radio is a beacon. Presence can be noticed. |
| Typing into the wrong mode | Everyone nearby is readable by anyone with the app. |
| A seized unlocked phone | Whatever is on screen or in memory may be readable until wipe completes. |
| Background relaying | Relaying while the app is backgrounded is best-effort / incomplete. Keep it open when it matters. |
| Perfect anonymity | Epidemic relay and local history still leave traces on devices. |
| “The app said encrypted, so I’m fine” | Encryption is one layer. Behavior and mode choice decide outcomes. |

## Honest product status

- **Pre-alpha.** Features and guarantees change quickly.
- **Unaudited.** Crypto and mesh have known open issues; some are tracked on GitHub.
- **Platforms.** Android is the main path. Cross-phone and iOS behavior need real-device proving.
- **No company support line.** If it fails at a critical moment, have a fallback plan.

## Technical depth

Builders and reviewers should read the in-repo [threat model](https://github.com/ni5arga/protestchat/blob/main/docs/THREAT-MODEL.md) and [forward secrecy notes](https://github.com/ni5arga/protestchat/blob/main/docs/FORWARD-SECRECY.md). This guide stays short on purpose.
