#!/usr/bin/env node
import { Command } from "commander";
import { analyzeSource, formatAnalysisReport } from "../core/analyzer.js";
import { formatSeedReport, seedImagesFromCsv } from "../core/seedImages.js";
import { formatShuffleSeedReport, seedShuffleImages } from "../core/seedShuffle.js";
import { retryFailed, runScrape } from "../core/scraper.js";
import { closeDb, getDb } from "../database/db.js";
import type { ImageType } from "../types.js";
import { logger } from "../utils/logger.js";
import { importGamesFromCsv } from "./importCsv.js";
import { formatStats } from "./stats.js";

const program = new Command();

program
  .name("casino-image-scraper")
  .description("Pluggable casino game image scraper (native artwork only)")
  .version("1.0.0");

program
  .command("import")
  .description("Import games from CSV (Name/Provider + optional Img/ImgVertical/ImgWide/ImgSquare)")
  .argument("<file>", "Path to CSV")
  .option("--seed", "Also download CSV image URLs after import", false)
  .option("--limit <n>", "Limit games when seeding")
  .option("--concurrency <n>", "Seed download concurrency")
  .action(
    async (file: string, opts: { seed?: boolean; limit?: string; concurrency?: string }) => {
      getDb();
      const result = importGamesFromCsv(file);
      console.log(
        `Imported ${result.inserted} game(s), updated ${result.updated}, skipped ${result.skipped}`,
      );
      if (opts.seed) {
        const report = await seedImagesFromCsv({
          limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
          concurrency: opts.concurrency ? Number.parseInt(opts.concurrency, 10) : undefined,
          missingOnly: true,
        });
        console.log(formatSeedReport(report));
        console.log(formatStats());
      }
    },
  );

program
  .command("seed-images")
  .description("Download CSV Img* URLs and save by detected portrait/square/landscape ratio")
  .option("--limit <n>", "Limit number of games")
  .option("--concurrency <n>", "Download concurrency")
  .option("--overwrite", "Replace existing images of the same type", false)
  .option("--dry-run", "List URLs only", false)
  .action(
    async (opts: {
      limit?: string;
      concurrency?: string;
      overwrite?: boolean;
      dryRun?: boolean;
    }) => {
      getDb();
      const report = await seedImagesFromCsv({
        limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
        concurrency: opts.concurrency ? Number.parseInt(opts.concurrency, 10) : undefined,
        overwrite: Boolean(opts.overwrite),
        missingOnly: !opts.overwrite,
        dryRun: Boolean(opts.dryRun),
      });
      console.log(formatSeedReport(report));
      console.log(formatStats());
    },
  );

program
  .command("seed-shuffle")
  .description(
    "Download Shuffle CSV images as portraits; match by normalized name and replace existing portraits",
  )
  .argument("[file]", "Path to shuffle CSV", "./data/shuffle-games.csv")
  .option("--limit <n>", "Limit number of CSV rows")
  .option("--concurrency <n>", "Download concurrency")
  .option("--dry-run", "Match only; do not download", false)
  .action(
    async (
      file: string,
      opts: { limit?: string; concurrency?: string; dryRun?: boolean },
    ) => {
      getDb();
      const report = await seedShuffleImages({
        file,
        limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
        concurrency: opts.concurrency ? Number.parseInt(opts.concurrency, 10) : undefined,
        dryRun: Boolean(opts.dryRun),
      });
      console.log(formatShuffleSeedReport(report));
      console.log(formatStats());
    },
  );

program
  .command("analyze-source")
  .description("Sample images from a source and report ratio distribution")
  .requiredOption("--source <name>", "Source adapter name")
  .option("--limit <n>", "Max games to sample", "100")
  .action(async (opts: { source: string; limit: string }) => {
    getDb();
    const report = await analyzeSource({
      source: opts.source,
      limit: Number.parseInt(opts.limit, 10) || 100,
    });
    console.log(formatAnalysisReport(report));
  });

program
  .command("scrape")
  .description("Scrape game images from one or more sources")
  .option("--source <name>", "Source adapter name")
  .option("--type <type>", "Target image type: portrait|square|landscape|other")
  .option(
    "--missing-only",
    "Only fill missing types (with --type: that type; without: portrait+square+landscape)",
    false,
  )
  .option("--overwrite", "Allow replacing existing images with higher quality", false)
  .option("--limit <n>", "Limit number of games")
  .option("--concurrency <n>", "Override concurrency")
  .option("--dry-run", "Match only; do not download", false)
  .action(
    async (opts: {
      source?: string;
      type?: string;
      missingOnly?: boolean;
      overwrite?: boolean;
      limit?: string;
      concurrency?: string;
      dryRun?: boolean;
    }) => {
      getDb();
      if (!opts.source && !opts.type) {
        throw new Error("Provide --source <name> and/or --type <portrait|square|landscape>");
      }
      if (opts.type) {
        const allowed = new Set(["portrait", "square", "landscape", "other"]);
        if (!allowed.has(opts.type)) {
          throw new Error(`Invalid --type ${opts.type}`);
        }
      }
      await runScrape({
        source: opts.source,
        type: opts.type as ImageType | undefined,
        missingOnly: Boolean(opts.missingOnly),
        overwrite: Boolean(opts.overwrite),
        limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
        concurrency: opts.concurrency ? Number.parseInt(opts.concurrency, 10) : undefined,
        dryRun: Boolean(opts.dryRun),
      });
      console.log(formatStats());
    },
  );

program
  .command("retry-failed")
  .description("Retry failed source attempts (optionally filtered by source/type)")
  .option("--source <name>", "Source adapter name")
  .option("--type <type>", "Target image type: portrait|square|landscape|other")
  .option("--limit <n>", "Limit number of games")
  .action(async (opts: { source?: string; type?: string; limit?: string }) => {
    getDb();
    if (opts.type) {
      const allowed = new Set(["portrait", "square", "landscape", "other"]);
      if (!allowed.has(opts.type)) {
        throw new Error(`Invalid --type ${opts.type}`);
      }
    }
    await retryFailed({
      source: opts.source,
      type: opts.type as ImageType | undefined,
      limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
    });
    console.log(formatStats());
  });

program
  .command("stats")
  .description("Show collection progress statistics")
  .action(() => {
    getDb();
    console.log(formatStats());
  });

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    const { closeHttpAgents } = await import("../utils/http.js");
    await closeHttpAgents();
    closeDb();
  }
}

main();
