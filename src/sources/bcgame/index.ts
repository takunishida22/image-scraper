import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, getSourceConfig } from "../../config/index.js";
import { normalizeGameName } from "../../core/normalizer.js";
import type { GameImageSource } from "../SourceAdapter.js";
import type {
  GamePageResult,
  GameRecord,
  ImageCandidate,
  SearchResult,
} from "../../types.js";
import { fetchJson, HttpError } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";

const BASE = "https://bc.game";
const CATALOG_URL = `${BASE}/api/edge/game/home/recommend/item/`;
/** API rejects pageSize below this ("size too small"). */
const MIN_PAGE_SIZE = 40;

interface BcGameIdentity {
  gameInfoId?: number;
  gameName?: string;
  gameUrl?: string;
}

interface BcLiveBgImage {
  imageUrl?: string;
  imageUrlHash?: string;
}

interface BcGameNode {
  fullName?: string;
  providerName?: string;
  thumbnail?: string;
  iconThreeFour?: string;
  liveBgImage?: string | BcLiveBgImage | null;
  original?: boolean;
  gameIdentity?: BcGameIdentity;
}

interface BcCatalogResponse {
  code?: number;
  msg?: string | null;
  data?: {
    country?: string;
    gameList?: {
      page?: number;
      pageSize?: number;
      total?: number;
      totalPage?: number;
      list?: BcGameNode[];
    };
  };
}

interface CatalogCacheFile {
  fetchedAt: number;
  areaCode: string;
  country: string | null;
  total: number;
  pages: number;
  results: SearchResult[];
}

function makeDistinctId(): string {
  const a = randomBytes(8).toString("hex");
  const b = randomBytes(8).toString("hex");
  const c = randomBytes(4).toString("hex");
  const d = String(1440000);
  const e = randomBytes(6).toString("hex");
  return `${a}-${b}-${c}-${d}-${e}`;
}

function catalogHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    origin: BASE,
    referer: `${BASE}/en/casino/home`,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };
}

function cleanImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  if (/\/common\.png$/i.test(trimmed)) return null;
  return trimmed.split("?")[0] ?? trimmed;
}

function liveBgUrl(value: BcGameNode["liveBgImage"]): string | null {
  if (!value) return null;
  if (typeof value === "string") return cleanImageUrl(value);
  return cleanImageUrl(value.imageUrl);
}

function toSearchResult(node: BcGameNode): SearchResult | null {
  // Always match on display title (fullName). Never use gameIdentity.gameName
  // (those are internal ids like "TADA70:563" / "pg:128").
  const title = node.fullName?.trim();
  const slug = node.gameIdentity?.gameUrl?.trim();
  if (!title || !slug) return null;
  const thumbnailUrl =
    cleanImageUrl(node.iconThreeFour) || cleanImageUrl(node.thumbnail);
  return {
    title,
    provider: node.providerName ?? null,
    slug,
    url: `${BASE}/game/${slug}`,
    thumbnailUrl,
    raw: node as unknown as Record<string, unknown>,
  };
}

function candidatesFromNode(node: BcGameNode): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined, hint: string) => {
    const clean = cleanImageUrl(url);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    out.push({
      url: clean,
      alt: node.fullName ?? null,
      filename: clean.split("/").pop() ?? null,
      sourceHint: hint,
      context: "bcgame.game-tile",
    });
  };

  push(node.iconThreeFour, "bcgame-icon-three-four");
  push(node.thumbnail, "bcgame-thumbnail");
  push(liveBgUrl(node.liveBgImage), "bcgame-live-bg");
  return out;
}

function pageSize(): number {
  return Math.max(MIN_PAGE_SIZE, config.bcgame.pageSize);
}

function catalogPayload(page: number): Record<string, unknown> {
  return {
    selectionName: "all_games",
    sortBy: "",
    providerNames: "",
    page,
    pageSize: pageSize(),
    areaCode: config.bcgame.areaCode,
    distinctId: config.bcgame.distinctId || makeDistinctId(),
    showingBlocked: 0,
    bcLang: "en",
    browserLang: "en-US",
    isBrazil: false,
  };
}

