import { config, getSourceConfig } from "../../config/index.js";
import { discoverImagesFromHtml, discoverImagesFromJson } from "../../images/discovery.js";
import type { GameImageSource } from "../SourceAdapter.js";
import type {
  GamePageResult,
  GameRecord,
  ImageCandidate,
  SearchResult,
} from "../../types.js";
import { fetchJson, fetchText, HttpError } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";
import { slugifyGameName } from "../../core/normalizer.js";

interface StakeGameNode {
  id?: string;
  name?: string;
  title?: string;
  slug?: string;
  providerName?: string;
  provider?: { name?: string } | string;
  thumbnailUrl?: string;
  thumbUrl?: string;
  imageUrl?: string;
  icon?: string;
  thumb?: string;
}

const SEARCH_QUERIES = [
  {
    name: "CasinoSearch",
    query: `query CasinoSearch($query: String!) {
      casinoSearch(query: $query) {
        casinoGames {
          id
          name
          slug
          provider { name }
          thumbnailUrl
          __typename
        }
      }
    }`,
    pick: (data: Record<string, unknown>) => {
      const root = data.casinoSearch as { casinoGames?: StakeGameNode[] } | undefined;
      return root?.casinoGames ?? [];
    },
  },
  {
    name: "SearchCasino",
    query: `query SearchCasino($query: String!) {
      searchCasino(query: $query) {
        games {
          id
          name
          slug
          providerName
          thumbnailUrl
        }
      }
    }`,
    pick: (data: Record<string, unknown>) => {
      const root = data.searchCasino as { games?: StakeGameNode[] } | undefined;
      return root?.games ?? [];
    },
  },
  {
    name: "SlugCasinoGame",
    query: `query SlugCasinoGame($slug: String!) {
      slugCasinoGame(slug: $slug) {
        id
        name
        slug
        provider { name }
        thumbnailUrl
        __typename
      }
    }`,
    pick: (data: Record<string, unknown>) => {
      const node = data.slugCasinoGame as StakeGameNode | null | undefined;
      return node ? [node] : [];
    },
  },
];

function providerName(node: StakeGameNode): string | null {
  if (typeof node.provider === "string") return node.provider;
  if (node.provider && typeof node.provider === "object") return node.provider.name ?? null;
  return node.providerName ?? null;
}

function thumbOf(node: StakeGameNode): string | null {
  return node.thumbnailUrl || node.thumbUrl || node.imageUrl || node.icon || node.thumb || null;
}

function toSearchResult(node: StakeGameNode, baseUrl: string): SearchResult | null {
  const title = node.name || node.title;
  if (!title) return null;
  const slug = node.slug || slugifyGameName(title);
  return {
    title,
    provider: providerName(node),
    slug,
    url: `${baseUrl}/casino/games/${slug}`,
    thumbnailUrl: thumbOf(node),
    raw: node as Record<string, unknown>,
  };
}

function stakeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    origin: config.stake.baseUrl,
    referer: `${config.stake.baseUrl}/casino/home`,
  };
  if (config.stake.accessToken) {
    headers["x-access-token"] = config.stake.accessToken;
  }
  if (config.stake.cfClearance) {
    headers.cookie = `cf_clearance=${config.stake.cfClearance}`;
  }
  return headers;
}

async function graphql<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): Promise<T> {
  const body = JSON.stringify({ query, variables, operationName });
  const data = await fetchJson<{ data?: T; errors?: Array<{ message: string }> }>(
    `${config.stake.baseUrl}/_api/graphql`,
    {
      method: "POST",
      body,
      headers: stakeHeaders(),
      proxy: config.stake.proxy || undefined,
      label: "stake-graphql",
    },
  );
  if (data.errors?.length) {
    throw new Error(data.errors.map((e) => e.message).join("; "));
  }
  if (!data.data) throw new Error("Stake GraphQL returned no data");
  return data.data;
}

