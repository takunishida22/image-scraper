import { config } from "../config/index.js";
import {
  hasMeaningfulVariantDiff,
  normalizeGameName,
  slugifyGameName,
} from "./normalizer.js";
import type { GameRecord, ImageCandidate, MatchScoreBreakdown, SearchResult } from "../types.js";

const REJECT_PATTERNS = [
  /\blogo\b/i,
  /\bfavicon\b/i,
  /\bavatar\b/i,
  /\bplaceholder\b/i,
  /\bspinner\b/i,
  /\bloading\b/i,
  /\bbanner\b/i,
  /\bhero\b/i,
  /\bnav\b/i,
  /\bicon\b/i,
  /\bpayment\b/i,
  /\bsocial\b/i,
  /\bfacebook\b/i,
  /\btwitter\b/i,
  /\binstagram\b/i,
  /\btelegram\b/i,
  /\bprovider[-_]?logo\b/i,
  /\bcasino[-_]?logo\b/i,
  /1x1\.(gif|png|webp)/i,
  /pixel\.(gif|png)/i,
];

/** Game tile / cover art — keep these even though filenames often contain "logo". */
const GAME_TILE_ART =
  /\bslot[-_]?logo\b|\bgame[-_]?logo\b|\bgame[-_]?tile\b|\bcover[-_]?art\b|\bkey[-_]?art\b|\bgame[-_]?thumb\b/i;

const LOGO_CONTEXT = /\b(logo|icon|favicon|providerLogo|provider_logo|casinoLogo)\b/i;
const GOOD_CONTEXT = /\b(thumbnail|thumb|cover|coverImage|gameImage|game_image|artwork|poster|tile|slot-logo|game-thumb)\b/i;

export function scoreSearchMatch(
  game: GameRecord,
  result: SearchResult,
): MatchScoreBreakdown {
  const reasons: string[] = [];
  let total = 0;

  // result.title is source display name (BC.Game: fullName — not gameIdentity.gameName)
  // Provider is ignored: same normalized name → accept.
  const wanted = normalizeGameName(game.name);
  const found = normalizeGameName(result.title);
  const wantedSlug = slugifyGameName(game.name);
  const foundSlug = result.slug ? slugifyGameName(result.slug) : slugifyGameName(result.title);

  if (wanted && found && wanted === found) {
    total += 100;
    reasons.push("exact_normalized_title:+100");
  } else if (wanted && found && (found.startsWith(wanted + "-") || wanted.startsWith(found + "-"))) {
    total += 20;
    reasons.push("strong_partial_title:+20");
  } else if (wanted && found && (found.includes(wanted) || wanted.includes(found))) {
    total += 10;
    reasons.push("weak_partial_title:+10");
  }

  if (hasMeaningfulVariantDiff(game.name, result.title)) {
    total -= 70;
    reasons.push("different_version_suffix:-70");
  }

  if (wantedSlug && foundSlug && wantedSlug === foundSlug) {
    total += 30;
    reasons.push("exact_slug_match:+30");
  }

  return { total, reasons };
}

export function scoreImageCandidate(
  game: GameRecord,
  candidate: ImageCandidate,
): MatchScoreBreakdown {
  const reasons: string[] = [];
  let total = 0;

  const blob = [
    candidate.url,
    candidate.alt,
    candidate.title,
    candidate.filename,
    candidate.context,
    candidate.cssClass,
    candidate.sourceHint,
  ]
    .filter(Boolean)
    .join(" ");

  const isGameTile = GAME_TILE_ART.test(blob);
  if (isGameTile) {
    total += 60;
    reasons.push("game_tile_art:+60");
  } else {
    for (const pattern of REJECT_PATTERNS) {
      if (pattern.test(blob)) {
        if (/logo/i.test(pattern.source)) {
          total -= 100;
          reasons.push("logo:-100");
        } else if (/banner|hero/i.test(pattern.source)) {
          total -= 60;
          reasons.push("banner:-60");
        } else if (/placeholder|spinner|loading|1x1|pixel/i.test(pattern.source)) {
          total -= 100;
          reasons.push("placeholder:-100");
        } else if (/\bicon\b/i.test(pattern.source)) {
          total -= 80;
          reasons.push("icon:-80");
        } else {
          total -= 80;
          reasons.push("generic_casino_artwork:-80");
        }
        break;
      }
    }
  }

  const contextBlob = `${candidate.context ?? ""} ${candidate.sourceHint ?? ""}`;
  if (!isGameTile && LOGO_CONTEXT.test(contextBlob)) {
    total -= 90;
    reasons.push("logo_context:-90");
  } else if (GOOD_CONTEXT.test(contextBlob)) {
    total += 25;
    reasons.push("good_image_context:+25");
  }

  const wanted = normalizeGameName(game.name);
  const alt = normalizeGameName(candidate.alt ?? "");
  const filename = normalizeGameName(
    (candidate.filename ?? extractFilename(candidate.url)).replace(/\.[a-z0-9]+$/i, ""),
  );

  if (wanted && alt && alt === wanted) {
    total += 20;
    reasons.push("alt_exact_game_match:+20");
  }

  if (
    wanted &&
    filename &&
    (filename === wanted || filename === slugifyGameName(game.name))
  ) {
    total += 20;
    reasons.push("filename_exact_game_match:+20");
  }

  if (candidate.sourceHint?.includes("og:image") || candidate.sourceHint?.includes("json-ld")) {
    total += 15;
    reasons.push("metadata_image:+15");
  }

  if (candidate.sourceHint?.includes("game-thumb") || candidate.sourceHint?.includes("thumbnail")) {
    total += 25;
    reasons.push("thumbnail_context:+25");
  }

  // Prefer larger native srcset candidates (hints only — never invent URLs)
  if (typeof candidate.widthHint === "number" && candidate.widthHint > 0) {
    const bonus = Math.min(40, Math.floor(candidate.widthHint / 40));
    total += bonus;
    reasons.push(`srcset_width_hint:+${bonus}`);
  }
  if (typeof candidate.densityHint === "number" && candidate.densityHint > 0) {
    const bonus = Math.min(30, Math.round(candidate.densityHint * 10));
    total += bonus;
    reasons.push(`srcset_density_hint:+${bonus}`);
  }

  return { total, reasons };
}

export type MatchDecision = "accept" | "review" | "reject";

export function decideMatch(
  score: number,
  accept = config.matchAcceptThreshold,
  review = config.matchReviewThreshold,
): MatchDecision {
  if (score >= accept) return "accept";
  if (score >= review) return "review";
  return "reject";
}

/** Rank candidates: score desc, then width/density hints desc. */
export function rankImageCandidates(
  game: GameRecord,
  candidates: ImageCandidate[],
): Array<{ candidate: ImageCandidate; score: number; breakdown: MatchScoreBreakdown }> {
  return candidates
    .map((candidate) => {
      const breakdown = scoreImageCandidate(game, candidate);
      return { candidate, score: breakdown.total, breakdown };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aw = a.candidate.widthHint ?? 0;
      const bw = b.candidate.widthHint ?? 0;
      if (bw !== aw) return bw - aw;
      const ad = a.candidate.densityHint ?? 0;
      const bd = b.candidate.densityHint ?? 0;
      return bd - ad;
    });
}

function extractFilename(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  } catch {
    return url.split("/").pop() ?? "";
  }
}