async function fetchCatalogPage(page: number): Promise<{
  country: string | null;
  total: number;
  totalPage: number;
  list: BcGameNode[];
}> {
  const data = await fetchJson<BcCatalogResponse>(CATALOG_URL, {
    method: "POST",
    headers: catalogHeaders(),
    body: JSON.stringify(catalogPayload(page)),
    label: `bcgame-catalog-p${page}`,
    retries: 2,
  });

  if (data.code !== 0) {
    throw new Error(`bcgame_catalog_error:${data.code}:${data.msg ?? "unknown"}`);
  }

  const gameList = data.data?.gameList;
  return {
    country: data.data?.country ?? null,
    total: gameList?.total ?? 0,
    totalPage: gameList?.totalPage ?? 0,
    list: gameList?.list ?? [],
  };
}

/** In-memory catalog: normalized title → search hits. */
let catalogByName: Map<string, SearchResult[]> | null = null;
let catalogLoadPromise: Promise<void> | null = null;
let catalogMeta: { country: string | null; total: number; pages: number } | null = null;

function indexResult(map: Map<string, SearchResult[]>, result: SearchResult): void {
  const key = normalizeGameName(result.title);
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) {
    if (!bucket.some((r) => r.url === result.url)) bucket.push(result);
  } else {
    map.set(key, [result]);
  }
}

function buildIndex(results: SearchResult[]): Map<string, SearchResult[]> {
  const map = new Map<string, SearchResult[]>();
  for (const result of results) indexResult(map, result);
  return map;
}

function readDiskCache(): CatalogCacheFile | null {
  const file = config.bcgame.catalogCachePath;
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as CatalogCacheFile;
    if (!parsed?.results?.length || !parsed.fetchedAt) return null;
    if (parsed.areaCode !== config.bcgame.areaCode) return null;
    if (Date.now() - parsed.fetchedAt > config.bcgame.catalogCacheTtlMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDiskCache(cache: CatalogCacheFile): void {
  const file = config.bcgame.catalogCachePath;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache));
  } catch (err) {
    logger.warn(`BC.Game catalog cache write failed: ${(err as Error).message}`);
  }
}

async function fetchAllCatalogPages(): Promise<{
  country: string | null;
  total: number;
  pages: number;
  results: SearchResult[];
}> {
  const first = await fetchCatalogPage(1);
  const results: SearchResult[] = [];
  const seenUrls = new Set<string>();

  const pushList = (list: BcGameNode[]) => {
    for (const node of list) {
      const sr = toSearchResult(node);
      if (!sr || seenUrls.has(sr.url)) continue;
      seenUrls.add(sr.url);
      results.push(sr);
    }
  };

  pushList(first.list);

  const apiPages = Math.max(1, first.totalPage);
  const maxPages = config.bcgame.catalogMaxPages;
  const totalPage = maxPages > 0 ? Math.min(apiPages, maxPages) : apiPages;

  logger.info(
    `BC.Game catalog: ${first.country ?? "unknown"} — ${first.total} games, fetching ${totalPage}/${apiPages} pages (pageSize=${pageSize()}, areaCode=${config.bcgame.areaCode})`,
  );

  for (let page = 2; page <= totalPage; page += 1) {
    const batch = await fetchCatalogPage(page);
    pushList(batch.list);
    if (page % 20 === 0 || page === totalPage) {
      logger.info(`BC.Game catalog progress: page ${page}/${totalPage} (${results.length} tiles)`);
    }
  }

  return {
    country: first.country,
    total: first.total,
    pages: totalPage,
    results,
  };
}

