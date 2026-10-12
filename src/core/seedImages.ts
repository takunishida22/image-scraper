import { config } from "../config/index.js";
import {
  bumpSourceStat,
  collectSeedUrls,
  getImageByType,
  listGamesWithSeedUrls,
  refreshGameCompletionStatus,
} from "../database/db.js";
import { downloadAndStoreImage } from "../images/downloader.js";
import { createLimiter } from "../core/queue.js";
import type { SeedImageOptions } from "../types.js";
import { logger } from "../utils/logger.js";

const SOURCE = "csv";

export interface SeedImagesReport {
  games: number;
  urlsTried: number;
  saved: number;
  skippedExisting: number;
  failed: number;
  otherRejected: number;
}

/**
 * Download image URLs from the imported CSV columns.
 * Classification uses actual pixel ratio (portrait / square / landscape).
 * With missingOnly (default), skips types that already exist on disk/DB.
 */
export async function seedImagesFromCsv(options: SeedImageOptions = {}): Promise<SeedImagesReport> {
  const games = listGamesWithSeedUrls({ limit: options.limit });
  const concurrency = options.concurrency ?? Math.min(8, config.concurrency);
  const limit = createLimiter(concurrency);
  const missingOnly = options.missingOnly !== false;

  const report: SeedImagesReport = {
    games: games.length,
    urlsTried: 0,
    saved: 0,
    skippedExisting: 0,
    failed: 0,
    otherRejected: 0,
  };

  logger.info(
    `Seeding CSV images for ${games.length} game(s)` +
      `${missingOnly ? " (missing types only)" : ""}` +
      `${options.dryRun ? " [dry-run]" : ""}`,
  );

  await Promise.all(
    games.map((game) =>
      limit(async () => {
        const urls = collectSeedUrls(game);
        if (missingOnly) {
          const hasP = Boolean(getImageByType(game.id, "portrait"));
          const hasS = Boolean(getImageByType(game.id, "square"));
          const hasL = Boolean(getImageByType(game.id, "landscape"));
          if (hasP && hasS && hasL) {
            report.skippedExisting += urls.length;
            return;
          }
        }

        for (const url of urls) {
          report.urlsTried++;
          bumpSourceStat(SOURCE, "attempted");

          if (options.dryRun) {
            logger.info(`[dry-run] Would seed ${game.name} <- ${url}`);
            continue;
          }

          try {
            const saved = await downloadAndStoreImage({
              game,
              url,
              source: SOURCE,
              gameMatchScore: 100,
              imageCandidateScore: 50,
              overwrite: Boolean(options.overwrite),
              // Never force a type — classify from bytes
              preferType: undefined,
              allowOther: false,
            });

            if (saved.saved) {
              report.saved++;
              bumpSourceStat(SOURCE, "matched");
              bumpSourceStat(SOURCE, "downloaded");
              logger.info(
                `Seeded ${game.name} [${saved.imageType}] ${saved.width}x${saved.height} from csv`,
              );
              continue;
            }

            if (saved.reason === "already_stored" || saved.reason === "existing_better_or_equal") {
              report.skippedExisting++;
              continue;
            }

            if (saved.reason?.startsWith("wrong_image_type:")) {
              // If that concrete type already exists and missingOnly, count skip
              if (missingOnly && saved.imageType && getImageByType(game.id, saved.imageType)) {
                report.skippedExisting++;
              } else if (saved.reason === "wrong_image_type:other") {
                report.otherRejected++;
              } else {
                report.failed++;
                bumpSourceStat(SOURCE, "failed");
              }
              continue;
            }

            report.failed++;
            bumpSourceStat(SOURCE, "failed");
            logger.warn(`Seed failed for ${game.name}: ${saved.reason ?? "unknown"} (${url})`);
          } catch (err) {
            report.failed++;
            bumpSourceStat(SOURCE, "failed");
            logger.warn(`Seed error for ${game.name}: ${(err as Error).message}`);
          }
        }

        refreshGameCompletionStatus(game.id);
      }),
    ),
  );

  return report;
}

export function formatSeedReport(report: SeedImagesReport): string {
  return [
    `Games with CSV URLs: ${report.games}`,
    `URLs tried: ${report.urlsTried}`,
    `Saved: ${report.saved}`,
    `Skipped existing: ${report.skippedExisting}`,
    `Rejected (other ratio): ${report.otherRejected}`,
    `Failed: ${report.failed}`,
  ].join("\n");
}