async function searchViaHttp(game: GameRecord): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Prefer slug lookup first for exact names
  const slug = slugifyGameName(game.name);
  try {
    const data = await graphql<Record<string, unknown>>(SEARCH_QUERIES[2]!.query, { slug }, "SlugCasinoGame");
    for (const node of SEARCH_QUERIES[2]!.pick(data)) {
      const sr = toSearchResult(node, config.stake.baseUrl);
      if (sr && !seen.has(sr.url)) {
        seen.add(sr.url);
        results.push(sr);
      }
    }
  } catch (err) {
    logger.debug(`Stake slug lookup failed: ${(err as Error).message}`);
  }

  for (const q of SEARCH_QUERIES.slice(0, 2)) {
    try {
      const data = await graphql<Record<string, unknown>>(q.query, { query: game.name }, q.name);
      for (const node of q.pick(data)) {
        const sr = toSearchResult(node, config.stake.baseUrl);
        if (sr && !seen.has(sr.url)) {
          seen.add(sr.url);
          results.push(sr);
        }
      }
      if (results.length) break;
    } catch (err) {
      logger.debug(`Stake search ${q.name} failed: ${(err as Error).message}`);
    }
  }

  return results;
}

function ingestGraphqlData(
  data: Record<string, unknown>,
  results: SearchResult[],
  seen: Set<string>,
): void {
  for (const q of SEARCH_QUERIES) {
    try {
      for (const node of q.pick(data)) {
        const sr = toSearchResult(node, config.stake.baseUrl);
        if (sr && !seen.has(sr.url)) {
          seen.add(sr.url);
          results.push(sr);
        }
      }
    } catch {
      /* schema mismatch */
    }
  }

  const stack: unknown[] = [data];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      stack.push(...cur);
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (typeof obj.name === "string" && (typeof obj.slug === "string" || obj.thumbnailUrl || obj.thumbUrl)) {
      const sr = toSearchResult(obj as StakeGameNode, config.stake.baseUrl);
      if (sr && !seen.has(sr.url)) {
        seen.add(sr.url);
        results.push(sr);
      }
    }
    stack.push(...Object.values(obj));
  }
}

async function pageLooksBlocked(page: { title: () => Promise<string>; content: () => Promise<string> }): Promise<string | null> {
  const title = (await page.title()).toLowerCase();
  const html = (await page.content()).toLowerCase();
  if (title.includes("just a moment") || html.includes("cf-mitigated") || html.includes("challenge-platform")) {
    return "cloudflare_challenge";
  }
  if (title.includes("maintenance") || html.includes("ip-blocked") || html.includes("stake under maintenance")) {
    return "geo_or_ip_blocked";
  }
  return null;
}

