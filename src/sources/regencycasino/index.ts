import fs from "node:fs";
import path from "node:path";
import { config, getSourceConfig } from "../../config/index.js";
import { normalizeGameName } from "../../core/normalizer.js";
import type {
  GamePageResult,
  GameRecord,
  ImageCandidate,
  SearchResult,
} from "../../types.js";
import { fetchJson, HttpError } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";
import type { GameImageSource } from "../SourceAdapter.js";

interface RegencyGame {
  application_name?: string;
  item_title?: string;
  game_provider?: string;
  external_game_id?: string;
  internal_game_id?: number;
  keyID?: number;
}

interface RegencyCatalogResponse {
  current_page?: number;
  data?: RegencyGame[];
  last_page?: number;
  per_page?: number;
  total?: number;
}

interface CatalogCacheFile {
  fetchedAt: number;
  appName: string;
  country: string;
  platform: string;
  categories: string[];
  total: number;
  pages: number;
  results: SearchResult[];
}

function categoryUrl(category: string, page: number): string {
  const pageSize = config.regencycasino.pageSize;
  const url = new URL(
    `${config.regencycasino.apiBaseUrl}/${encodeURIComponent(category)}`,
  );
  url.searchParams.set("appName", config.regencycasino.appName);
  url.searchParams.set("country", config.regencycasino.country);
  url.searchParams.set("lang", config.regencycasino.lang);
  url.searchParams.set("platform", config.regencycasino.platform);
  url.searchParams.set("startIndex", String((page - 1) * pageSize + 1));
  url.searchParams.set("endIndex", String(page * pageSize));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("page", String(page));
  url.searchParams.set("total", "1");
  return url.toString();
}

async function fetchCategoryPage(
  category: string,
  page: number,
): Promise<RegencyCatalogResponse> {
  const response = await fetchJson<RegencyCatalogResponse>(
    categoryUrl(category, page),
    {
      headers: {
        accept: "application/json",
        origin: "https://regencycasino.gr",
        referer: "https://regencycasino.gr/",
      },
      label: `regencycasino-${category}-p${page}`,
      retries: 2,
    },
  );
  if (!Array.isArray(response.data)) {
    throw new Error(`regencycasino_invalid_response:${category}:${page}`);
  }
  return response;
}

function toSearchResult(
  game: RegencyGame,
  category: string,
): SearchResult | null {
  // application_name is the human-readable name used for matching.
  // item_title is the case-sensitive asset filename.
  const title = game.application_name?.trim() || game.item_title?.trim();
  const itemTitle = game.item_title?.trim();
  if (!title || !itemTitle) return null;

  const id =
    game.internal_game_id ??
    game.keyID ??
    game.external_game_id?.trim() ??
    itemTitle;
  return {
    title,
    provider: game.game_provider?.trim() || null,
    slug: game.external_game_id?.trim() || itemTitle,
    url: `${categoryUrl(category, 1)}#game-${encodeURIComponent(String(id))}`,
    thumbnailUrl: null,
    raw: {
      ...game,
      _category: category,
    } as unknown as Record<string, unknown>,
  };
}

function imageUrl(shape: "sq" | "rect", size: number, title: string): string {
  return `${config.regencycasino.imageBaseUrl}/${shape}/${size}/${encodeURIComponent(title)}.jpg`;
}

