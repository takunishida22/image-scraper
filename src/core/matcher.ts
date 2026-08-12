import { config } from "../config/index.js";
import {
  hasMeaningfulVariantDiff,
  normalizeGameName,
  providerNormalize,
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

export function scoreSearchMatch(
  game: GameRecord,
  result: SearchResult,
): MatchScoreBreakdown {
  const reasons: string[] = [];
  let total = 0;

  const wanted = normalizeGameName(game.name);
  const found = normalizeGameName(result.title);
  const wantedSlug = slugifyGameName(game.name);
  const foundSlug = result.slug ? slugifyGameName(result.slug) : slugifyGameName(result.title);

  if (wanted && found && wanted === found) {
    total += 100;
    reasons.push("exact_normalized_title:+100");
  } else if (wanted && found && (found.startsWith(wanted + " ") || wanted.startsWith(found + " "))) {
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

  const wantedProvider = providerNormalize(game.provider);
  const foundProvider = providerNormalize(result.provider);
  if (wantedProvider && foundProvider) {
    if (wantedProvider === foundProvider) {
      total += 30;
      reasons.push("exact_provider_match:+30");
    } else {
      total -= 50;
      reasons.push("different_provider:-50");
    }
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
      } else {
        total -= 80;
        reasons.push("generic_casino_artwork:-80");
      }
      break;
    }
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

  if (wanted && filename && (filename === wanted || filename === slugifyGameName(game.name).replace(/-/g, " "))) {
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

function extractFilename(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  } catch {
    return url.split("/").pop() ?? "";
  }
}
