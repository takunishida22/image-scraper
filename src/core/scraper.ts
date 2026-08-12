import { config, getSourceConfig, sourcesForType } from "../config/index.js";
import {
  bumpSourceStat,
  getImageByType,
  listGames,
  recoverStaleProcessing,
  refreshGameCompletionStatus,
  updateGameStatus,
} from "../database/db.js";
import { downloadAndStoreImage } from "../images/downloader.js";
import { decideMatch, scoreImageCandidate, scoreSearchMatch } from "./matcher.js";
import { createLimiter } from "./queue.js";
import { getSource, listSources } from "../sources/registry.js";
import type { GameImageSource } from "../sources/SourceAdapter.js";
import type { GameRecord, ImageType, ScrapeOptions, SearchResult } from "../types.js";
import { logFailedGame, logReviewNeeded, logger } from "../utils/logger.js";

function resolveSources(options: ScrapeOptions): GameImageSource[] {
  if (options.source) {
    return [getSource(options.source)];
  }
  if (options.type) {
    const names = sourcesForType(options.type);
    return names.map((n) => getSource(n)).filter((s) => {
      try {
        // Skip stubs that aren't implemented when type-based selection includes them
        return s.name === "stake" || Boolean(getSourceConfig(s.name)?.enabled);
      } catch {
        return false;
      }
    });
  }
  return listSources().filter((s) => s.name === "stake");
}

function selectGames(options: ScrapeOptions, targetType?: ImageType): GameRecord[] {
  if (options.missingOnly && targetType) {
    return listGames({ missingType: targetType, limit: options.limit });
  }
  if (options.missingOnly && options.source) {
    const source = getSource(options.source);
    const expected = source.expectedRatio;
    if (expected && expected !== "unknown" && expected !== "other") {
      return listGames({ missingType: expected, limit: options.limit });
    }
  }
  return listGames({ limit: options.limit });
}

async function processGameWithSource(
  game: GameRecord,
  source: GameImageSource,
  options: ScrapeOptions,
  targetType?: ImageType,
): Promise<"downloaded" | "skipped" | "review" | "failed" | "rejected"> {
  bumpSourceStat(source.name, "attempted");

  if (targetType && !options.overwrite) {
    const existing = getImageByType(game.id, targetType);
    if (existing) {
      logger.info(`Skip ${game.name}: ${targetType} already exists`);
      return "skipped";
    }
  }

  // If source has expected ratio and that type already exists, skip unless overwrite
  const expected = source.expectedRatio;
  if (
    expected &&
    expected !== "unknown" &&
    expected !== "other" &&
    !options.overwrite &&
    getImageByType(game.id, expected)
  ) {
    logger.info(`Skip ${game.name}: ${expected} already exists for expected source ratio`);
    return "skipped";
  }

  updateGameStatus(game.id, "processing");

  let searchResults: SearchResult[];
  try {
    searchResults = await source.searchGame(game);
  } catch (err) {
    const reason = `search_failed: ${(err as Error).message}`;
    bumpSourceStat(source.name, "failed");
    updateGameStatus(game.id, "failed");
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason,
    });
    return "failed";
  }

  if (!searchResults.length) {
    bumpSourceStat(source.name, "failed");
    updateGameStatus(game.id, "failed");
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: "no_search_results",
    });
    return "failed";
  }

  const scored = searchResults
    .map((r) => ({ result: r, match: scoreSearchMatch(game, r) }))
    .sort((a, b) => b.match.total - a.match.total);

  const best = scored[0]!;
  const decision = decideMatch(best.match.total);

  if (decision === "reject") {
    bumpSourceStat(source.name, "failed");
    updateGameStatus(game.id, "failed");
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: `match_rejected:${best.match.total}:${best.match.reasons.join("|")}`,
    });
    return "rejected";
  }

  if (decision === "review") {
    bumpSourceStat(source.name, "review");
    updateGameStatus(game.id, "review");
    logReviewNeeded({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: `match_review:${best.match.total}:${best.result.title}:${best.match.reasons.join("|")}`,
    });
    return "review";
  }

  bumpSourceStat(source.name, "matched");

  if (options.dryRun) {
    logger.info(`[dry-run] Would extract images for ${game.name} <- ${best.result.title}`);
    refreshGameCompletionStatus(game.id);
    return "skipped";
  }

  let page;
  try {
    page = await source.extractGame(best.result);
    // Carry search thumbnail into extractImages via json
    page.json = {
      ...(typeof page.json === "object" && page.json ? page.json : {}),
      thumbnailUrl: best.result.thumbnailUrl,
      search: best.result.raw,
    };
  } catch (err) {
    const reason = `extract_failed: ${(err as Error).message}`;
    bumpSourceStat(source.name, "failed");
    updateGameStatus(game.id, "failed");
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason,
    });
    return "failed";
  }

  let candidates;
  try {
    candidates = await source.extractImages(page);
  } catch (err) {
    bumpSourceStat(source.name, "failed");
    updateGameStatus(game.id, "failed");
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: `image_extract_failed: ${(err as Error).message}`,
    });
    return "failed";
  }

  if (best.result.thumbnailUrl) {
    candidates.unshift({
      url: best.result.thumbnailUrl,
      alt: best.result.title,
      sourceHint: "game-thumb",
    });
  }

  const ranked = candidates
    .map((c) => {
      const score = scoreImageCandidate(game, c);
      return { candidate: c, score: score.total + best.match.total * 0.1, breakdown: score };
    })
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    bumpSourceStat(source.name, "failed");
    updateGameStatus(game.id, "failed");
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: "no_image_candidates",
    });
    return "failed";
  }

  const proxy = getSourceConfig(source.name)?.proxy || undefined;
  let savedAny = false;
  let lastReason = "unknown";

  for (const item of ranked.slice(0, 8)) {
    if (item.breakdown.total <= -50) continue;
    try {
      const saved = await downloadAndStoreImage({
        game,
        url: item.candidate.url,
        source: source.name,
        confidence: best.match.total,
        overwrite: options.overwrite,
        proxy,
        preferType: targetType,
      });
      if (saved.saved) {
        savedAny = true;
        bumpSourceStat(source.name, "downloaded");
        // If we got the target type, stop; otherwise keep looking for better candidates of needed types
        if (!targetType || saved.imageType === targetType) break;
      } else {
        lastReason = saved.reason ?? "not_saved";
      }
    } catch (err) {
      lastReason = `download_failed: ${(err as Error).message}`;
      logger.warn(`Download failed for ${game.name}: ${lastReason}`);
    }
  }

  if (!savedAny) {
    bumpSourceStat(source.name, "failed");
    updateGameStatus(game.id, "failed");
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: lastReason,
    });
    return "failed";
  }

  refreshGameCompletionStatus(game.id);
  return "downloaded";
}

