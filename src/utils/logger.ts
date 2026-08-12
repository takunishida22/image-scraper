import fs from "node:fs";
import path from "node:path";
import winston from "winston";
import { config } from "../config/index.js";

function ensureLogsDir(): string {
  fs.mkdirSync(config.logsDir, { recursive: true });
  return config.logsDir;
}

const logsDir = ensureLogsDir();

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
      return `${timestamp} [${level}] ${message}${extra}`;
    }),
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, "scraper.log"),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message }) => `${level}: ${message}`),
      ),
    }),
  ],
});

function appendCsv(file: string, headers: string[], row: string[]): void {
  const full = path.join(logsDir, file);
  const exists = fs.existsSync(full);
  const line = row.map(csvEscape).join(",") + "\n";
  if (!exists) {
    fs.writeFileSync(full, headers.join(",") + "\n" + line, "utf8");
  } else {
    fs.appendFileSync(full, line, "utf8");
  }
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function logFailedGame(row: {
  game: string;
  provider: string;
  source: string;
  reason: string;
}): void {
  appendCsv(
    "failed-games.csv",
    ["game", "provider", "source", "reason"],
    [row.game, row.provider, row.source, row.reason],
  );
}

export function logReviewNeeded(row: {
  game: string;
  provider: string;
  source: string;
  reason: string;
}): void {
  appendCsv(
    "review-needed.csv",
    ["game", "provider", "source", "reason"],
    [row.game, row.provider, row.source, row.reason],
  );
}