async function searchViaPlaywright(game: GameRecord): Promise<{
  results: SearchResult[];
  payloads: unknown[];
}> {
  const { chromium } = await import("playwright");
  const payloads: unknown[] = [];
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  const browser = await chromium.launch({
    headless: true,
    proxy: config.stake.proxy ? { server: config.stake.proxy } : undefined,
  });

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      locale: "en-US",
    });

    if (config.stake.cfClearance) {
      await context.addCookies([
        {
          name: "cf_clearance",
          value: config.stake.cfClearance,
          domain: new URL(config.stake.baseUrl).hostname,
          path: "/",
        },
      ]);
    }

    const page = await context.newPage();

    page.on("response", async (response) => {
      try {
        const url = response.url();
        if (!url.includes("graphql") && !url.includes("/_api/")) return;
        const ct = response.headers()["content-type"] ?? "";
        if (!ct.includes("json")) return;
        const json = await response.json();
        payloads.push(json);
        const data = (json as { data?: Record<string, unknown> }).data;
        if (data) ingestGraphqlData(data, results, seen);
      } catch {
        /* ignore non-json */
      }
    });

    await page.goto(`${config.stake.baseUrl}/casino/home`, {
      waitUntil: "domcontentloaded",
      timeout: config.requestTimeout,
    });
    await page.waitForTimeout(2000);

    const blocked = await pageLooksBlocked(page);
    if (blocked) {
      throw new Error(
        `stake_blocked:${blocked}. Provide STAKE_PROXY and/or STAKE_CF_CLEARANCE + STAKE_ACCESS_TOKEN for this network.`,
      );
    }

    const slug = slugifyGameName(game.name);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (config.stake.accessToken) headers["x-access-token"] = config.stake.accessToken;

    // Run GraphQL inside the browser so Cloudflare cookies apply
    for (const q of SEARCH_QUERIES) {
      const variables = q.name === "SlugCasinoGame" ? { slug } : { query: game.name };
      try {
        const json = await page.evaluate(
          async ({ endpoint, query, variables, operationName, headers }) => {
            const res = await fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify({ query, variables, operationName }),
              credentials: "include",
            });
            return res.json();
          },
          {
            endpoint: `${config.stake.baseUrl}/_api/graphql`,
            query: q.query,
            variables,
            operationName: q.name,
            headers,
          },
        );
        payloads.push(json);
        const data = (json as { data?: Record<string, unknown> }).data;
        if (data) ingestGraphqlData(data, results, seen);
        if (results.length) break;
      } catch {
        /* try next query shape */
      }
    }

    // Navigate game page as another signal source
    await page.goto(`${config.stake.baseUrl}/casino/games/${slug}`, {
      waitUntil: "domcontentloaded",
      timeout: config.requestTimeout,
    });
    await page.waitForTimeout(2000);

    const search = page.locator('input[type="search"], input[placeholder*="Search" i]').first();
    if (await search.count()) {
      await search.fill(game.name);
      await page.waitForTimeout(2000);
    }

    const tiles = await page.evaluate(`(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/casino/games/"]'));
      return anchors.slice(0, 40).map((a) => {
        const el = a;
        const img = el.querySelector("img");
        return {
          href: el.href,
          title: el.getAttribute("aria-label") || el.textContent || (img && img.alt) || "",
          thumb: (img && (img.currentSrc || img.src)) || null,
        };
      });
    })()`) as Array<{ href: string; title: string; thumb: string | null }>;

    for (const tile of tiles) {
      const title = (tile.title || "").replace(/\s+/g, " ").trim();
      if (!title) continue;
      const slugFromUrl = tile.href.split("/casino/games/")[1]?.split(/[?#]/)[0] ?? null;
      if (seen.has(tile.href)) continue;
      seen.add(tile.href);
      results.push({
        title,
        slug: slugFromUrl,
        url: tile.href,
        thumbnailUrl: tile.thumb,
      });
    }

    return { results, payloads };
  } finally {
    await browser.close();
  }
}

let httpAvailable: boolean | null = null;
let playwrightNeeded: boolean | null = null;

async function ensureTransport(): Promise<"http" | "playwright"> {
  if (httpAvailable === true) return "http";
  if (httpAvailable === false) return "playwright";

  try {
    await fetchText(`${config.stake.baseUrl}/casino/home`, {
      proxy: config.stake.proxy || undefined,
      retries: 0,
      label: "stake-probe",
    });
    httpAvailable = true;
    playwrightNeeded = false;
    return "http";
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 503)) {
      // Still try GraphQL — sometimes HTML is challenged but API works with tokens
    } else {
      logger.debug(`Stake home probe failed: ${(err as Error).message}`);
    }

    try {
      await graphql<Record<string, unknown>>(
        "query Probe { __typename }",
        {},
        "Probe",
      );
      httpAvailable = true;
      playwrightNeeded = false;
      return "http";
    } catch {
      httpAvailable = false;
      playwrightNeeded = true;
      logger.warn(
        "Stake HTTP/GraphQL unavailable (Cloudflare or geo-block); Playwright fallback enabled. Set STAKE_CF_CLEARANCE / STAKE_ACCESS_TOKEN or STAKE_PROXY if needed.",
      );
      return "playwright";
    }
  }
}

