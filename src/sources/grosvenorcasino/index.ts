import fs from "node:fs";
import path from "node:path";
import pLimit from "p-limit";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { config, getSourceConfig } from "../../config/index.js";
import { normalizeGameName } from "../../core/normalizer.js";
import { getDb } from "../../database/db.js";
import type {
  GamePageResult,
  GameRecord,
  ImageCandidate,
  SearchResult,
} from "../../types.js";
import { logger } from "../../utils/logger.js";
import type { GameImageSource } from "../SourceAdapter.js";

interface GrosvenorLayer {
  cropUrl?: string | null;
}

interface GrosvenorGame {
  id?: string;
  name?: string;
  gameName?: string;
  gameURL?: string;
  gameProviderName?: string | null;
  backgroundLayer?: GrosvenorLayer | null;
  gameLogoLayer?: GrosvenorLayer | null;
}

interface GrosvenorCatalogResponse {
  allGeneralGames?: { items?: GrosvenorGame[] };
  allLiveGames?: { items?: GrosvenorGame[] };
}

interface GrosvenorSearchResponse {
  games?: GrosvenorGame[];
}

interface CatalogCacheFile {
  fetchedAt: number;
  results: SearchResult[];
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let catalogByName: Map<string, SearchResult[]> | null = null;
let catalogLoadPromise: Promise<void> | null = null;
const searchLimit = pLimit(4);

async function ensureBrowser(): Promise<BrowserContext> {
  if (context) return context;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    locale: "en-GB",
  });
  return context;
}

async function browserJson<T>(url: string): Promise<T> {
  const browserContext = await ensureBrowser();
  const page = await browserContext.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: config.requestTimeout,
    });
    if (!response?.ok()) {
      throw new Error(`HTTP ${response?.status() ?? "unknown"}`);
    }
    const text = await page.textContent("body");
    return JSON.parse(text ?? "") as T;
  } finally {
    await page.close();
  }
}

function resizeCropUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.searchParams.set("width", String(config.grosvenorcasino.imageWidth));
    url.searchParams.set("upscale", "false");
    url.searchParams.set("format", "webp");
    return url.toString();
  } catch {
    return null;
  }
}

function toSearchResult(game: GrosvenorGame): SearchResult | null {
  const title = game.gameName?.trim() || game.name?.trim();
  const background = resizeCropUrl(game.backgroundLayer?.cropUrl);
  if (!title || !background) return null;
  const slug = game.gameURL?.trim() || game.id?.trim() || title;
  return {
    title,
    provider: game.gameProviderName?.trim() || null,
    slug,
    url: new URL(game.gameURL || "/slots-and-games/all", config.grosvenorcasino.baseUrl)
      .toString(),
    thumbnailUrl: null,
    raw: game as unknown as Record<string, unknown>,
  };
}

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
    if (!fs.existsSync(config.grosvenorcasino.catalogCachePath)) return null;
    const cache = JSON.parse(
      fs.readFileSync(config.grosvenorcasino.catalogCachePath, "utf8"),
    ) as CatalogCacheFile;
    if (!cache?.results?.length || !cache.fetchedAt) return null;
    if (
      Date.now() - cache.fetchedAt >
      config.grosvenorcasino.catalogCacheTtlMs
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
    fs.mkdirSync(path.dirname(config.grosvenorcasino.catalogCachePath), {
      recursive: true,
    });
    fs.writeFileSync(
      config.grosvenorcasino.catalogCachePath,
      JSON.stringify(cache),
    );
  } catch (error) {
    logger.warn(
      `Grosvenor catalog cache write failed: ${(error as Error).message}`,
    );
  }
}

