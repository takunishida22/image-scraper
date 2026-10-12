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

interface BetgalianoGame {
  Id?: number;
  BrandGameId?: string;
  Name?: string;
  ProviderName?: string;
  VendorName?: string;
  ImageUrl?: string;
  BackImageUrl?: string;
  ImageUrl1?: string;
  ImageUrl2?: string;
  ImageUrl3?: string;
  ImageUrl4?: string;
  ImageUrl5?: string;
}

interface BetgalianoGameWrapper {
  Data?: BetgalianoGame;
}

interface BetgalianoCatalogResponse {
  Contents?: {
    Total?: number;
    Data?: BetgalianoGameWrapper[];
  };
}

interface CatalogCacheFile {
  fetchedAt: number;
  siteId: number;
  tags: string[];
  total: number;
  pages: number;
  results: SearchResult[];
}

function catalogUrl(): string {
  const url = new URL(config.betgaliano.apiUrl);
  url.searchParams.set("siteid", String(config.betgaliano.siteId));
  return url.toString();
}

function cleanImageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = value.trim();
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

function toSearchResult(game: BetgalianoGame): SearchResult | null {
  const title = game.Name?.trim();
  const id = game.Id;
  if (!title || !Number.isFinite(id)) return null;

  return {
    title,
    provider: game.VendorName?.trim() || game.ProviderName?.trim() || null,
    slug: game.BrandGameId?.trim() || String(id),
    url: `${catalogUrl()}#game-${id}`,
    thumbnailUrl: cleanImageUrl(game.ImageUrl),
    raw: game as unknown as Record<string, unknown>,
  };
}

function candidatesFromGame(game: BetgalianoGame): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();

  const push = (
    value: string | null | undefined,
    sourceHint: string,
    widthHint: number,
  ) => {
    const url = cleanImageUrl(value);
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({
      url,
      alt: game.Name ?? null,
      filename: new URL(url).pathname.split("/").pop() ?? null,
      context: "betgaliano.gameImage",
      sourceHint,
      widthHint,
    });
  };

  // Betgaliano's thumbnail is the intended lobby tile. Background fields
  // are deliberately excluded even though they are often higher resolution.
  push(game.ImageUrl, "betgaliano-thumbnail", 490);
  push(game.ImageUrl1, "betgaliano-thumbnail", 490);

  return candidates;
}

function catalogPayload(page: number): Record<string, unknown> {
  return {
    Page: page,
    PageItems: config.betgaliano.pageSize,
    Tags: config.betgaliano.tags,
    Search: "",
    Order: "Default",
  };
}

async function fetchCatalogPage(page: number): Promise<{
  total: number;
  list: BetgalianoGame[];
}> {
  const response = await fetchJson<BetgalianoCatalogResponse>(catalogUrl(), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://betgaliano.com",
      referer: "https://betgaliano.com/",
    },
    body: JSON.stringify(catalogPayload(page)),
    label: `betgaliano-catalog-p${page}`,
    retries: 2,
  });

  const contents = response.Contents;
  if (!contents || !Array.isArray(contents.Data)) {
    throw new Error("betgaliano_catalog_invalid_response");
  }

  return {
    total: contents.Total ?? 0,
    list: contents.Data.flatMap((entry) => (entry.Data ? [entry.Data] : [])),
  };
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
    if (!fs.existsSync(config.betgaliano.catalogCachePath)) return null;
    const cache = JSON.parse(
      fs.readFileSync(config.betgaliano.catalogCachePath, "utf8"),
    ) as CatalogCacheFile;
    if (!cache?.results?.length || !cache.fetchedAt) return null;
    if (cache.siteId !== config.betgaliano.siteId) return null;
    if (cache.tags.join(",") !== config.betgaliano.tags.join(",")) return null;
    if (Date.now() - cache.fetchedAt > config.betgaliano.catalogCacheTtlMs) return null;
    return cache;
  } catch {
    return null;
  }
}

function writeDiskCache(cache: CatalogCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(config.betgaliano.catalogCachePath), {
      recursive: true,
    });
    fs.writeFileSync(config.betgaliano.catalogCachePath, JSON.stringify(cache));
  } catch (error) {
    logger.warn(
      `Betgaliano catalog cache write failed: ${(error as Error).message}`,
    );
  }
}

async function fetchAllCatalogPages(): Promise<{
  total: number;
  pages: number;
  results: SearchResult[];
}> {
  const first = await fetchCatalogPage(1);
  const apiPages = Math.max(1, Math.ceil(first.total / config.betgaliano.pageSize));
  const pages =
    config.betgaliano.catalogMaxPages > 0
      ? Math.min(apiPages, config.betgaliano.catalogMaxPages)
      : apiPages;
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const append = (games: BetgalianoGame[]) => {
    for (const game of games) {
      const result = toSearchResult(game);
      if (!result || seen.has(result.url)) continue;
      seen.add(result.url);
      results.push(result);
    }
  };

  append(first.list);
  logger.info(
    `Betgaliano catalog: ${first.total} games, fetching ${pages}/${apiPages} pages (pageSize=${config.betgaliano.pageSize})`,
  );

  for (let page = 2; page <= pages; page += 1) {
    const batch = await fetchCatalogPage(page);
    append(batch.list);
    if (page % 5 === 0 || page === pages) {
      logger.info(
        `Betgaliano catalog progress: page ${page}/${pages} (${results.length} games)`,
      );
    }
    if (batch.list.length === 0) break;
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
        `Betgaliano catalog cache hit: ${cached.results.length} games (${catalogByName.size} titles)`,
      );
      return;
    }

    const catalog = await fetchAllCatalogPages();
    catalogByName = buildIndex(catalog.results);
    catalogMeta = {
      total: catalog.total,
      pages: catalog.pages,
      results: catalog.results.length,
    };

    if (config.betgaliano.catalogMaxPages <= 0) {
      writeDiskCache({
        fetchedAt: Date.now(),
        siteId: config.betgaliano.siteId,
        tags: config.betgaliano.tags,
        total: catalog.total,
        pages: catalog.pages,
        results: catalog.results,
      });
    }

    logger.info(
      `Betgaliano catalog ready: ${catalog.results.length} games → ${catalogByName.size} unique titles`,
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

const sourceConfig = getSourceConfig("betgaliano");

export const betgalianoSource: GameImageSource = {
  name: "betgaliano",
  implemented: true,
  enabled: sourceConfig?.enabled ?? true,
  expectedRatio: sourceConfig?.expectedRatio ?? "landscape",
  priority: sourceConfig?.priority ?? 2,
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
      const page = await fetchCatalogPage(1);
      const first = page.list.find((game) => cleanImageUrl(game.ImageUrl));
      return {
        httpWorks: page.list.length > 0,
        playwrightRequired: false,
        notes: [
          `Betgaliano catalog reachable (${page.total} games)`,
          `Sample: ${first?.Name ?? "n/a"}`,
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
      return catalogByName?.get(normalizeGameName(game.name)) ?? [];
    } catch (error) {
      logger.warn(
        `Betgaliano catalog lookup failed for ${game.name}: ${(error as Error).message}`,
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
    return candidatesFromGame(gamePage.json as BetgalianoGame);
  },
};

export function _resetBetgalianoCatalogForTests(): void {
  catalogByName = null;
  catalogLoadPromise = null;
  catalogMeta = null;
}

export function _getBetgalianoCatalogMetaForTests() {
  return catalogMeta;
}
