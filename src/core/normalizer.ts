/**
 * Robust game-name normalization.
 * Meaningful suffixes/numbers (e.g. "1000", "Xmas") are preserved.
 */
export function normalizeGameName(input: string): string {
  if (!input) return "";

  let s = input;

  // Strip trademark symbols before NFKC (which would expand ™ → "TM")
  s = s.replace(/[\u2122\u00AE\u00A9]/g, "");
  s = s.normalize("NFKC");

  s = s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    );

  s = s.replace(/[’‘‛]/g, "'").replace(/[“”„]/g, '"');

  // URL slug style
  s = s.replace(/[-_+/\\|]+/g, " ");

  // Drop most punctuation but keep digits and letters
  s = s.replace(/[^\p{L}\p{N}\s']/gu, " ");

  s = s.toLowerCase();
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

export function slugifyGameName(input: string): string {
  return normalizeGameName(input).replace(/\s+/g, "-");
}

/**
 * Detect version/variant suffix differences that should not auto-match.
 * e.g. "sweet bonanza" vs "sweet bonanza 1000"
 */
export function hasMeaningfulVariantDiff(a: string, b: string): boolean {
  const na = normalizeGameName(a);
  const nb = normalizeGameName(b);
  if (na === nb) return false;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;

  if (!longer.startsWith(shorter + " ") && !longer.startsWith(shorter)) {
    return false;
  }

  const remainder = longer.slice(shorter.length).trim();
  if (!remainder) return false;

  // Common variant markers / extra tokens
  const variantPattern =
    /^(1000|500|xmas|christmas|dice|hold\s*and\s*spin|megaways|deluxe|plus|super|extreme|bonus\s*buy|buy\s*bonus|jackpot|vip|live|mini|max|xxxtreme|power\s*reels)\b/i;

  if (variantPattern.test(remainder)) return true;

  // Any leftover alphanumeric suffix counts as a different game version
  return /[a-z0-9]/i.test(remainder);
}

export function providerNormalize(provider: string | null | undefined): string {
  if (!provider) return "";
  return normalizeGameName(provider);
}