function candidatesFromGame(game: RegencyGame): ImageCandidate[] {
  const itemTitle = game.item_title?.trim();
  if (!itemTitle) return [];

  const candidates: ImageCandidate[] = [];
  for (const size of config.regencycasino.imageSizes) {
    candidates.push({
      url: imageUrl("sq", size, itemTitle),
      alt: game.application_name ?? itemTitle,
      filename: `${itemTitle}.jpg`,
      context: "regencycasino.game-tile",
      sourceHint: "regencycasino-square-thumbnail",
      widthHint: size,
    });
    candidates.push({
      url: imageUrl("rect", size, itemTitle),
      alt: game.application_name ?? itemTitle,
      filename: `${itemTitle}.jpg`,
      context: "regencycasino.game-tile",
      sourceHint: "regencycasino-landscape-thumbnail",
      widthHint: size,
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

function cacheMatches(cache: CatalogCacheFile): boolean {
  return (
    cache.appName === config.regencycasino.appName &&
    cache.country === config.regencycasino.country &&
    cache.platform === config.regencycasino.platform &&
    cache.categories.join(",") === config.regencycasino.categories.join(",")
  );
}

function readDiskCache(): CatalogCacheFile | null {
  try {
    if (!fs.existsSync(config.regencycasino.catalogCachePath)) return null;
    const cache = JSON.parse(
      fs.readFileSync(config.regencycasino.catalogCachePath, "utf8"),
    ) as CatalogCacheFile;
    if (!cache?.results?.length || !cache.fetchedAt || !cacheMatches(cache)) {
      return null;
    }
    if (
      Date.now() - cache.fetchedAt >
      config.regencycasino.catalogCacheTtlMs
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
    fs.mkdirSync(path.dirname(config.regencycasino.catalogCachePath), {
      recursive: true,
    });
    fs.writeFileSync(
      config.regencycasino.catalogCachePath,
      JSON.stringify(cache),
    );
  } catch (error) {
    logger.warn(
      `Regency Casino catalog cache write failed: ${(error as Error).message}`,
    );
  }
}

async function fetchCatalog(): Promise<{
  total: number;
  pages: number;
  results: SearchResult[];
}> {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let total = 0;
  let fetchedPages = 0;

  const append = (games: RegencyGame[], category: string) => {
    for (const game of games) {
      const result = toSearchResult(game, category);
      if (!result || seen.has(result.url)) continue;
      seen.add(result.url);
      results.push(result);
    }
  };

  for (const category of config.regencycasino.categories) {
    const first = await fetchCategoryPage(category, 1);
    const apiPages = Math.max(1, first.last_page ?? 1);
    const pages =
      config.regencycasino.catalogMaxPages > 0
        ? Math.min(apiPages, config.regencycasino.catalogMaxPages)
        : apiPages;
    total += first.total ?? first.data?.length ?? 0;
    fetchedPages += pages;
    append(first.data ?? [], category);

    logger.info(
      `Regency Casino ${category}: ${first.total ?? "?"} games, fetching ${pages}/${apiPages} pages`,
    );
    for (let page = 2; page <= pages; page += 1) {
      const batch = await fetchCategoryPage(category, page);
      append(batch.data ?? [], category);
    }
  }

  return { total, pages: fetchedPages, results };
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
        `Regency Casino catalog cache hit: ${cached.results.length} games (${catalogByName.size} titles)`,
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
    if (config.regencycasino.catalogMaxPages <= 0) {
      writeDiskCache({
        fetchedAt: Date.now(),
        appName: config.regencycasino.appName,
        country: config.regencycasino.country,
        platform: config.regencycasino.platform,
        categories: config.regencycasino.categories,
        total: catalog.total,
        pages: catalog.pages,
        results: catalog.results,
      });
    }
    logger.info(
      `Regency Casino catalog ready: ${catalog.results.length} games → ${catalogByName.size} unique titles`,
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

const sourceConfig = getSourceConfig("regencycasino");

export const regencycasinoSource: GameImageSource = {
  name: "regencycasino",
  implemented: true,
  enabled: sourceConfig?.enabled ?? true,
  expectedRatio: sourceConfig?.expectedRatio ?? "unknown",
  supportedTypes: ["square", "landscape"],
  minImageWidth: 250,
  minImageHeight: 120,
  priority: sourceConfig?.priority ?? 3,
  concurrency: sourceConfig?.concurrency ?? config.concurrency,
  httpWorks: true,
  playwrightRequired: false,

  async init() {
    await loadCatalog();
  },

  async close() {
    catalogByName = null;
    catalogLoadPromise = null;
    catalogMeta = null;
  },

  async probe() {
    try {
      const notes: string[] = [];
      let ok = false;
      for (const category of config.regencycasino.categories) {
        const page = await fetchCategoryPage(category, 1);
        ok ||= (page.data?.length ?? 0) > 0;
        notes.push(
          `${category}: ${page.total ?? "?"} games / ${page.last_page ?? "?"} pages`,
        );
      }
      return {
        httpWorks: ok,
        playwrightRequired: false,
        notes,
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
      return catalogByName?.get(normalizeGameName(game.name)) ?? [];
    } catch (error) {
      logger.warn(
        `Regency Casino catalog lookup failed for ${game.name}: ${(error as Error).message}`,
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
    return candidatesFromGame(gamePage.json as RegencyGame);
  },
};

export function _resetRegencyCasinoCatalogForTests(): void {
  catalogByName = null;
  catalogLoadPromise = null;
  catalogMeta = null;
}

export function _getRegencyCasinoCatalogMetaForTests() {
  return catalogMeta;
}
