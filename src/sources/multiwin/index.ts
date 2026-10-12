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
import { fetchJson } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";
import type { GameImageSource } from "../SourceAdapter.js";

type MultiwinProduct = "casino" | "live_casino";

interface MultiwinGame {
  id?: string;
  game_id?: string;
  name?: string;
  custom_name?: string | null;
  provider_name?: string | null;
  product_slug?: string;
  background_image?: string | null;
  cover_image?: string | null;
  custom_background_image?: string | null;
  _product?: MultiwinProduct;
}

interface MultiwinResponse {
  data?: {
    games?: MultiwinGame[];
  };
}

interface MultiwinCacheFile {
  fetchedAt: number;
  results: SearchResult[];
}

let catalogByName: Map<string, SearchResult[]> | null = null;
let catalogLoadPromise: Promise<void> | null = null;

function endpoint(product: MultiwinProduct): string {
  return `${config.multiwin.apiBaseUrl}/${product}`;
}

function absoluteImageUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim(), `${config.multiwin.baseUrl}/`);
    return /^https?:$/.test(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function gameTitles(game: MultiwinGame): string[] {
  return [...new Set([game.custom_name?.trim(), game.name?.trim()].filter(
    (value): value is string => Boolean(value),
  ))];
}

function toSearchResult(
  game: MultiwinGame,
  product: MultiwinProduct,
  title: string,
): SearchResult | null {
  const id = game.game_id?.trim() || game.id?.trim();
  if (!id) return null;
  const raw = { ...game, _product: product };
  return {
    title,
    provider: game.provider_name?.trim() || null,
    slug: id,
    url: `${endpoint(product)}#game-${encodeURIComponent(id)}`,
    thumbnailUrl: null,
    raw: raw as unknown as Record<string, unknown>,
  };
}

async function fetchProduct(product: MultiwinProduct): Promise<MultiwinGame[]> {
  const response = await fetchJson<MultiwinResponse>(endpoint(product), {
    headers: {
      accept: "application/json",
      origin: config.multiwin.baseUrl,
      referer: `${config.multiwin.baseUrl}/`,
    },
    label: `multiwin-${product}`,
    retries: 2,
  });
  const games = response.data?.games;
  if (!Array.isArray(games)) {
    throw new Error(`multiwin_invalid_response:${product}`);
  }
  return games;
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

function readCache(): MultiwinCacheFile | null {
  try {
    if (!fs.existsSync(config.multiwin.catalogCachePath)) return null;
    const cache = JSON.parse(
      fs.readFileSync(config.multiwin.catalogCachePath, "utf8"),
    ) as MultiwinCacheFile;
    if (!cache?.fetchedAt || !cache.results?.length) return null;
    if (Date.now() - cache.fetchedAt > config.multiwin.catalogCacheTtlMs) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function writeCache(cache: MultiwinCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(config.multiwin.catalogCachePath), {
      recursive: true,
    });
    fs.writeFileSync(config.multiwin.catalogCachePath, JSON.stringify(cache));
  } catch (error) {
    logger.warn(`Multiwin cache write failed: ${(error as Error).message}`);
  }
}

async function loadCatalog(): Promise<void> {
  if (catalogByName) return;
  if (catalogLoadPromise) return catalogLoadPromise;

  catalogLoadPromise = (async () => {
    const cached = readCache();
    if (cached) {
      catalogByName = buildIndex(cached.results);
      logger.info(
        `Multiwin catalog cache hit: ${cached.results.length} records (${catalogByName.size} titles)`,
      );
      return;
    }

    const [slots, live] = await Promise.all([
      fetchProduct("casino"),
      fetchProduct("live_casino"),
    ]);
    const results: SearchResult[] = [];
    for (const [games, product] of [
      [slots, "casino"],
      [live, "live_casino"],
    ] as const) {
      for (const game of games) {
        for (const title of gameTitles(game)) {
          const result = toSearchResult(game, product, title);
          if (result) results.push(result);
        }
      }
    }

    catalogByName = buildIndex(results);
    writeCache({ fetchedAt: Date.now(), results });
    logger.info(
      `Multiwin catalog ready: ${slots.length} slots + ${live.length} live → ${catalogByName.size} titles`,
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

function candidatesFromGame(game: MultiwinGame): ImageCandidate[] {
  const fields =
    game._product === "live_casino"
      ? (["background_image", "cover_image"] as const)
      : ([
          "background_image",
          "cover_image",
          "custom_background_image",
        ] as const);
  const seen = new Set<string>();
  const candidates: ImageCandidate[] = [];

  for (const field of fields) {
    const url = absoluteImageUrl(game[field]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({
      url,
      alt: game.custom_name?.trim() || game.name?.trim() || null,
      filename: new URL(url).pathname.split("/").pop() ?? null,
      context: `multiwin.${game._product}.${field}`,
      sourceHint: field,
    });
  }
  return candidates;
}

const sourceConfig = getSourceConfig("multiwin");

export const multiwinSource: GameImageSource = {
  name: "multiwin",
  implemented: true,
  enabled: sourceConfig?.enabled ?? true,
  expectedRatio: "unknown",
  supportedTypes: ["portrait", "square", "landscape"],
  minImageWidth: 250,
  minImageHeight: 250,
  squareMinRatio: 0.85,
  squareMaxRatio: 1.2,
  landscapeMaxRatio: 10,
  allowSameNameDuplicateImages: true,
  saveAllCandidates: true,
  priority: sourceConfig?.priority ?? 6,
  concurrency: sourceConfig?.concurrency ?? 8,
  httpWorks: true,
  playwrightRequired: false,

  async init() {
    await loadCatalog();
  },

  async close() {
    catalogByName = null;
    catalogLoadPromise = null;
  },

  async probe() {
    try {
      const [slots, live] = await Promise.all([
        fetchProduct("casino"),
        fetchProduct("live_casino"),
      ]);
      return {
        httpWorks: slots.length > 0 || live.length > 0,
        playwrightRequired: false,
        notes: [`${slots.length} slots`, `${live.length} live games`],
      };
    } catch (error) {
      return {
        httpWorks: false,
        playwrightRequired: false,
        notes: [`Probe error: ${(error as Error).message}`],
      };
    }
  },

  async searchGame(game: GameRecord): Promise<SearchResult[]> {
    if (!catalogByName) await loadCatalog();
    return catalogByName?.get(normalizeGameName(game.name)) ?? [];
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
    return candidatesFromGame(gamePage.json as MultiwinGame);
  },
};

export function _resetMultiwinCatalogForTests(): void {
  catalogByName = null;
  catalogLoadPromise = null;
}
