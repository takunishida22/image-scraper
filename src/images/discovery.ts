import * as cheerio from "cheerio";
import type { ImageCandidate } from "../types.js";

const SRCSET_SPLIT = /,\s*/;

function absolutize(url: string, base: string): string | null {
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

function pushCandidate(
  out: ImageCandidate[],
  seen: Map<string, ImageCandidate>,
  partial: ImageCandidate,
  baseUrl: string,
): void {
  const abs = absolutize(partial.url, baseUrl);
  if (!abs || !/^https?:/i.test(abs)) return;

  const next: ImageCandidate = {
    ...partial,
    url: abs,
    filename: partial.filename ?? abs.split("/").pop()?.split("?")[0] ?? null,
  };

  const existing = seen.get(abs);
  if (existing) {
    // Keep richer hints / higher resolution descriptor
    const existingHint = existing.widthHint ?? (existing.densityHint ? existing.densityHint * 100 : 0);
    const nextHint = next.widthHint ?? (next.densityHint ? next.densityHint * 100 : 0);
    if (nextHint > existingHint) {
      seen.set(abs, { ...existing, ...next });
      const idx = out.findIndex((c) => c.url === abs);
      if (idx >= 0) out[idx] = seen.get(abs)!;
    }
    return;
  }

  seen.set(abs, next);
  out.push(next);
}

export interface SrcsetEntry {
  url: string;
  widthHint?: number;
  densityHint?: number;
}

/** Parse srcset retaining width (w) and density (x) descriptors. */
export function parseSrcsetEntries(srcset: string): SrcsetEntry[] {
  return srcset
    .split(SRCSET_SPLIT)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tokens = part.split(/\s+/);
      const url = tokens[0] ?? "";
      let widthHint: number | undefined;
      let densityHint: number | undefined;
      for (const token of tokens.slice(1)) {
        if (/^\d+w$/i.test(token)) {
          widthHint = Number.parseInt(token, 10);
        } else if (/^\d+(\.\d+)?x$/i.test(token)) {
          densityHint = Number.parseFloat(token);
        }
      }
      return { url, widthHint, densityHint };
    })
    .filter((e) => Boolean(e.url));
}

function extractCssBackgroundUrls(style: string): string[] {
  const urls: string[] = [];
  const re = /url\((['"]?)(.*?)\1\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(style))) {
    if (match[2]) urls.push(match[2]);
  }
  return urls;
}

export interface JsonImageHit {
  url: string;
  key: string;
  path: string;
}

function looksLikeImageUrl(value: string): boolean {
  if (/^https?:\/\/.+\.(png|jpe?g|webp|gif|avif|heic|heif)(\?|$)/i.test(value)) return true;
  if (/^https?:\/\/.*(imgix|cloudinary|cdn|image|thumb|media|mediumrare).+/i.test(value)) {
    return true;
  }
  return false;
}

function walkJsonForImages(
  value: unknown,
  out: JsonImageHit[],
  pathParts: string[] = [],
  depth = 0,
): void {
  if (depth > 8 || out.length > 200) return;

  if (typeof value === "string") {
    if (looksLikeImageUrl(value)) {
      const key = pathParts[pathParts.length - 1] ?? "value";
      out.push({ url: value, key, path: pathParts.join(".") || key });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkJsonForImages(item, out, [...pathParts, String(index)], depth + 1);
    });
    return;
  }

  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = [...pathParts, k];
      if (typeof v === "string" && (/image|thumb|poster|cover|icon|art|logo|banner/i.test(k) || looksLikeImageUrl(v))) {
        if (looksLikeImageUrl(v)) {
          out.push({ url: v, key: k, path: nextPath.join(".") });
          continue;
        }
      }
      walkJsonForImages(v, out, nextPath, depth + 1);
    }
  }
}

/**
 * Collect image candidates from HTML without picking a winner.
 */
