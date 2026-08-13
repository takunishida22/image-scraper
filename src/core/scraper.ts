import { config, getSourceConfig, sourcesForType } from "../config/index.js";
import {
  bumpSourceStat,
  getImageByType,
  listFailedSourceAttempts,
  listGames,
  recoverStaleProcessing,
  refreshGameCompletionStatus,
  resetSourceAttemptsByIds,
  upsertSourceAttempt,
} from "../database/db.js";
import { downloadAndStoreImage } from "../images/downloader.js";
import { decideMatch, rankImageCandidates, scoreSearchMatch } from "./matcher.js";
import { createLimiter } from "./queue.js";
import { getSource, listSources } from "../sources/registry.js";
import type { GameImageSource } from "../sources/SourceAdapter.js";
import type {
  GameRecord,
  ImageType,
  ScrapeOptions,
  SearchResult,
  SourceAttemptStatus,
} from "../types.js";
import { logFailedGame, logReviewNeeded, logger } from "../utils/logger.js";

function resolveDesiredType(
  targetType: ImageType | undefined,
  source: GameImageSource,
): ImageType | undefined {
  if (targetType) return targetType;
  const expected = source.expectedRatio;
  if (expected && expected !== "unknown" && expected !== "other") {
    return expected;
  }
  return undefined;
}

function resolveSources(options: ScrapeOptions): GameImageSource[] {
  if (options.source) {
    const source = getSource(options.source);
    if (!source.implemented) {
      throw new Error(
        `Source "${source.name}" is registered but not implemented yet`,
      );
    }
    return [source];
  }
  if (options.type) {
    const names = sourcesForType(options.type);
    const usable = names
      .map((n) => {
        try {
          return getSource(n);
        } catch {
          return null;
        }
      })
      .filter((s): s is GameImageSource => Boolean(s && s.implemented && s.enabled));
    return usable;
  }
  return listSources();
}

function selectGames(options: ScrapeOptions, desiredType?: ImageType): GameRecord[] {
  if (options.missingOnly && desiredType) {
    return listGames({ missingType: desiredType, limit: options.limit });
  }
  return listGames({ limit: options.limit });
}

function recordAttempt(
  dryRun: boolean | undefined,
  input: {
    gameId: number;
    source: string;
    targetType: string;
    status: SourceAttemptStatus;
    lastError?: string | null;
    incrementAttempt?: boolean;
  },
): void {
  if (dryRun) return;
  upsertSourceAttempt(input);
}