export async function runScrape(options: ScrapeOptions): Promise<void> {
  const recovered = recoverStaleProcessing();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} stale processing game(s) back to pending`);
  }

  const sources = resolveSources(options);
  if (!sources.length) {
    throw new Error("No sources selected");
  }

  // Filter out unimplemented stubs when using --type
  const usable = sources.filter((s) => s.name === "stake");
  if (options.source && !usable.find((s) => s.name === options.source)) {
    // Allow explicit source even if stub — it will throw clearly
    usable.length = 0;
    usable.push(getSource(options.source!));
  } else if (!options.source && options.type) {
    if (!usable.length) {
      throw new Error(
        `No implemented sources available for type ${options.type}. Currently implemented: stake`,
      );
    }
  }

  const targetType = options.type;
  const games = selectGames(options, targetType);
  logger.info(
    `Scraping ${games.length} game(s) via ${usable.map((s) => s.name).join(", ")}${
      targetType ? ` targeting ${targetType}` : ""
    }`,
  );

  for (const source of usable) {
    const concurrency =
      options.concurrency ??
      source.concurrency ??
      getSourceConfig(source.name)?.concurrency ??
      config.concurrency;
    const limit = createLimiter(concurrency);

    await Promise.all(
      games.map((game) =>
        limit(async () => {
          try {
            await processGameWithSource(game, source, options, targetType);
          } catch (err) {
            logger.error(`Unhandled error for ${game.name}: ${(err as Error).message}`);
            updateGameStatus(game.id, "failed");
            logFailedGame({
              game: game.name,
              provider: game.provider ?? "",
              source: source.name,
              reason: `unhandled: ${(err as Error).message}`,
            });
          }
        }),
      ),
    );
  }
}

export async function retryFailed(options: ScrapeOptions = {}): Promise<void> {
  const { resetFailedToPending } = await import("../database/db.js");
  const n = resetFailedToPending();
  logger.info(`Reset ${n} failed game(s) to pending`);
  await runScrape(options);
}
