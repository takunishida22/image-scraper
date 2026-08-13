# Casino Game Image Scraper

Production-oriented scraper for **source-native** casino game artwork. Images are saved exactly as downloaded — never resized, cropped, re-encoded, or aspect-ratio converted.

## Requirements

- **Node.js >= 22.5** (uses built-in `node:sqlite` / `DatabaseSync`)
- Recommended VPS: **Node 22 LTS** (22.5+)

## Quick start

```bash
cp .env.example .env
npm install
npx playwright install chromium   # only needed for browser fallback sources
npm run import -- ./data/games.csv
npm run smoke
npm test
```

## Commands

```bash
npm run import -- ./data/games.csv
npm run analyze-source -- --source slotsjudge --limit 5
npm run scrape -- --source slotsjudge --limit 50
npm run analyze-source -- --source stake --limit 50
npm run scrape -- --source stake --missing-only --limit 50
npm run scrape -- --type portrait --missing-only
npm run retry-failed -- --source stake --type portrait
npm run stats
```

## Architecture

Pluggable source adapters under `src/sources/`. Core scraper never hard-codes site names; adapters expose `implemented` / `enabled` plus optional `init()` / `close()` for browser reuse.

Images are stored as:

```text
images/<slug>__<gameId>/<ratio>.<ext>
```

`ext` comes from actual image bytes (Sharp metadata), not the remote URL.

## SlotsJudge (default reachable source)

`slotsjudge.com` is reachable from datacenter IPs. Use it when Stake is Cloudflare-blocked:

```bash
npm run scrape -- --source slotsjudge --limit 50
```

Artwork is mostly landscape gameplay / key art, not Stake lobby portraits. Omit `--type portrait` so landscape images can be saved.

## Stake notes

Stake is behind Cloudflare. Casino search uses public GraphQL (`/_api/graphql`) — **`STAKE_ACCESS_TOKEN` is not required**.

`STAKE_CF_CLEARANCE` only works when **all** of these match the browser that solved Cloudflare:

1. The **same public IP** that runs the scraper
2. The **same User-Agent** (`STAKE_USER_AGENT`)
3. A cookie that has not expired

A cookie copied from your laptop will not work on this VPS. Either run the scraper on that laptop, or set `STAKE_PROXY` so traffic exits an allowed IP.

```env
STAKE_CF_CLEARANCE=
STAKE_USER_AGENT=
STAKE_COOKIES=
STAKE_PROXY=
STAKE_ACCESS_TOKEN=
```
