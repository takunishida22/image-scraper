#!/usr/bin/env node
import { Command } from "commander";
import { analyzeSource, formatAnalysisReport } from "../core/analyzer.js";
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
  .description("Import games from a CSV file")
  .argument("<file>", "Path to CSV (columns: name, provider)")
  .action((file: string) => {
    getDb();
    const result = importGamesFromCsv(file);
    console.log(`Imported ${result.inserted} game(s), skipped ${result.skipped}`);
  });

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
  .option("--missing-only", "Only scrape games missing the target type", false)
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
  .description("Reset failed games to pending and scrape again")
  .option("--source <name>", "Source adapter name", "stake")
  .option("--limit <n>", "Limit number of games")
  .action(async (opts: { source: string; limit?: string }) => {
    getDb();
    await retryFailed({
      source: opts.source,
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
    closeDb();
  }
}

main();
