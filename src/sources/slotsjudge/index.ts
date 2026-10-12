import * as cheerio from "cheerio";
import { config, getSourceConfig } from "../../config/index.js";
import { discoverImagesFromHtml } from "../../images/discovery.js";
import type { GameImageSource } from "../SourceAdapter.js";
import type { GamePageResult, GameRecord, ImageCandidate, SearchResult } from "../../types.js";
import { fetchText, HttpError } from "../../utils/http.js";
import { logger } from "../../utils/logger.js";
import { slugifyGameName } from "../../core/normalizer.js";

const BASE = "https://slotsjudge.com";
const CACHE_SIZE_SUFFIX = /-\d+x\d+(?:sw|sh|s|ch|cw|w|h)?(?=\.(?:jpe?g|png|webp|gif))/i;

export function slotsjudgeSlug(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function slotsjudgeSlugCandidates(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const slug = raw.replace(/^-+|-+$/g, "");
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  };

  const base = slotsjudgeSlug(name);
  push(base);
  push(slugifyGameName(name).replace(/'/g, ""));

  const aposAsHyphen = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]s\b/g, "-s")
    .replace(/['’]/g, "-")
    .replace(/[^a-z0-9]+/g, "-");
  push(aposAsHyphen);

  if (base.startsWith("the-")) push(base.slice(4));
  push(base.replace(/-x-?ways$/, "").replace(/-x-?bomb$/, "").replace(/-megaways$/, ""));
  push(base.replace(/-r-i-p$/, "-rip"));
  push(base.replace(/-rip$/, "-r-i-p"));

  return out;
}

export function unwrapSlotsjudgeImageUrl(url: string): string {
  return url
    .replace("/image/cache/data/", "/image/data/")
    .replace(CACHE_SIZE_SUFFIX, "");
}

function titleLooksLike404(html: string): boolean {
  return /oops!?\s*sorry,\s*this page is not found/i.test(html);
}

function extractProvider(html: string): string | null {
  const $ = cheerio.load(html);
  const href =
    $('a[href*="/software-providers/"]').first().attr("href") ??
    $('a[href*="/software-provider/"]').first().attr("href");
  if (!href) return null;
  const slug = href.split("/software-providers/")[1]?.split(/[/?#]/)[0];
  if (!slug) return null;
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function extractH1(html: string): string | null {
  const $ = cheerio.load(html);
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  if (!h1) return null;
  return h1.replace(/\s+slot\b.*/i, "").trim() || h1;
}

function isGameArtworkUrl(url: string, slug: string): boolean {
  const u = url.toLowerCase();
  if (!u.includes("/image/")) return false;
  if (u.includes("/casino/") || u.includes("/authors/") || u.includes("/user-") || u.includes("/banners/")) {
    return false;
  }
  if (u.includes("/site/view/theme/")) return false;
  return u.includes(`/slots/${slug}/`) || u.includes(`/${slug}-`);
}

/** Prefer tile logos; drop gameplay screenshots / paytables / casino promo banners. */
function isSlotsjudgeGameLogo(url: string): boolean {
  const u = url.toLowerCase();
  if (!/slot[-_]?logo/.test(u)) return false;
  if (/gameplay|paytable|bonus|mobile|ante-bet|free-spins|tumble|multiplier|casino/.test(u)) {
    return false;
  }
  return true;
}

function cacheWidthHint(url: string): number | undefined {
  const m = url.match(/-(\d+)x\d+(?:sw|sh|s|ch|cw|w|h)?\.(?:jpe?g|png|webp|gif)/i);
  if (!m?.[1]) return undefined;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const html = await fetchText(url, { retries: 1, label: "slotsjudge-page" });
    if (titleLooksLike404(html)) return null;
    return html;
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return null;
    throw err;
  }
}

async function searchGame(game: GameRecord): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const slug of slotsjudgeSlugCandidates(game.name)) {
    const url = `${BASE}/online-slots/${slug}/`;
    if (seen.has(url)) continue;
    seen.add(url);

    let html: string | null;
    try {
      html = await fetchPage(url);
    } catch (err) {
      logger.debug(`SlotsJudge probe failed for ${slug}: ${(err as Error).message}`);
      continue;
    }
    if (!html) continue;

    const provider = extractProvider(html) ?? game.provider;
    results.push({
      title: game.name,
      provider,
      slug,
      url,
      thumbnailUrl: null,
      raw: { html, h1: extractH1(html), pageSlug: slug },
    });
    break;
  }

  return results;
}

async function extractGame(result: SearchResult): Promise<GamePageResult> {
  const cachedHtml = typeof result.raw?.html === "string" ? result.raw.html : null;
  const html = cachedHtml ?? (await fetchPage(result.url));
  if (!html) {
    throw new Error(`SlotsJudge page missing: ${result.url}`);
  }
  return {
    title: result.title,
    provider: result.provider ?? extractProvider(html),
    slug: result.slug,
    url: result.url,
    html,
    json: { h1: extractH1(html), pageSlug: result.slug },
  };
}

async function extractImages(gamePage: GamePageResult): Promise<ImageCandidate[]> {
  if (!gamePage.html) return [];
  const slug = gamePage.slug || slugifyGameName(gamePage.title);
  const discovered = discoverImagesFromHtml(gamePage.html, gamePage.url);
  const logos: ImageCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of discovered) {
    if (!isGameArtworkUrl(candidate.url, slug)) continue;
    if (!isSlotsjudgeGameLogo(candidate.url)) continue;
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    logos.push({
      ...candidate,
      filename: candidate.url.split("/").pop()?.split("?")[0] ?? candidate.filename,
      widthHint: candidate.widthHint ?? cacheWidthHint(candidate.url),
      sourceHint: "slot-logo",
      context: "slotsjudge.game-tile",
    });
  }

  if (!logos.length) return [];

  const caches = logos
    .filter((c) => typeof c.widthHint === "number" && c.widthHint > 0)
    .sort((a, b) => (b.widthHint ?? 0) - (a.widthHint ?? 0));
  const bestCache = caches[0];
  const originalUrl = bestCache
    ? unwrapSlotsjudgeImageUrl(bestCache.url)
    : unwrapSlotsjudgeImageUrl(logos[0]!.url);

  const out: ImageCandidate[] = [];
  const push = (url: string, widthHint?: number) => {
    if (seen.has(`out:${url}`)) return;
    seen.add(`out:${url}`);
    out.push({
      url,
      alt: bestCache?.alt ?? logos[0]?.alt ?? null,
      filename: url.split("/").pop()?.split("?")[0] ?? null,
      widthHint,
      sourceHint: "slot-logo",
      context: "slotsjudge.game-tile",
    });
  };

  // Original first (often larger than cache), then largest known cache as fallback
  push(originalUrl, bestCache?.widthHint);
  if (bestCache && bestCache.url !== originalUrl) {
    push(bestCache.url, bestCache.widthHint);
  }
  return out;
}

const sourceCfg = getSourceConfig("slotsjudge");

export const slotsjudgeSource: GameImageSource = {
  name: "slotsjudge",
  implemented: true,
  enabled: sourceCfg?.enabled ?? true,
  expectedRatio: sourceCfg?.expectedRatio ?? "unknown",
  priority: sourceCfg?.priority ?? 2,
  concurrency: sourceCfg?.concurrency ?? config.concurrency,
  httpWorks: true,
  playwrightRequired: false,

  async probe() {
    try {
      const html = await fetchPage(`${BASE}/online-slots/gates-of-olympus/`);
      const ok = Boolean(html);
      return {
        httpWorks: ok,
        playwrightRequired: false,
        notes: ok
          ? ["SlotsJudge HTTP reachable"]
          : ["SlotsJudge probe page missing; site may have changed"],
      };
    } catch (err) {
      return {
        httpWorks: false,
        playwrightRequired: false,
        notes: [`Probe error: ${(err as Error).message}`],
      };
    }
  },

  searchGame,
  extractGame,
  extractImages,
};
