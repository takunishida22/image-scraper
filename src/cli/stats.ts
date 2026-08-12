import { getOverallStats, getSourceStats } from "../database/db.js";

function pct(part: number, total: number): string {
  if (!total) return "0.00%";
  return `${((part / total) * 100).toFixed(2)}%`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatStats(): string {
  const s = getOverallStats();
  const lines = [
    `Total games: ${fmt(s.total)}`,
    "",
    "Portrait:",
    `${fmt(s.portrait)} / ${fmt(s.total)}`,
    pct(s.portrait, s.total),
    "",
    "Square:",
    `${fmt(s.square)} / ${fmt(s.total)}`,
    pct(s.square, s.total),
    "",
    "Landscape:",
    `${fmt(s.landscape)} / ${fmt(s.total)}`,
    pct(s.landscape, s.total),
    "",
    `All 3:`,
    fmt(s.allThree),
    "",
    "Missing all:",
    fmt(s.missingAll),
    "",
    "Review required:",
    fmt(s.review),
    "",
    "Failed:",
    fmt(s.failed),
  ];

  const sources = getSourceStats();
  if (sources.length) {
    lines.push("", "Per source:");
    for (const src of sources) {
      lines.push(
        "",
        src.source,
        `attempted: ${fmt(src.attempted)}`,
        `matched: ${fmt(src.matched)}`,
        `downloaded: ${fmt(src.downloaded)}`,
        `failed: ${fmt(src.failed)}`,
        `review: ${fmt(src.review)}`,
      );
    }
  }

  return lines.join("\n");
}
