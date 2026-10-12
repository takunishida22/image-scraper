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

function envList(key: string, fallback: string): string[] {
  return envString(key, fallback)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function envIntList(key: string, fallback: string): number[] {
  return envList(key, fallback)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b - a);
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
  bcgame: {
    areaCode: string;
    pageSize: number;
    distinctId: string;
    catalogCachePath: string;
    catalogCacheTtlMs: number;
    catalogMaxPages: number;
  };
  betgaliano: {
    apiUrl: string;
    siteId: number;
    pageSize: number;
    tags: string[];
    catalogCachePath: string;
    catalogCacheTtlMs: number;
    catalogMaxPages: number;
  };
  regencycasino: {
    apiBaseUrl: string;
    imageBaseUrl: string;
    appName: string;
    country: string;
    lang: string;
    platform: string;
    pageSize: number;
    categories: string[];
    imageSizes: number[];
    catalogCachePath: string;
    catalogCacheTtlMs: number;
    catalogMaxPages: number;
  };
  databetrix: {
    apiUrl: string;
    gameSource: string;
    pageSize: number;
    importMissingGames: boolean;
    catalogCachePath: string;
    catalogCacheTtlMs: number;
    catalogMaxPages: number;
  };
  grosvenorcasino: {
    baseUrl: string;
    catalogUrl: string;
    searchUrl: string;
    imageWidth: number;
    catalogCachePath: string;
    catalogCacheTtlMs: number;
  };
  multiwin: {
    baseUrl: string;
    apiBaseUrl: string;
    catalogCachePath: string;
    catalogCacheTtlMs: number;
  };
  stake: {
    baseUrl: string;
    accessToken: string;
    cfClearance: string;
    cookies: string;
    userAgent: string;
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
    bcgame: {
      expectedRatio: "portrait",
      priority: 1,
      concurrency: envInt("BCGAME_CONCURRENCY", 8),
      enabled: envString("BCGAME_ENABLED", "true") !== "false",
    },
    betgaliano: {
      expectedRatio: "landscape",
      priority: 2,
      concurrency: envInt("BETGALIANO_CONCURRENCY", 8),
      enabled: envString("BETGALIANO_ENABLED", "true") !== "false",
    },
    regencycasino: {
      expectedRatio: "unknown",
      priority: 3,
      concurrency: envInt("REGENCYCASINO_CONCURRENCY", 8),
      enabled: envString("REGENCYCASINO_ENABLED", "true") !== "false",
    },
    databetrix: {
      expectedRatio: "unknown",
      priority: 4,
      concurrency: envInt("DATABETRIX_CONCURRENCY", 8),
      enabled: envString("DATABETRIX_ENABLED", "true") !== "false",
    },
    grosvenorcasino: {
      expectedRatio: "landscape",
      priority: 5,
      concurrency: envInt("GROSVENORCASINO_CONCURRENCY", 4),
      enabled: envString("GROSVENORCASINO_ENABLED", "true") !== "false",
    },
    multiwin: {
      expectedRatio: "unknown",
      priority: 6,
      concurrency: envInt("MULTIWIN_CONCURRENCY", 8),
      enabled: envString("MULTIWIN_ENABLED", "true") !== "false",
    },
    slotsjudge: {
      expectedRatio: "unknown",
      priority: 7,
      concurrency: envInt("SLOTSJUDGE_CONCURRENCY", 4),
      enabled: envString("SLOTSJUDGE_ENABLED", "false") === "true",
    },
    stake: {
      expectedRatio: "portrait",
      priority: 99,
      concurrency: envInt("STAKE_CONCURRENCY", 3),
      proxy: envString("STAKE_PROXY"),
      enabled: envString("STAKE_ENABLED", "false") === "true",
    },
    bitcasino: {
      expectedRatio: "unknown",
      priority: 3,
      concurrency: 5,
      enabled: true,
    },
    slotcatalog: {
      expectedRatio: "unknown",
      priority: 4,
      concurrency: 10,
      enabled: true,
    },
    casinoguru: {
      expectedRatio: "unknown",
      priority: 5,
      concurrency: 5,
      enabled: true,
    },
  },
  // Helsinki Hetzner VPS → Finland; API requires pageSize >= 40
  bcgame: {
    areaCode: envString("BCGAME_AREA_CODE", "FI"),
    pageSize: Math.max(40, envInt("BCGAME_PAGE_SIZE", 40)),
    distinctId: envString(
      "BCGAME_DISTINCT_ID",
      "19ffbb5505415-07344563f11c4dc-26071851-1440000-19ffbb55055ed4",
    ),
    catalogCachePath: path.resolve(
      root,
      envString("BCGAME_CATALOG_CACHE", "./data/bcgame-catalog.json"),
    ),
    catalogCacheTtlMs: envInt("BCGAME_CATALOG_TTL_MS", 24 * 60 * 60 * 1000),
    // 0 = all pages; set small for tests
    catalogMaxPages: envInt("BCGAME_CATALOG_MAX_PAGES", 0),
  },
  betgaliano: {
    apiUrl: envString(
      "BETGALIANO_API_URL",
      "https://modulesports.com:55000/api/MyCasino/SearchGames",
    ),
    siteId: envInt("BETGALIANO_SITE_ID", 7),
    // The API caps responses at 500 records even if a larger value is sent.
    pageSize: Math.min(500, Math.max(1, envInt("BETGALIANO_PAGE_SIZE", 500))),
    tags: envString("BETGALIANO_TAGS", "slots,live")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    catalogCachePath: path.resolve(
      root,
      envString("BETGALIANO_CATALOG_CACHE", "./data/betgaliano-catalog.json"),
    ),
    catalogCacheTtlMs: envInt(
      "BETGALIANO_CATALOG_TTL_MS",
      24 * 60 * 60 * 1000,
    ),
    // 0 = all pages; set a small value for development.
    catalogMaxPages: envInt("BETGALIANO_CATALOG_MAX_PAGES", 0),
  },
  regencycasino: {
    apiBaseUrl: envString(
      "REGENCYCASINO_API_BASE_URL",
      "https://games-api.netdnstrace1.com/v2/categories",
    ).replace(/\/$/, ""),
    imageBaseUrl: envString(
      "REGENCYCASINO_IMAGE_BASE_URL",
      "https://aws-origin.image-tech-storage.com/gameRes",
    ).replace(/\/$/, ""),
    appName: envString("REGENCYCASINO_APP_NAME", "RegencyCasino.gr"),
    country: envString("REGENCYCASINO_COUNTRY", "GR"),
    lang: envString("REGENCYCASINO_LANG", "en"),
    platform: envString("REGENCYCASINO_PLATFORM", "mobile"),
    // The API rejects page sizes above 50.
    pageSize: Math.min(
      50,
      Math.max(1, envInt("REGENCYCASINO_PAGE_SIZE", 50)),
    ),
    categories: envList("REGENCYCASINO_CATEGORIES", "live,slots"),
    imageSizes: envIntList("REGENCYCASINO_IMAGE_SIZES", "500,350,250"),
    catalogCachePath: path.resolve(
      root,
      envString(
        "REGENCYCASINO_CATALOG_CACHE",
        "./data/regencycasino-catalog.json",
      ),
    ),
    catalogCacheTtlMs: envInt(
      "REGENCYCASINO_CATALOG_TTL_MS",
      24 * 60 * 60 * 1000,
    ),
    // 0 = all pages in each category.
    catalogMaxPages: envInt("REGENCYCASINO_CATALOG_MAX_PAGES", 0),
  },
  databetrix: {
    apiUrl: envString(
      "DATABETRIX_API_URL",
      "https://api.carvalhobet.test.betinovioslots.net/v1/game/games",
    ),
    gameSource: envString("DATABETRIX_GAME_SOURCE", "DATABETRIX"),
    pageSize: Math.max(1, envInt("DATABETRIX_PAGE_SIZE", 5000)),
    importMissingGames:
      envString("DATABETRIX_IMPORT_MISSING_GAMES", "true") !== "false",
    catalogCachePath: path.resolve(
      root,
      envString("DATABETRIX_CATALOG_CACHE", "./data/databetrix-catalog.json"),
    ),
    catalogCacheTtlMs: envInt(
      "DATABETRIX_CATALOG_TTL_MS",
      24 * 60 * 60 * 1000,
    ),
    // 0 = all offset pages.
    catalogMaxPages: envInt("DATABETRIX_CATALOG_MAX_PAGES", 0),
  },
  grosvenorcasino: {
    baseUrl: envString(
      "GROSVENORCASINO_BASE_URL",
      "https://www.grosvenorcasinos.com",
    ).replace(/\/$/, ""),
    catalogUrl: envString(
      "GROSVENORCASINO_CATALOG_URL",
      "https://www.grosvenorcasinos.com/slots-and-games/all?_data=routes%2F%24",
    ),
    searchUrl: envString(
      "GROSVENORCASINO_SEARCH_URL",
      "https://www.grosvenorcasinos.com/actions/gameSearch",
    ),
    imageWidth: Math.max(250, envInt("GROSVENORCASINO_IMAGE_WIDTH", 800)),
    catalogCachePath: path.resolve(
      root,
      envString(
        "GROSVENORCASINO_CATALOG_CACHE",
        "./data/grosvenorcasino-catalog.json",
      ),
    ),
    catalogCacheTtlMs: envInt(
      "GROSVENORCASINO_CATALOG_TTL_MS",
      24 * 60 * 60 * 1000,
    ),
  },
  multiwin: {
    baseUrl: envString("MULTIWIN_BASE_URL", "https://multiwin11.com").replace(
      /\/$/,
      "",
    ),
    apiBaseUrl: envString(
      "MULTIWIN_API_BASE_URL",
      "https://multiwin11.com/api/v2/games/pages/mirror",
    ).replace(/\/$/, ""),
    catalogCachePath: path.resolve(
      root,
      envString("MULTIWIN_CATALOG_CACHE", "./data/multiwin-catalog.json"),
    ),
    catalogCacheTtlMs: envInt(
      "MULTIWIN_CATALOG_TTL_MS",
      24 * 60 * 60 * 1000,
    ),
  },
  stake: {
    baseUrl: envString("STAKE_BASE_URL", "https://stake.com").replace(/\/$/, ""),
    accessToken: envString("STAKE_ACCESS_TOKEN"),
    cfClearance: envString("STAKE_CF_CLEARANCE"),
    cookies: envString("STAKE_COOKIES"),
    userAgent: envString("STAKE_USER_AGENT"),
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
