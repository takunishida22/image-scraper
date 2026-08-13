import { config as loadDotenv } from "dotenv";
import path from "node:path";
import type { ExpectedRatio, ImageType } from "../types.js";

loadDotenv();

function envString(key: string, fallback = ""): string {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface SourceConfig {
  expectedRatio: ExpectedRatio;
  priority: number;
  concurrency?: number;
  proxy?: string;
  enabled: boolean;
}

export interface RatioThresholds {
  portraitMin: number;
  portraitMax: number;
  squareMin: number;
  squareMax: number;
  landscapeMin: number;
  landscapeMax: number;
}

export interface AppConfig {
  concurrency: number;
  requestTimeout: number;
  maxRetries: number;
  retryDelay: number;
  databasePath: string;
  imagesDir: string;
  logsDir: string;
  minImageWidth: number;
  minImageHeight: number;
  maxImageBytes: number;
  tmpOrphanMaxAgeMs: number;
  matchAcceptThreshold: number;
  matchReviewThreshold: number;
  ratios: RatioThresholds;
  httpProxy: string;
  httpsProxy: string;
  sources: Record<string, SourceConfig>;
  stake: {
    baseUrl: string;
    accessToken: string;
    cfClearance: string;
    concurrency: number;
    proxy: string;
  };
}

const root = process.cwd();

export const config: AppConfig = {
  concurrency: envInt("SCRAPER_CONCURRENCY", 5),
  requestTimeout: envInt("REQUEST_TIMEOUT", 30_000),
  maxRetries: envInt("MAX_RETRIES", 3),
  retryDelay: envInt("RETRY_DELAY", 2_000),
  databasePath: path.resolve(root, envString("DATABASE_PATH", "./data/scraper.db")),
  imagesDir: path.resolve(root, envString("IMAGES_DIR", "./images")),
  logsDir: path.resolve(root, envString("LOGS_DIR", "./logs")),
  minImageWidth: envInt("MIN_IMAGE_WIDTH", 250),
  minImageHeight: envInt("MIN_IMAGE_HEIGHT", 250),
  maxImageBytes: envInt("MAX_IMAGE_BYTES", 26_214_400),
  tmpOrphanMaxAgeMs: envInt("TMP_ORPHAN_MAX_AGE_MS", 3_600_000),
  matchAcceptThreshold: envInt("MATCH_ACCEPT_THRESHOLD", 100),
  matchReviewThreshold: envInt("MATCH_REVIEW_THRESHOLD", 70),
  ratios: {
    portraitMin: envFloat("PORTRAIT_MIN", 0.45),
    portraitMax: envFloat("PORTRAIT_MAX", 0.85),
    squareMin: envFloat("SQUARE_MIN", 0.9),
    squareMax: envFloat("SQUARE_MAX", 1.1),
    landscapeMin: envFloat("LANDSCAPE_MIN", 1.3),
    landscapeMax: envFloat("LANDSCAPE_MAX", 2.2),
  },
  httpProxy: envString("HTTP_PROXY"),
  httpsProxy: envString("HTTPS_PROXY"),
  sources: {
    stake: {
      expectedRatio: "portrait",
      priority: 1,
      concurrency: envInt("STAKE_CONCURRENCY", 3),
      proxy: envString("STAKE_PROXY"),
      enabled: true,
    },
    bitcasino: {
      expectedRatio: "unknown",
      priority: 2,
      concurrency: 5,
      enabled: true,
    },
    slotcatalog: {
      expectedRatio: "unknown",
      priority: 3,
      concurrency: 10,
      enabled: true,
    },
    casinoguru: {
      expectedRatio: "unknown",
      priority: 4,
      concurrency: 5,
      enabled: true,
    },
  },
  stake: {
    baseUrl: envString("STAKE_BASE_URL", "https://stake.com").replace(/\/$/, ""),
    accessToken: envString("STAKE_ACCESS_TOKEN"),
    cfClearance: envString("STAKE_CF_CLEARANCE"),
    concurrency: envInt("STAKE_CONCURRENCY", 3),
    proxy: envString("STAKE_PROXY"),
  },
};

export function sourcesForType(type: ImageType): string[] {
  return Object.entries(config.sources)
    .filter(([, cfg]) => cfg.enabled)
    .filter(([, cfg]) => cfg.expectedRatio === type || cfg.expectedRatio === "unknown")
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([name]) => name);
}

export function getSourceConfig(name: string): SourceConfig | undefined {
  return config.sources[name];
}
