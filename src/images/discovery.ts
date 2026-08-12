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
  seen: Set<string>,
  partial: ImageCandidate,
  baseUrl: string,
): void {
  const abs = absolutize(partial.url, baseUrl);
  if (!abs || seen.has(abs)) return;
  if (!/^https?:/i.test(abs)) return;
  seen.add(abs);
  out.push({ ...partial, url: abs, filename: partial.filename ?? abs.split("/").pop() ?? null });
}

function parseSrcset(srcset: string): string[] {
  return srcset
    .split(SRCSET_SPLIT)
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean) as string[];
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

function walkJsonForImages(value: unknown, out: string[], depth = 0): void {
  if (depth > 8 || out.length > 200) return;
  if (typeof value === "string") {
    if (/^https?:\/\/.+\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(value)) {
      out.push(value);
    } else if (/^https?:\/\/.*(imgix|cloudinary|cdn|image|thumb|media).+/i.test(value)) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkJsonForImages(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/image|thumb|poster|cover|icon|art/i.test(k) && typeof v === "string") {
        out.push(v);
      }
      walkJsonForImages(v, out, depth + 1);
    }
  }
}

/**
 * Collect image candidates from HTML without picking a winner.
 */
export function discoverImagesFromHtml(html: string, pageUrl: string): ImageCandidate[] {
  const $ = cheerio.load(html);
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();

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
      for (const u of parseSrcset(srcset)) {
        pushCandidate(
          out,
          seen,
          {
            url: u,
            alt: node.attr("alt") ?? null,
            cssClass: node.attr("class") ?? null,
            sourceHint: "img[srcset]",
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
    for (const u of parseSrcset(srcset)) {
      pushCandidate(out, seen, { url: u, sourceHint: "picture/source" }, pageUrl);
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
      const json = JSON.parse(text);
      const urls: string[] = [];
      walkJsonForImages(json, urls);
      for (const u of urls) {
        pushCandidate(out, seen, { url: u, sourceHint: "json-ld" }, pageUrl);
      }
    } catch {
      /* ignore invalid json-ld */
    }
  });

  // Next.js / Nuxt payloads
  const nextData = $("#__NEXT_DATA__").html();
  if (nextData) {
    try {
      const urls: string[] = [];
      walkJsonForImages(JSON.parse(nextData), urls);
      for (const u of urls) {
        pushCandidate(out, seen, { url: u, sourceHint: "__NEXT_DATA__" }, pageUrl);
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
  const urls: string[] = [];
  walkJsonForImages(payload, urls);
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    pushCandidate(out, seen, { url: u, sourceHint: "json-payload" }, baseUrl);
  }
  return out;
}