export function discoverImagesFromHtml(html: string, pageUrl: string): ImageCandidate[] {
  const $ = cheerio.load(html);
  const out: ImageCandidate[] = [];
  const seen = new Map<string, ImageCandidate>();

  $("img").each((_, el) => {
    const node = $(el);
    const attrs = [
      "src",
      "data-src",
      "data-lazy-src",
      "data-original",
      "data-url",
      "data-image",
      "data-thumb",
    ];
    for (const attr of attrs) {
      const val = node.attr(attr);
      if (val) {
        pushCandidate(
          out,
          seen,
          {
            url: val,
            alt: node.attr("alt") ?? null,
            title: node.attr("title") ?? null,
            cssClass: node.attr("class") ?? null,
            sourceHint: `img[${attr}]`,
          },
          pageUrl,
        );
      }
    }
    const srcset = node.attr("srcset") || node.attr("data-srcset");
    if (srcset) {
      for (const entry of parseSrcsetEntries(srcset)) {
        pushCandidate(
          out,
          seen,
          {
            url: entry.url,
            alt: node.attr("alt") ?? null,
            cssClass: node.attr("class") ?? null,
            sourceHint: "img[srcset]",
            widthHint: entry.widthHint,
            densityHint: entry.densityHint,
          },
          pageUrl,
        );
      }
    }
  });

  $("picture source").each((_, el) => {
    const node = $(el);
    const srcset = node.attr("srcset");
    if (!srcset) return;
    for (const entry of parseSrcsetEntries(srcset)) {
      pushCandidate(
        out,
        seen,
        {
          url: entry.url,
          sourceHint: "picture/source",
          widthHint: entry.widthHint,
          densityHint: entry.densityHint,
        },
        pageUrl,
      );
    }
  });

  $("[style*='background']").each((_, el) => {
    const style = $(el).attr("style") ?? "";
    for (const u of extractCssBackgroundUrls(style)) {
      pushCandidate(
        out,
        seen,
        { url: u, cssClass: $(el).attr("class") ?? null, sourceHint: "css-background" },
        pageUrl,
      );
    }
  });

  $('meta[property="og:image"], meta[name="og:image"], meta[property="og:image:url"]').each(
    (_, el) => {
      const content = $(el).attr("content");
      if (content) {
        pushCandidate(out, seen, { url: content, sourceHint: "og:image" }, pageUrl);
      }
    },
  );

  $('meta[name="twitter:image"], meta[property="twitter:image"]').each((_, el) => {
    const content = $(el).attr("content");
    if (content) {
      pushCandidate(out, seen, { url: content, sourceHint: "twitter:image" }, pageUrl);
    }
  });

  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).html();
    if (!text) return;
    try {
      const hits: JsonImageHit[] = [];
      walkJsonForImages(JSON.parse(text), hits);
      for (const hit of hits) {
        pushCandidate(
          out,
          seen,
          {
            url: hit.url,
            sourceHint: `json-ld:${hit.key}`,
            context: hit.path,
          },
          pageUrl,
        );
      }
    } catch {
      /* ignore invalid json-ld */
    }
  });

  const nextData = $("#__NEXT_DATA__").html();
  if (nextData) {
    try {
      const hits: JsonImageHit[] = [];
      walkJsonForImages(JSON.parse(nextData), hits);
      for (const hit of hits) {
        pushCandidate(
          out,
          seen,
          {
            url: hit.url,
            sourceHint: `__NEXT_DATA__:${hit.key}`,
            context: hit.path,
          },
          pageUrl,
        );
      }
    } catch {
      /* ignore */
    }
  }

  $("script").each((_, el) => {
    const text = $(el).html() ?? "";
    if (!text.includes("__NUXT__") && !text.includes("thumbnail") && !text.includes("imgix")) {
      return;
    }
    const urlMatches = text.match(/https?:\/\/[^"'\\\s>]+\.(?:png|jpe?g|webp|gif|avif)/gi) ?? [];
    for (const u of urlMatches) {
      pushCandidate(out, seen, { url: u, sourceHint: "embedded-script" }, pageUrl);
    }
  });

  return out;
}

export function discoverImagesFromJson(payload: unknown, baseUrl: string): ImageCandidate[] {
  const hits: JsonImageHit[] = [];
  walkJsonForImages(payload, hits);
  const out: ImageCandidate[] = [];
  const seen = new Map<string, ImageCandidate>();
  for (const hit of hits) {
    pushCandidate(
      out,
      seen,
      {
        url: hit.url,
        sourceHint: `json:${hit.key}`,
        context: hit.path,
      },
      baseUrl,
    );
  }
  return out;
}
