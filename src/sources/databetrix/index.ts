import fs from "node:fs";
import path from "node:path";
import { config, getSourceConfig } from "../../config/index.js";
import { normalizeGameName } from "../../core/normalizer.js";
import { importGames, listGames } from "../../database/db.js";
import type {
  GamePageResult,
  GameRecord,
  ImageCandidate,
  SearchResult,
} from "../../types.js";
import { fetchJson, HttpError } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";
import type { GameImageSource } from "../SourceAdapter.js";

interface DatabetrixProvider {
  name?: string;
}

interface DatabetrixGame {
  id?: string;
  name?: string;
  img?: string | null;
  img_custom?: string | null;
  img_vertical?: string | null;
  is_deleted?: boolean;
  provider?: DatabetrixProvider | null;
  _alternatives?: DatabetrixGame[];
}

interface DatabetrixCatalogResponse {
  total?: number;
  data?: DatabetrixGame[];
}

interface CatalogCacheFile {
  fetchedAt: number;
  gameSource: string;
  total: number;
  pages: number;
  results: SearchResult[];
}

function catalogUrl(limit: number, offset: number): string {
  const url = new URL(config.databetrix.apiUrl);
  url.searchParams.set("gameSource", config.databetrix.gameSource);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  return url.toString();
}

function cleanImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function toSearchResult(game: DatabetrixGame): SearchResult | null {
  const title = game.name?.trim();
  const image = cleanImageUrl(game.img);
  const id = game.id?.trim();
  if (!title || !image || !id || game.is_deleted === true) return null;

  return {
    title,
    provider: game.provider?.name?.trim() || null,
    slug: id,
    url: `${config.databetrix.apiUrl}#game-${encodeURIComponent(id)}`,
    thumbnailUrl: image,
    raw: game as unknown as Record<string, unknown>,
  };
}

async function fetchCatalogPage(
  offset: number,
): Promise<{ total: number; games: DatabetrixGame[] }> {
  const response = await fetchJson<DatabetrixCatalogResponse>(
    catalogUrl(config.databetrix.pageSize, offset),
    {
      headers: {
        accept: "application/json",
        origin: "https://demo.databetrix.com",
        referer: "https://demo.databetrix.com/",
      },
      label: `databetrix-catalog-o${offset}`,
      retries: 2,
    },
  );
  if (!Array.isArray(response.data)) {
    throw new Error(`databetrix_catalog_invalid_response:${offset}`);
  }
  return {
    total: response.total ?? 0,
    games: response.data,
  };
}

function candidatesFromGame(game: DatabetrixGame): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();
  for (const variant of [game, ...(game._alternatives ?? [])]) {
    const image = cleanImageUrl(variant.img);
    if (!image || seen.has(image)) continue;
    seen.add(image);
    let filename: string | null = null;
    try {
      filename = new URL(image).pathname.split("/").pop() ?? null;
    } catch {
      filename = image.split("/").pop() ?? null;
    }
    candidates.push({
      url: image,
      alt: variant.name ?? game.name ?? null,
      filename,
      context: "databetrix.game-tile",
      sourceHint: "databetrix-thumbnail",
    });
  }
  return candidates;
}

let catalogByName: Map<string, SearchResult[]> | null = null;
let catalogLoadPromise: Promise<void> | null = null;
let catalogMeta: { total: number; pages: number; results: number } | null = null;

function buildIndex(results: SearchResult[]): Map<string, SearchResult[]> {
  const index = new Map<string, SearchResult[]>();
  for (const result of results) {
    const key = normalizeGameName(result.title);
    if (!key) continue;
    const bucket = index.get(key);
    if (bucket) {
      if (!bucket.some((item) => item.url === result.url)) bucket.push(result);
    } else {
      index.set(key, [result]);
    }
  }
  return index;
}

function readDiskCache(): CatalogCacheFile | null {
  try {
    if (!fs.existsSync(config.databetrix.catalogCachePath)) return null;
    const cache = JSON.parse(
      fs.readFileSync(config.databetrix.catalogCachePath, "utf8"),
    ) as CatalogCacheFile;
    if (!cache?.results?.length || !cache.fetchedAt) return null;
    if (cache.gameSource !== config.databetrix.gameSource) return null;
    if (
      Date.now() - cache.fetchedAt >
      config.databetrix.catalogCacheTtlMs
    ) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function writeDiskCache(cache: CatalogCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(config.databetrix.catalogCachePath), {
      recursive: true,
    });
    fs.writeFileSync(config.databetrix.catalogCachePath, JSON.stringify(cache));
  } catch (error) {
    logger.warn(
      `Databetrix catalog cache write failed: ${(error as Error).message}`,
    );
  }
}

async function fetchCatalog(): Promise<{
  total: number;
  pages: number;
  results: SearchResult[];
}> {
  const first = await fetchCatalogPage(0);
  const apiPages = Math.max(
    1,
    Math.ceil(first.total / config.databetrix.pageSize),
  );
  const pages =
    config.databetrix.catalogMaxPages > 0
      ? Math.min(apiPages, config.databetrix.catalogMaxPages)
      : apiPages;
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const append = (games: DatabetrixGame[]) => {
    for (const game of games) {
      const result = toSearchResult(game);
      if (!result || seen.has(result.url)) continue;
      seen.add(result.url);
      results.push(result);
    }
  };

  append(first.games);
  logger.info(
    `Databetrix catalog: ${first.total} games, fetching ${pages}/${apiPages} pages (pageSize=${config.databetrix.pageSize})`,
  );
  for (let page = 1; page < pages; page += 1) {
    const offset = page * config.databetrix.pageSize;
    const batch = await fetchCatalogPage(offset);
    append(batch.games);
    logger.info(
      `Databetrix catalog progress: page ${page + 1}/${pages} (${results.length} games)`,
    );
    if (batch.games.length === 0) break;
  }

  return { total: first.total, pages, results };
}