async function processGameWithSource(
  game: GameRecord,
  source: GameImageSource,
  options: ScrapeOptions,
  desiredType?: ImageType,
): Promise<"downloaded" | "skipped" | "review" | "failed" | "rejected"> {
  const attemptType = desiredType ?? "any";
  bumpSourceStat(source.name, "attempted");
  recordAttempt(options.dryRun, {
    gameId: game.id,
    source: source.name,
    targetType: attemptType,
    status: "processing",
    incrementAttempt: true,
  });

  if (desiredType && !options.overwrite) {
    const existing = getImageByType(game.id, desiredType);
    if (existing) {
      logger.info(`Skip ${game.name}: ${desiredType} already exists`);
      recordAttempt(options.dryRun, {
        gameId: game.id,
        source: source.name,
        targetType: attemptType,
        status: "success",
        lastError: null,
      });
      refreshGameCompletionStatus(game.id);
      return "skipped";
    }
  }

  let searchResults: SearchResult[];
  try {
    searchResults = await source.searchGame(game);
  } catch (err) {
    const reason = `search_failed: ${(err as Error).message}`;
    bumpSourceStat(source.name, "failed");
    recordAttempt(options.dryRun, {
      gameId: game.id,
      source: source.name,
      targetType: attemptType,
      status: "failed",
      lastError: reason,
    });
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason,
    });
    refreshGameCompletionStatus(game.id);
    return "failed";
  }

  if (!searchResults.length) {
    bumpSourceStat(source.name, "failed");
    recordAttempt(options.dryRun, {
      gameId: game.id,
      source: source.name,
      targetType: attemptType,
      status: "not_found",
      lastError: "no_search_results",
    });
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: "no_search_results",
    });
    refreshGameCompletionStatus(game.id);
    return "failed";
  }

  const scored = searchResults
    .map((r) => ({ result: r, match: scoreSearchMatch(game, r) }))
    .sort((a, b) => b.match.total - a.match.total);

  const best = scored[0]!;
  const decision = decideMatch(best.match.total);

  if (decision === "reject") {
    bumpSourceStat(source.name, "failed");
    recordAttempt(options.dryRun, {
      gameId: game.id,
      source: source.name,
      targetType: attemptType,
      status: "failed",
      lastError: `match_rejected:${best.match.total}`,
    });
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: `match_rejected:${best.match.total}:${best.match.reasons.join("|")}`,
    });
    refreshGameCompletionStatus(game.id);
    return "rejected";
  }

  if (decision === "review") {
    bumpSourceStat(source.name, "review");
    recordAttempt(options.dryRun, {
      gameId: game.id,
      source: source.name,
      targetType: attemptType,
      status: "review",
      lastError: `match_review:${best.match.total}:${best.result.title}`,
    });
    logReviewNeeded({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: `match_review:${best.match.total}:${best.result.title}:${best.match.reasons.join("|")}`,
    });
    refreshGameCompletionStatus(game.id);
    return "review";
  }

  bumpSourceStat(source.name, "matched");

  if (options.dryRun) {
    logger.info(`[dry-run] Would extract images for ${game.name} <- ${best.result.title}`);
    // Do not persist success (or any) source_attempt rows for dry-run
    refreshGameCompletionStatus(game.id);
    return "skipped";
  }

  let page;
  try {
    page = await source.extractGame(best.result);
    page.json = {
      ...(typeof page.json === "object" && page.json ? page.json : {}),
      thumbnailUrl: best.result.thumbnailUrl,
      search: best.result.raw,
    };
  } catch (err) {
    const reason = `extract_failed: ${(err as Error).message}`;
    bumpSourceStat(source.name, "failed");
    recordAttempt(options.dryRun, {
      gameId: game.id,
      source: source.name,
      targetType: attemptType,
      status: "failed",
      lastError: reason,
    });
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason,
    });
    refreshGameCompletionStatus(game.id);
    return "failed";
  }

  let candidates;
  try {
    candidates = await source.extractImages(page);
  } catch (err) {
    const reason = `image_extract_failed: ${(err as Error).message}`;
    bumpSourceStat(source.name, "failed");
    recordAttempt(options.dryRun, {
      gameId: game.id,
      source: source.name,
      targetType: attemptType,
      status: "failed",
      lastError: reason,
    });
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason,
    });
    refreshGameCompletionStatus(game.id);
    return "failed";
  }

  if (best.result.thumbnailUrl) {
    candidates.unshift({
      url: best.result.thumbnailUrl,
      alt: best.result.title,
      sourceHint: "game-thumb",
      context: "search.thumbnailUrl",
    });
  }

  const ranked = rankImageCandidates(game, candidates).map((item) => ({
    ...item,
    score: item.score + best.match.total * 0.1,
  }));

  if (!ranked.length) {
    bumpSourceStat(source.name, "failed");
    recordAttempt(options.dryRun, {
      gameId: game.id,
      source: source.name,
      targetType: attemptType,
      status: "failed",
      lastError: "no_image_candidates",
    });
    logFailedGame({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: "no_image_candidates",
    });
    refreshGameCompletionStatus(game.id);
    return "failed";
  }

  const proxy = getSourceConfig(source.name)?.proxy || undefined;
  let savedAny = false;
  let lastReason = "unknown";
  let sawCrossGameDup = false;

  for (const item of ranked.slice(0, 8)) {
    if (item.breakdown.total <= -50) continue;
    try {
      const saved = await downloadAndStoreImage({
        game,
        url: item.candidate.url,
        source: source.name,
        gameMatchScore: best.match.total,
        imageCandidateScore: item.breakdown.total,
        overwrite: options.overwrite,
        proxy,
        preferType: desiredType,
        allowOther: options.type === "other",
      });
      if (saved.saved) {
        savedAny = true;
        bumpSourceStat(source.name, "downloaded");
        break;
      }
      lastReason = saved.reason ?? "not_saved";
      if (saved.reason === "cross_game_duplicate") {
        // Keep searching for a unique candidate; review only if none succeed
        sawCrossGameDup = true;
        continue;
      }
      if (saved.reason?.startsWith("wrong_image_type:")) {
        continue;
      }
    } catch (err) {
      lastReason = `download_failed: ${(err as Error).message}`;
      logger.warn(`Download failed for ${game.name}: ${lastReason}`);
    }
  }

  if (savedAny) {
    recordAttempt(options.dryRun, {
      gameId: game.id,
      source: source.name,
      targetType: attemptType,
      status: "success",
      lastError: null,
    });
    refreshGameCompletionStatus(game.id);
    return "downloaded";
  }

  if (sawCrossGameDup) {
    bumpSourceStat(source.name, "review");
    recordAttempt(options.dryRun, {
      gameId: game.id,
      source: source.name,
      targetType: attemptType,
      status: "review",
      lastError: "cross_game_duplicate",
    });
    logReviewNeeded({
      game: game.name,
      provider: game.provider ?? "",
      source: source.name,
      reason: "cross_game_duplicate",
    });
    refreshGameCompletionStatus(game.id);
    return "review";
  }

  bumpSourceStat(source.name, "failed");
  recordAttempt(options.dryRun, {
    gameId: game.id,
    source: source.name,
    targetType: attemptType,
    status: "failed",
    lastError: lastReason,
  });
  logFailedGame({
    game: game.name,
    provider: game.provider ?? "",
    source: source.name,
    reason: lastReason,
  });
  refreshGameCompletionStatus(game.id);
  return "failed";
}

