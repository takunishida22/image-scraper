import { config } from "../config/index.js";
import { listGames } from "../database/db.js";
import { inspectRemoteImage } from "../images/downloader.js";
import { createLimiter } from "./queue.js";
import { decideMatch, scoreImageCandidate, scoreSearchMatch } from "./matcher.js";
import { getSource } from "../sources/registry.js";
import type { AnalyzeSourceOptions, ImageType, SourceAnalysisReport } from "../types.js";
import { logger } from "../utils/logger.js";

function avgDims(
  items: Array<{ width: number; height: number }>,
): { width: number; height: number } | undefined {
  if (!items.length) return undefined;
  const width = Math.round(items.reduce((s, i) => s + i.width, 0) / items.length);
  const height = Math.round(items.reduce((s, i) => s + i.height, 0) / items.length);
  return { width, height };
}

export async function analyzeSource(options: AnalyzeSourceOptions): Promise<SourceAnalysisReport> {
  const source = getSource(options.source);
  const games = listGames({ limit: options.limit });
  if (!games.length) {
    throw new Error("No games in database. Import a CSV first: npm run import -- ./data/games.csv");
  }

  const notes: string[] = [];
  let httpWorks = false;
  let playwrightRequired = true;

  if (source.probe) {
    const probe = await source.probe();
    httpWorks = probe.httpWorks;
    playwrightRequired = probe.playwrightRequired;
    notes.push(...probe.notes);
  }

  const counts: Record<ImageType, number> = {
    portrait: 0,
    square: 0,
    landscape: 0,
    other: 0,
  };
  const dims: Record<ImageType, Array<{ width: number; height: number }>> = {
    portrait: [],
    square: [],
    landscape: [],
    other: [],
  };
  const hosts = new Map<string, number>();

  const limit = createLimiter(Math.min(3, source.concurrency ?? config.concurrency));
  let analyzed = 0;

  await Promise.all(
    games.map((game) =>
      limit(async () => {
        try {
          const results = await source.searchGame(game);
          if (!results.length) return;

          const scored = results
            .map((r) => ({ r, s: scoreSearchMatch(game, r) }))
            .sort((a, b) => b.s.total - a.s.total);
          const best = scored[0]!;
          if (decideMatch(best.s.total) === "reject") return;

          const page = await source.extractGame(best.r);
          page.json = { thumbnailUrl: best.r.thumbnailUrl, search: best.r.raw };
          const candidates = await source.extractImages(page);
          if (best.r.thumbnailUrl) {
            candidates.unshift({
              url: best.r.thumbnailUrl,
              alt: best.r.title,
              sourceHint: "game-thumb",
            });
          }

          const ranked = candidates
            .map((c) => ({ c, score: scoreImageCandidate(game, c).total }))
            .filter((x) => x.score > -50)
            .sort((a, b) => b.score - a.score);

          for (const item of ranked.slice(0, 3)) {
            try {
              const { inspection, host } = await inspectRemoteImage(
                item.c.url,
                config.sources[source.name]?.proxy,
              );
              if (inspection.width < config.minImageWidth || inspection.height < config.minImageHeight) {
                continue;
              }
              counts[inspection.imageType]++;
              dims[inspection.imageType].push({
                width: inspection.width,
                height: inspection.height,
              });
              if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1);
              analyzed++;
              break;
            } catch (err) {
              logger.debug(`Analyze image failed: ${(err as Error).message}`);
            }
          }
        } catch (err) {
          logger.warn(`Analyze failed for ${game.name}: ${(err as Error).message}`);
        }
      }),
    ),
  );

  const commonImageHosts = [...hosts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([host, n]) => `${host} (${n})`);

  return {
    source: source.name,
    imagesAnalyzed: analyzed,
    portrait: counts.portrait,
    square: counts.square,
    landscape: counts.landscape,
    other: counts.other,
    averageDimensions: {
      portrait: avgDims(dims.portrait),
      square: avgDims(dims.square),
      landscape: avgDims(dims.landscape),
      other: avgDims(dims.other),
    },
    httpScrapingWorks: httpWorks,
    playwrightRequired,
    commonImageHosts,
    notes,
  };
}

export function formatAnalysisReport(report: SourceAnalysisReport): string {
  const fmtAvg = (d?: { width: number; height: number }) =>
    d ? `${d.width}x${d.height}` : "n/a";

  const lines = [
    `Source: ${report.source}`,
    "",
    `Images analyzed: ${report.imagesAnalyzed}`,
    "",
    `Portrait: ${report.portrait}`,
    `Square: ${report.square}`,
    `Landscape: ${report.landscape}`,
    `Other: ${report.other}`,
    "",
    "Average dimensions:",
    `portrait: ${fmtAvg(report.averageDimensions.portrait)}`,
    `square: ${fmtAvg(report.averageDimensions.square)}`,
    `landscape: ${fmtAvg(report.averageDimensions.landscape)}`,
    "",
    `HTTP scraping works: ${report.httpScrapingWorks ? "YES" : "NO"}`,
    `Playwright required: ${report.playwrightRequired ? "YES" : "NO"}`,
    "",
    "Common image hosts:",
    ...(report.commonImageHosts.length
      ? report.commonImageHosts.map((h) => `- ${h}`)
      : ["- (none)"]),
  ];

  if (report.notes.length) {
    lines.push("", "Notes:", ...report.notes.map((n) => `- ${n}`));
  }

  return lines.join("\n");
}