async function loadCatalog(): Promise<void> {
  if (catalogByName) return;
  if (catalogLoadPromise) return catalogLoadPromise;

  catalogLoadPromise = (async () => {
    const cached = readDiskCache();
    if (cached) {
      catalogByName = buildIndex(cached.results);
      logger.info(
        `Grosvenor catalog cache hit: ${cached.results.length} games (${catalogByName.size} titles)`,
      );
      return;
    }

    const response = await browserJson<GrosvenorCatalogResponse>(
      config.grosvenorcasino.catalogUrl,
    );
    const games = [
      ...(response.allGeneralGames?.items ?? []),
      ...(response.allLiveGames?.items ?? []),
    ];
    const results = games
      .map(toSearchResult)
      .filter((result): result is SearchResult => Boolean(result));
    catalogByName = buildIndex(results);
    writeDiskCache({ fetchedAt: Date.now(), results });
    logger.info(
      `Grosvenor catalog ready: ${results.length} games → ${catalogByName.size} unique titles`,
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

async function searchByName(name: string): Promise<SearchResult[]> {
  return searchLimit(async () => {
    const url = new URL(config.grosvenorcasino.searchUrl);
    url.searchParams.set("searchTerm", name);
    url.searchParams.set("limit", "0");
    url.searchParams.set("responseType", "structured");
    const response = await browserJson<GrosvenorSearchResponse>(url.toString());
    return (response.games ?? [])
      .map(toSearchResult)
      .filter(
        (result): result is SearchResult =>
          result !== null &&
          normalizeGameName(result.title) === normalizeGameName(name),
      );
  });
}

function wasAlreadySearchedWithoutResult(gameId: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
       FROM source_attempts
       WHERE game_id = ?
         AND source = 'grosvenorcasino'
         AND target_type = 'landscape'
         AND status = 'not_found'
         AND last_error = 'no_search_results'
       LIMIT 1`,
    )
    .get(gameId);
  return Boolean(row);
}

function candidatesFromGame(game: GrosvenorGame): ImageCandidate[] {
  const background = resizeCropUrl(game.backgroundLayer?.cropUrl);
  if (!background) return [];
  const logo = resizeCropUrl(game.gameLogoLayer?.cropUrl);
  return [
    {
      url: background,
      overlayUrl: logo,
      alt: game.gameName ?? game.name ?? null,
      filename: new URL(background).pathname.split("/").pop() ?? null,
      context: "grosvenorcasino.composed-game-tile",
      sourceHint: "grosvenor-background-with-centered-logo",
      widthHint: config.grosvenorcasino.imageWidth,
    },
  ];
}

const sourceConfig = getSourceConfig("grosvenorcasino");

export const grosvenorcasinoSource: GameImageSource = {
  name: "grosvenorcasino",
  implemented: true,
  enabled: sourceConfig?.enabled ?? true,
  expectedRatio: "landscape",
  supportedTypes: ["landscape"],
  minImageWidth: 250,
  minImageHeight: 150,
  allowSameNameDuplicateImages: true,
  priority: sourceConfig?.priority ?? 5,
  concurrency: sourceConfig?.concurrency ?? 4,
  httpWorks: false,
  playwrightRequired: true,

  async init() {
    await loadCatalog();
  },

  async close() {
    catalogByName = null;
    catalogLoadPromise = null;
    if (context) await context.close();
    if (browser) await browser.close();
    context = null;
    browser = null;
  },

  async probe() {
    try {
      const results = await searchByName("3 Magic Pots");
      return {
        httpWorks: false,
        playwrightRequired: true,
        notes: [
          `Browser search reachable (${results.length} exact sample match${results.length === 1 ? "" : "es"})`,
          "Direct HTTP is blocked by Cloudflare",
        ],
      };
    } catch (error) {
      return {
        httpWorks: false,
        playwrightRequired: true,
        notes: [`Browser probe error: ${(error as Error).message}`],
      };
    }
  },

  async searchGame(game: GameRecord): Promise<SearchResult[]> {
    if (!catalogByName) await loadCatalog();
    const key = normalizeGameName(game.name);
    const catalogResults = catalogByName?.get(key) ?? [];
    if (
      catalogResults.length ||
      game.status !== "pending" ||
      wasAlreadySearchedWithoutResult(game.id)
    ) {
      return catalogResults;
    }

    try {
      const searched = await searchByName(game.name);
      if (searched.length) catalogByName?.set(key, searched);
      return searched;
    } catch (error) {
      logger.warn(
        `Grosvenor search failed for ${game.name}: ${(error as Error).message}`,
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
    return candidatesFromGame(gamePage.json as GrosvenorGame);
  },
};

export async function _resetGrosvenorCatalogForTests(): Promise<void> {
  catalogByName = null;
  catalogLoadPromise = null;
  if (context) await context.close();
  if (browser) await browser.close();
  context = null;
  browser = null;
}
