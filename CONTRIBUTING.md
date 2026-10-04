# Contributing

Thanks for helping. protestchat is security software for people under stress — careful changes matter more than fast ones.

## Before you start

1. Read [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) and [`docs/FORWARD-SECRECY.md`](docs/FORWARD-SECRECY.md) if you touch crypto, mesh, or BLE.
2. Prefer a focused PR that closes one issue over a kitchen-sink patch.

## Setup

```bash
npm install
npm run doctor    # names toolchain fixes
npm test
npm run typecheck
```

Expo Go will not work (custom native BLE). Use a development build:

```bash
npm run android   # or npm run ios
```

## Pull requests

- Keep the diff reviewable; separate unrelated fixes into separate PRs.
- Add or update tests for protocol/crypto/mesh behavior.
- Do not claim new security properties in the README or user site without threat-model updates.
- Fill in the PR template.

## Security reports

Do **not** open a public issue for an exploitable vulnerability. See [`SECURITY.md`](SECURITY.md).

## Code of Conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
