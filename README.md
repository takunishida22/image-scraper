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

## Stake notes

Stake is often behind Cloudflare. Prefer HTTP/GraphQL; Playwright is a reused-browser fallback. On blocked networks set:

```env
STAKE_PROXY=
STAKE_CF_CLEARANCE=
STAKE_ACCESS_TOKEN=
```
