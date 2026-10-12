# Casino Game Image Scraper

Production-oriented scraper for casino game artwork. Images keep their original
dimensions and aspect ratio and are stored as WebP.

## Requirements

- **Node.js >= 22.5** (uses built-in `node:sqlite` / `DatabaseSync`)
- Recommended VPS: **Node 22 LTS** (22.5+)

## Quick start

```bash
cp .env.example .env
npm install
npm run import -- ./data/games.csv --seed --limit 20
npm run scrape -- --source bcgame --missing-only --limit 20
npm run stats
```

## Image server

The server application is isolated in `image-server/`. It has no scraper code,
Playwright, or third-party npm dependencies. On the same VPS it opens the
scraper SQLite database read-only and streams files directly from `images/`.
Newly scraped images are therefore available immediately—there is no export,
manifest, or image-copy step.

```bash
cd image-server
npm test
npm start
```

For deployment, configure `IMAGE_DATABASE_PATH`, `IMAGE_STORAGE_ROOT`, and
`IMAGE_FILES_ROOT` to point to the scraper's shared database and image storage.

## CSV format

Supports both simple and full catalogs:

```text
name,provider
# or
Id,Name,Img,ImgVertical,ImgWide,ImgSquare,ProviderId,...
```

- `Img*` URLs are stored on import
- `seed-images` downloads each URL and saves by **detected** ratio
- Favicon / non-http / `NULL` URLs are skipped

## Commands

```bash
npm run import -- ./data/games.csv
npm run import -- ./data/games.csv --seed --limit 100
npm run seed-images -- --limit 100

# Fill missing types from BC.Game (portrait lobby tiles)
npm run scrape -- --source bcgame --missing-only
npm run scrape -- --source bcgame --type portrait --missing-only

# Fill missing portrait/landscape thumbnails from Betgaliano
npm run scrape -- --source betgaliano --missing-only

# Fill missing square/landscape images from Regency Casino
npm run scrape -- --source regencycasino --missing-only

# Fill missing types from Databetrix game-level image URLs
npm run scrape -- --source databetrix --missing-only

# Fill missing landscapes with composed Grosvenor background + centered logo
npm run scrape -- --source grosvenorcasino --missing-only

# Replace existing types and save all detected Multiwin slot/live variants
npm run scrape -- --source multiwin --overwrite

npm run analyze-source -- --source bcgame --limit 5
npm run retry-failed -- --source bcgame
npm run stats
```

## Sources

| Source | Status | Notes |
|---|---|---|
| `bcgame` | **default** | Paginated `all_games` catalog (~200 HTTP pages once); portrait tiles (~960×1280) |
| `betgaliano` | **enabled** | Modulesports catalog (16 pages at 500/page); thumbnails only (backgrounds excluded) |
| `regencycasino` | **enabled** | Live + slots catalogs; generated 500/350/250 square and rectangular image URLs |
| `databetrix` | **enabled** | Offset-paginated catalog; direct game `img` URLs with detected image type |
| `grosvenorcasino` | **enabled** | Browser-loaded catalog; centered logo composited over an 800px landscape background |
| `multiwin` | **enabled** | Slot + live catalogs; stores every supplied image by detected portrait/square/landscape type |
| `slotsjudge` | optional | Set `SLOTSJUDGE_ENABLED=true` |
| `stake` | disabled | Cloudflare often blocks datacenter IPs |
| `bitcasino` / `slotcatalog` / `casinoguru` | stubs | Not implemented |

## How fill-missing works

1. CSV `Img*` → saved as whatever ratio the bytes actually are  
2. `scrape --source bcgame --type portrait --missing-only` fills missing portraits
3. `scrape --source betgaliano --missing-only` fills missing types from thumbnails
4. `scrape --source regencycasino --missing-only` fills square and landscape images
5. `scrape --source databetrix --missing-only` fills types detected from catalog images
6. `scrape --source grosvenorcasino --missing-only` fills composed landscapes
7. Games that already have that type are skipped

BC.Game artwork is typically **portrait** (3:4). Landscape often comes from CSV `Img`.

On scrape, `bcgame` loads the lobby catalog once (`POST /api/edge/game/home/recommend/item/` with `selectionName=all_games`, `areaCode` from env — `FI` on this VPS), indexes titles in memory, then matches your CSV games locally (no per-game search requests).

`betgaliano` similarly loads `POST /api/MyCasino/SearchGames?siteid=7` with
`slots,live` tags in batches of 500, caches the catalog for 24 hours, and
matches exact normalized titles locally. Downloaded bytes are classified by
their actual aspect ratio and converted to WebP. Use `--missing-only` so an
existing landscape is never replaced.

`regencycasino` loads both `/categories/live` and `/categories/slots`, matches
the human-readable `application_name`, and uses the case-sensitive
`item_title` to construct `gameRes/sq` and `gameRes/rect` image URLs. Untyped
missing-only runs are limited to the square and landscape types this source
actually provides.

`databetrix` loads the DATABETRIX catalog in large offset batches, indexes
titles locally, and downloads only each game record's direct `img` field.
Provider images and empty custom/vertical fields are ignored. By default,
catalog titles missing locally are imported once before the missing-only pass;
set `DATABETRIX_IMPORT_MISSING_GAMES=false` to disable catalog synchronization.

`grosvenorcasino` loads `allGeneralGames` and `allLiveGames` with a headless
browser because direct HTTP requests are blocked by Cloudflare. It combines
each `backgroundLayer.cropUrl` with its transparent `gameLogoLayer.cropUrl`,
scaling the logo to fit and centering it on an 800px-wide background. Exact
normalized-title misses for pending no-image games use the structured search
endpoint as a fallback. The resulting image is stored as landscape WebP.

`multiwin` loads the `casino` and `live_casino` mirror endpoints. Slots use
`background_image`, `cover_image`, and `custom_background_image`; live games
use `background_image` and `cover_image`. Dimensions determine the stored type,
including near-square tiles and extra-wide landscape covers. Use `--overwrite`
to replace an existing image of the same type.