async function loadCatalog(): Promise<void> {
  if (catalogByName) return;
  if (catalogLoadPromise) return catalogLoadPromise;

  catalogLoadPromise = (async () => {
    const cached = readDiskCache();
    if (cached) {
      catalogByName = buildIndex(cached.results);
      catalogMeta = {
        total: cached.total,
        pages: cached.pages,
        results: cached.results.length,
      };
      logger.info(
        `Databetrix catalog cache hit: ${cached.results.length} games (${catalogByName.size} titles)`,
      );
      return;
    }

    const catalog = await fetchCatalog();
    catalogByName = buildIndex(catalog.results);
    catalogMeta = {
      total: catalog.total,
      pages: catalog.pages,
      results: catalog.results.length,
    };
    if (config.databetrix.catalogMaxPages <= 0) {
      writeDiskCache({
        fetchedAt: Date.now(),
        gameSource: config.databetrix.gameSource,
        total: catalog.total,
        pages: catalog.pages,
        results: catalog.results,
      });
    }
    logger.info(
      `Databetrix catalog ready: ${catalog.results.length} games → ${catalogByName.size} unique titles`,
    );
  })();

  try {
    await catalogLoadPromise;
  } catch (error) {
    catalogLoadPromise = null;
    catalogByName = null;
    throw error;
  }
}

function importMissingCatalogGames(): void {
  if (!catalogByName || !config.databetrix.importMissingGames) return;

  const existingNames = new Set(
    listGames().map((game) => normalizeGameName(game.name)),
  );
  const rows: Array<{
    name: string;
    provider: string | null;
    externalId: string;
    imgUrl: string | null;
  }> = [];

  for (const [normalizedName, results] of catalogByName) {
    if (existingNames.has(normalizedName)) continue;
    const result = results[0];
    if (!result) continue;
    existingNames.add(normalizedName);
    rows.push({
      name: result.title,
      provider: result.provider ?? null,
      externalId: `databetrix:${result.slug ?? normalizedName}`,
      imgUrl: result.thumbnailUrl ?? null,
    });
  }

  if (!rows.length) {
    logger.info("Databetrix catalog sync: no new game names");
    return;
  }

  const imported = importGames(rows);
  logger.info(
    `Databetrix catalog sync: ${imported.inserted} new games (${imported.updated} updated, ${imported.skipped} skipped)`,
  );
}

const sourceConfig = getSourceConfig("databetrix");

export const databetrixSource: GameImageSource = {
  name: "databetrix",
  implemented: true,
  enabled: sourceConfig?.enabled ?? true,
  expectedRatio: sourceConfig?.expectedRatio ?? "unknown",
  detectTypeOnce: true,
  minImageWidth: 200,
  minImageHeight: 130,
  squareMaxRatio: 1.3,
  allowSameNameDuplicateImages: true,
  priority: sourceConfig?.priority ?? 4,
  concurrency: sourceConfig?.concurrency ?? config.concurrency,
  httpWorks: true,
  playwrightRequired: false,

  async init() {
    await loadCatalog();
    importMissingCatalogGames();
  },

  async close() {
    catalogByName = null;
    catalogLoadPromise = null;
    catalogMeta = null;
  },

  async probe() {
    try {
      const page = await fetchCatalogPage(0);
      return {
        httpWorks: page.games.length > 0,
        playwrightRequired: false,
        notes: [
          `Databetrix catalog reachable (${page.total} games)`,
          `Sample: ${page.games[0]?.name?.trim() ?? "n/a"}`,
        ],
      };
    } catch (error) {
      const message =
        error instanceof HttpError
          ? `HTTP ${error.status}`
          : (error as Error).message;
      return {
        httpWorks: false,
        playwrightRequired: false,
        notes: [`Probe error: ${message}`],
      };
    }
  },

  async searchGame(game: GameRecord): Promise<SearchResult[]> {
    try {
      if (!catalogByName) await loadCatalog();
      const results =
        catalogByName?.get(normalizeGameName(game.name)) ?? [];
      const primary = results[0];
      if (!primary || results.length === 1) return results;
      return [
        {
          ...primary,
          raw: {
            ...(primary.raw ?? {}),
            _alternatives: results
              .slice(1)
              .map((result) => result.raw)
              .filter(Boolean),
          },
        },
      ];
    } catch (error) {
      logger.warn(
        `Databetrix catalog lookup failed for ${game.name}: ${(error as Error).message}`,
      );
      return [];
    }
  },

  async extractGame(result: SearchResult): Promise<GamePageResult> {
    return {
      title: result.title,
      provider: result.provider,
      slug: result.slug,
      url: result.url,
      json: result.raw ?? {},
    };
  },

  async extractImages(gamePage: GamePageResult): Promise<ImageCandidate[]> {
    if (!gamePage.json || typeof gamePage.json !== "object") return [];
    return candidatesFromGame(gamePage.json as DatabetrixGame);
  },
};

export function _resetDatabetrixCatalogForTests(): void {
  catalogByName = null;
  catalogLoadPromise = null;
  catalogMeta = null;
}

export function _getDatabetrixCatalogMetaForTests() {
  return catalogMeta;
}
