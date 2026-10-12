/**
 * Canonical lowercase form used for slugs, provider keys, and name equality.
 * Meaningful suffixes/numbers (e.g. "1000", "Xmas") are preserved.
 */
export function canonicalizeGameName(input: string): string {
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

  // Only letters, numbers, and '-'; quotes and every other character become '-'
  s = s.replace(/[^\p{L}\p{N}]+/gu, "-");
  s = s.toLowerCase();
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");

  return s;
}

/** Uppercase only the first character when it is a letter; leave leading digits as-is. */
function capitalizeFirstLetter(input: string): string {
  if (!input) return "";
  const chars = [...input];
  const first = chars[0];
  if (first && /\p{L}/u.test(first)) {
    chars[0] = first.toLocaleUpperCase("en-US");
  }
  return chars.join("");
}

/**
 * Normalized game key: letters, numbers, and '-', first letter uppercase
 * (e.g. "Sweet-bonanza"). Leading digits are unchanged ("3-lucky-baozhu").
 */
export function normalizeGameName(input: string): string {
  return capitalizeFirstLetter(canonicalizeGameName(input));
}

export function slugifyGameName(input: string): string {
  return canonicalizeGameName(input);
}

/** On-disk folder segment: first letter uppercase, e.g. "Sweet-bonanza". */
export function gameFolderSlug(input: string): string {
  return capitalizeFirstLetter(slugifyGameName(input)) || "game";
}

/** Fix an existing folder slug: drop __id, keep only letter/number/'-'. */
export function correctFolderSlug(existingSlug: string): string {
  if (!existingSlug) return existingSlug;
  return gameFolderSlug(existingSlug.replace(/__\d+$/, ""));
}

/**
 * Detect version/variant suffix differences that should not auto-match.
 * e.g. "sweet bonanza" vs "sweet bonanza 1000"
 */
export function hasMeaningfulVariantDiff(a: string, b: string): boolean {
  const na = canonicalizeGameName(a);
  const nb = canonicalizeGameName(b);
  if (na === nb) return false;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;

  if (!longer.startsWith(shorter + "-") && !longer.startsWith(shorter)) {
    return false;
  }

  const remainder = longer.slice(shorter.length).replace(/^-+/, "").trim();
  if (!remainder) return false;

  // Common variant markers / extra tokens (hyphens already normalized to spaces)
  const remainderSpaced = remainder.replace(/-/g, " ");
  const variantPattern =
    /^(1000|500|xmas|christmas|dice|hold\s*and\s*spin|megaways|deluxe|plus|super|extreme|bonus\s*buy|buy\s*bonus|jackpot|vip|live|mini|max|xxxtreme|power\s*reels)\b/i;

  if (variantPattern.test(remainderSpaced)) return true;

  // Any leftover alphanumeric suffix counts as a different game version
  return /[a-z0-9]/i.test(remainder);
}

/**
 * Collapse provider labels so "Evolution" ≈ "Evolution Gaming",
 * "Nolimit City" ≈ "NoLimitCity", "Play'n GO" ≈ "Playn GO".
 */
export function providerNormalize(provider: string | null | undefined): string {
  if (!provider) return "";
  let s = canonicalizeGameName(provider).replace(/-/g, "");

  // Drop noisy corporate suffixes after space-collapse
  s = s.replace(/(interactive|studios?|gaming|games|soft)$/i, "");

  const aliases: Record<string, string> = {
    evolution: "evolution",
    evo: "evolution",
    nolimitcity: "nolimitcity",
    nolimit: "nolimitcity",
    nlc: "nolimitcity",
    pragmaticplay: "pragmaticplay",
    pragmatic: "pragmaticplay",
    pp: "pragmaticplay",
    playngo: "playngo",
    png: "playngo",
    hacksaw: "hacksaw",
    hacksawgaming: "hacksaw",
    pg: "pg",
    pgsoft: "pg",
    push: "pushgaming",
    pushgaming: "pushgaming",
    bigtimegaming: "bigtimegaming",
    btg: "bigtimegaming",
    spribe: "spribe",
    bgaming: "bgaming",
    tada: "tada",
    fachai: "fachai",
  };
  return aliases[s] ?? s;
}
