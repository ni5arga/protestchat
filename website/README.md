# User guide site (Astro Starlight)

Plain-language documentation for people installing and using protestchat. Source of truth lives in this repo (`website/`) so user copy can move with the app (#11).

## Develop

```bash
cd website
npm install
npm run dev
```

## Build

```bash
cd website
npm run build    # output in website/dist
npm run preview
```

## Publish

Hosting / Cloudflare Pages / domain is tracked in **#61** (needs maintainer co-ordination). Until then, build `dist/` locally or attach CI later.

## Content rules

- Keep pages short enough to skim under stress
- Mode warnings must stay aligned with `src/lib/conversation.ts` / `src/i18n/en.ts`
- Do not invent stronger security claims than `docs/THREAT-MODEL.md`
