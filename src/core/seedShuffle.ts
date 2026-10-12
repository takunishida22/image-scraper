import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { config } from "../config/index.js";
import { createLimiter } from "./queue.js";
import { normalizeGameName } from "./normalizer.js";
import {
  bumpSourceStat,
  getImageByType,
  importGames,
  listGamesByNormalizedName,
  refreshGameCompletionStatus,
} from "../database/db.js";
import { storeImageBuffer } from "../images/downloader.js";
import { fetchBuffer } from "../utils/http.js";
import { logger } from "../utils/logger.js";

const SOURCE = "shuffle";

export interface SeedShuffleOptions {
  file: string;
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
}

export interface SeedShuffleReport {
  rows: number;
  matchedGames: number;
  insertedGames: number;
  urlsTried: number;
  saved: number;
  replaced: number;
  failed: number;
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

function pick(row: Record<string, string>, keys: string[]): string {
  const entries = Object.entries(row).map(([k, v]) => [stripBom(k).toLowerCase(), v] as const);
  const map = new Map(entries);
  for (const key of keys) {
    const value = map.get(key.toLowerCase());
    if (value != null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

function parseShuffleCsv(filePath: string): Array<{ name: string; imageUrl: string }> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`CSV not found: ${filePath}`);
  }
  const raw = stripBom(fs.readFileSync(filePath, "utf8"));
  const records = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as Array<Record<string, string>>;

  const out: Array<{ name: string; imageUrl: string }> = [];
  for (const row of records) {
    const name = pick(row, ["name", "Name", "game", "Game", "title", "Title"]);
    const imageUrl = pick(row, ["image_url", "imageUrl", "ImageUrl", "url", "Img", "img"]);
    if (!name || !/^https?:\/\//i.test(imageUrl)) continue;
    out.push({ name, imageUrl });
  }
  return out;
}

/**
 * Download Shuffle lobby images and save as portrait.
 * Matches existing DB games by normalized name (all providers).
 * Always overwrites an existing portrait with the Shuffle asset.
 * Inserts a new game row when no normalized-name match exists.
 */
export async function seedShuffleImages(options: SeedShuffleOptions): Promise<SeedShuffleReport> {
  const rows = parseShuffleCsv(options.file);
  const limited = options.limit ? rows.slice(0, options.limit) : rows;
  const concurrency = options.concurrency ?? Math.min(8, config.concurrency);
  const limit = createLimiter(concurrency);

  const report: SeedShuffleReport = {
    rows: limited.length,
    matchedGames: 0,
    insertedGames: 0,
    urlsTried: 0,
    saved: 0,
    replaced: 0,
    failed: 0,
  };

  logger.info(
    `Seeding Shuffle images for ${limited.length} row(s)` +
      `${options.dryRun ? " [dry-run]" : ""}`,
  );

  await Promise.all(
    limited.map((row) =>
      limit(async () => {
        let games = listGamesByNormalizedName(row.name);
        if (!games.length) {
          if (options.dryRun) {
            logger.info(`[dry-run] Would insert + seed ${row.name}`);
            report.insertedGames++;
            return;
          }
          const result = importGames([
            {
              name: row.name,
              provider: null,
              externalId: null,
              imgUrl: null,
              imgVerticalUrl: row.imageUrl,
              imgWideUrl: null,
              imgSquareUrl: null,
            },
          ]);
          report.insertedGames += result.inserted;
          games = listGamesByNormalizedName(row.name);
          if (!games.length) {
            report.failed++;
            logger.warn(`Shuffle seed: failed to create game row for ${row.name}`);
            return;
          }
        } else {
          report.matchedGames += games.length;
        }

        if (options.dryRun) {
          logger.info(
            `[dry-run] Would save portrait for ${games.length} game(s) matching "${normalizeGameName(row.name)}" <- ${row.imageUrl}`,
          );
          return;
        }

        report.urlsTried++;
        bumpSourceStat(SOURCE, "attempted");

        let buffer: Buffer;
        let contentType: string | null = null;
        let finalUrl = row.imageUrl;
        try {
          const downloaded = await fetchBuffer(row.imageUrl, { label: "image:shuffle" });
          buffer = downloaded.buffer;
          contentType = downloaded.contentType;
          finalUrl = downloaded.finalUrl;
        } catch (err) {
          report.failed++;
          bumpSourceStat(SOURCE, "failed");
          logger.warn(`Shuffle download failed for ${row.name}: ${(err as Error).message}`);
          return;
        }

        for (const game of games) {
          const hadPortrait = Boolean(getImageByType(game.id, "portrait"));
          try {
            const saved = await storeImageBuffer({
              game,
              buffer,
              contentType,
              fakeUrl: finalUrl,
              source: SOURCE,
              gameMatchScore: 100,
              imageCandidateScore: 100,
              overwrite: true,
              forceType: "portrait",
              allowCrossGameDuplicate: true,
            });

            if (saved.saved) {
              report.saved++;
              if (hadPortrait) report.replaced++;
              bumpSourceStat(SOURCE, "matched");
              bumpSourceStat(SOURCE, "downloaded");
              logger.info(
                `Shuffle ${hadPortrait ? "replaced" : "saved"} ${game.name}#${game.id} [portrait] ${saved.width}x${saved.height}`,
              );
            } else if (saved.reason === "already_stored") {
              // Same bytes already on this game — count as ok
              logger.info(`Shuffle already stored for ${game.name}#${game.id}`);
            } else {
              report.failed++;
              bumpSourceStat(SOURCE, "failed");
              logger.warn(
                `Shuffle save failed for ${game.name}#${game.id}: ${saved.reason ?? "unknown"}`,
              );
            }
          } catch (err) {
            report.failed++;
            bumpSourceStat(SOURCE, "failed");
            logger.warn(
              `Shuffle save error for ${game.name}#${game.id}: ${(err as Error).message}`,
            );
          }
          refreshGameCompletionStatus(game.id);
        }
      }),
    ),
  );

  return report;
}

export function formatShuffleSeedReport(report: SeedShuffleReport): string {
  return [
    `Shuffle rows: ${report.rows}`,
    `Matched existing game rows: ${report.matchedGames}`,
    `Inserted games: ${report.insertedGames}`,
    `URLs fetched: ${report.urlsTried}`,
    `Portraits saved: ${report.saved}`,
    `Portraits replaced: ${report.replaced}`,
    `Failed: ${report.failed}`,
  ].join("\n");
}