async function loadCatalog(force = false): Promise<void> {
  if (catalogByName && !force) return;
  if (catalogLoadPromise && !force) return catalogLoadPromise;

  catalogLoadPromise = (async () => {
    if (!force) {
      const cached = readDiskCache();
      if (cached) {
        catalogByName = buildIndex(cached.results);
        catalogMeta = {
          country: cached.country,
          total: cached.total,
          pages: cached.pages,
        };
        logger.info(
          `BC.Game catalog cache hit: ${cached.results.length} tiles (${cached.country ?? "?"}, ${catalogByName.size} titles)`,
        );
        return;
      }
    }

    const fetched = await fetchAllCatalogPages();
    catalogByName = buildIndex(fetched.results);
    catalogMeta = {
      country: fetched.country,
      total: fetched.total,
      pages: fetched.pages,
    };

    // Only cache full catalog fetches
    if (config.bcgame.catalogMaxPages <= 0) {
      writeDiskCache({
        fetchedAt: Date.now(),
        areaCode: config.bcgame.areaCode,
        country: fetched.country,
        total: fetched.total,
        pages: fetched.pages,
        results: fetched.results,
      });
    }

    logger.info(
      `BC.Game catalog ready: ${fetched.results.length} tiles → ${catalogByName.size} unique titles`,
    );
  })();

  try {
    await catalogLoadPromise;
  } catch (err) {
    catalogLoadPromise = null;
    catalogByName = null;
    throw err;
  }
}

function lookupCatalog(game: GameRecord): SearchResult[] {
  if (!catalogByName) return [];
  const key = normalizeGameName(game.name);
  if (!key) return [];
  return catalogByName.get(key) ?? [];
}

const sourceCfg = getSourceConfig("bcgame");

export const bcgameSource: GameImageSource = {
  name: "bcgame",
  implemented: true,
  enabled: sourceCfg?.enabled ?? true,
  expectedRatio: sourceCfg?.expectedRatio ?? "portrait",
  priority: sourceCfg?.priority ?? 1,
  concurrency: sourceCfg?.concurrency ?? config.concurrency,
  httpWorks: true,
  playwrightRequired: false,

  async init() {
    await loadCatalog(false);
  },

  async close() {
    catalogByName = null;
    catalogLoadPromise = null;
    catalogMeta = null;
  },

  async probe() {
    try {
      const page = await fetchCatalogPage(1);
      const ok = page.list.length > 0;
      return {
        httpWorks: ok,
        playwrightRequired: false,
        notes: ok
          ? [
              `BC.Game catalog reachable (${page.country ?? "?"}: ${page.total} games, ${page.totalPage} pages)`,
              `Sample: ${page.list[0]?.fullName ?? "n/a"}`,
            ]
          : ["BC.Game catalog returned empty page 1"],
      };
    } catch (err) {
      const msg = err instanceof HttpError ? `HTTP ${err.status}` : (err as Error).message;
      return {
        httpWorks: false,
        playwrightRequired: false,
        notes: [`Probe error: ${msg}`],
      };
    }
  },

  async searchGame(game: GameRecord): Promise<SearchResult[]> {
    try {
      if (!catalogByName) await loadCatalog(false);
      return lookupCatalog(game);
    } catch (err) {
      logger.warn(`BC.Game catalog lookup failed for ${game.name}: ${(err as Error).message}`);
      return [];
    }
  },

  async extractGame(result: SearchResult): Promise<GamePageResult> {
    return {
      title: result.title,
      provider: result.provider,
      slug: result.slug,
      url: result.url,
      json: result.raw ?? { thumbnailUrl: result.thumbnailUrl },
    };
  },

  async extractImages(gamePage: GamePageResult): Promise<ImageCandidate[]> {
    const node =
      gamePage.json && typeof gamePage.json === "object"
        ? (gamePage.json as BcGameNode)
        : null;
    if (!node) {
      if (typeof (gamePage.json as { thumbnailUrl?: string } | null)?.thumbnailUrl === "string") {
        const url = cleanImageUrl((gamePage.json as { thumbnailUrl: string }).thumbnailUrl);
        return url
          ? [
              {
                url,
                alt: gamePage.title,
                sourceHint: "bcgame-thumbnail",
                context: "bcgame.game-tile",
              },
            ]
          : [];
      }
      return [];
    }
    return candidatesFromNode(node);
  },
};

/** Test helpers */
export function _resetBcgameCatalogForTests(): void {
  catalogByName = null;
  catalogLoadPromise = null;
  catalogMeta = null;
}

export function _getBcgameCatalogMetaForTests() {
  return catalogMeta;
}