export async function runScrape(options: ScrapeOptions): Promise<void> {
  const recovered = recoverStaleProcessing();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} stale processing game(s) back to pending`);
  }

  const sources = resolveSources(options);
  if (!sources.length) {
    throw new Error(
      options.type
        ? `No implemented sources available for type ${options.type}`
        : "No sources selected",
    );
  }

  const gamesBase = selectGames(
    options,
    options.type ??
      (sources[0] && resolveDesiredType(undefined, sources[0])),
  );

  logger.info(
    `Scraping ${gamesBase.length} game(s) via ${sources.map((s) => s.name).join(", ")}${
      options.type ? ` targeting ${options.type}` : ""
    }${options.dryRun ? " [dry-run]" : ""}`,
  );

  for (const source of sources) {
    const desiredType = resolveDesiredType(options.type, source);
    const games =
      options.missingOnly && desiredType && !options.type
        ? listGames({ missingType: desiredType, limit: options.limit })
        : gamesBase;

    const concurrency =
      options.concurrency ??
      source.concurrency ??
      getSourceConfig(source.name)?.concurrency ??
      config.concurrency;
    const limit = createLimiter(concurrency);

    try {
      if (source.init) await source.init();

      await Promise.all(
        games.map((game) =>
          limit(async () => {
            try {
              await processGameWithSource(game, source, options, desiredType);
            } catch (err) {
              logger.error(`Unhandled error for ${game.name}: ${(err as Error).message}`);
              recordAttempt(options.dryRun, {
                gameId: game.id,
                source: source.name,
                targetType: desiredType ?? "any",
                status: "failed",
                lastError: `unhandled: ${(err as Error).message}`,
                incrementAttempt: true,
              });
              logFailedGame({
                game: game.name,
                provider: game.provider ?? "",
                source: source.name,
                reason: `unhandled: ${(err as Error).message}`,
              });
              refreshGameCompletionStatus(game.id);
            }
          }),
        ),
      );
    } finally {
      if (source.close) await source.close();
    }
  }
}

export async function retryFailed(options: ScrapeOptions = {}): Promise<void> {
  const targetType = options.type;
  const failed = listFailedSourceAttempts({
    source: options.source,
    targetType: targetType,
    limit: options.limit,
  });

  if (!failed.length) {
    logger.info("No failed source attempts to retry");
    return;
  }

  const selectedIds = failed.map((a) => a.id);
  const n = resetSourceAttemptsByIds(selectedIds);
  logger.info(
    `Retrying ${failed.length} failed attempt(s) (reset ${n} by id)` +
      `${options.source ? ` for ${options.source}` : ""}` +
      `${targetType ? ` / ${targetType}` : ""}`,
  );

  const bySource = new Map<string, number[]>();
  for (const attempt of failed) {
    const list = bySource.get(attempt.source) ?? [];
    list.push(attempt.gameId);
    bySource.set(attempt.source, list);
  }

  for (const [sourceName, gameIds] of bySource) {
    const source = getSource(sourceName);
    if (!source.implemented) continue;

    const desiredType = resolveDesiredType(options.type, source);
    const games = listGames({ ids: [...new Set(gameIds)], limit: options.limit });
    const concurrency =
      options.concurrency ??
      source.concurrency ??
      getSourceConfig(source.name)?.concurrency ??
      config.concurrency;
    const limit = createLimiter(concurrency);

    try {
      if (source.init) await source.init();
      await Promise.all(
        games.map((game) =>
          limit(async () => {
            await processGameWithSource(game, source, options, desiredType);
          }),
        ),
      );
    } finally {
      if (source.close) await source.close();
    }
  }
}