export const stakeSource: GameImageSource = {
  name: "stake",
  expectedRatio: getSourceConfig("stake")?.expectedRatio ?? "portrait",
  priority: getSourceConfig("stake")?.priority ?? 1,
  concurrency: getSourceConfig("stake")?.concurrency ?? config.stake.concurrency,
  httpWorks: undefined,
  playwrightRequired: undefined,

  async probe() {
    const notes: string[] = [];
    let httpWorks = false;
    let playwrightRequired = false;

    try {
      const transport = await ensureTransport();
      httpWorks = transport === "http";
      playwrightRequired = transport === "playwright";
      notes.push(
        httpWorks
          ? "HTTP/GraphQL reachable"
          : "HTTP blocked; set STAKE_CF_CLEARANCE / STAKE_ACCESS_TOKEN or use proxy",
      );
    } catch (err) {
      httpWorks = false;
      playwrightRequired = true;
      notes.push(`Probe error: ${(err as Error).message}`);
    }

    return { httpWorks, playwrightRequired, notes };
  },

  async searchGame(game: GameRecord): Promise<SearchResult[]> {
    const transport = await ensureTransport();

    if (transport === "http") {
      try {
        const results = await searchViaHttp(game);
        if (results.length) return results;
      } catch (err) {
        logger.warn(`Stake HTTP search failed for ${game.name}: ${(err as Error).message}`);
        httpAvailable = false;
        playwrightNeeded = true;
      }
    }

    const { results } = await searchViaPlaywright(game);
    return results;
  },

  async extractGame(result: SearchResult): Promise<GamePageResult> {
    const transport = await ensureTransport();

    if (transport === "http") {
      try {
        const html = await fetchText(result.url, {
          proxy: config.stake.proxy || undefined,
          label: "stake-game-page",
        });
        return {
          title: result.title,
          provider: result.provider,
          slug: result.slug,
          url: result.url,
          html,
        };
      } catch (err) {
        logger.warn(`Stake page fetch failed: ${(err as Error).message}`);
      }
    }

    // Playwright page extract + network
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      proxy: config.stake.proxy ? { server: config.stake.proxy } : undefined,
    });
    try {
      const context = await browser.newContext();
      if (config.stake.cfClearance) {
        await context.addCookies([
          {
            name: "cf_clearance",
            value: config.stake.cfClearance,
            domain: new URL(config.stake.baseUrl).hostname,
            path: "/",
          },
        ]);
      }
      const page = await context.newPage();
      const payloads: unknown[] = [];
      page.on("response", async (response) => {
        try {
          if (!response.url().includes("graphql")) return;
          payloads.push(await response.json());
        } catch {
          /* ignore */
        }
      });
      await page.goto(result.url, { waitUntil: "domcontentloaded", timeout: config.requestTimeout });
      await page.waitForTimeout(2000);
      const html = await page.content();
      return {
        title: result.title,
        provider: result.provider,
        slug: result.slug,
        url: result.url,
        html,
        networkPayloads: payloads,
      };
    } finally {
      await browser.close();
    }
  },

  async extractImages(gamePage: GamePageResult): Promise<ImageCandidate[]> {
    const candidates: ImageCandidate[] = [];

    // Prefer thumbnail from search raw if present
    const rawThumb =
      (gamePage as GamePageResult & { thumbnailUrl?: string }).thumbnailUrl ||
      null;

    // Caller may pass search thumbnail via json
    if (gamePage.json && typeof gamePage.json === "object") {
      candidates.push(...discoverImagesFromJson(gamePage.json, gamePage.url));
    }

    if (gamePage.networkPayloads?.length) {
      for (const payload of gamePage.networkPayloads) {
        candidates.push(...discoverImagesFromJson(payload, gamePage.url));
      }
    }

    if (gamePage.html) {
      candidates.push(...discoverImagesFromHtml(gamePage.html, gamePage.url));
    }

    if (rawThumb) {
      candidates.unshift({
        url: rawThumb,
        alt: gamePage.title,
        sourceHint: "game-thumb",
      });
    }

    // Deduplicate
    const seen = new Set<string>();
    return candidates.filter((c) => {
      if (seen.has(c.url)) return false;
      seen.add(c.url);
      // Prefer stake/mediumrare hosts
      return true;
    });
  },
};

// Expose transport flags after probe
Object.defineProperty(stakeSource, "httpWorks", {
  get: () => httpAvailable ?? undefined,
});
Object.defineProperty(stakeSource, "playwrightRequired", {
  get: () => playwrightNeeded ?? undefined,
});
