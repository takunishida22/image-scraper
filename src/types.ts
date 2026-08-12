export type ImageType = "portrait" | "square" | "landscape" | "other";

export type GameStatus =
  | "pending"
  | "processing"
  | "completed"
  | "partial"
  | "failed"
  | "review";

export type ExpectedRatio = ImageType | "unknown";

export interface GameRecord {
  id: number;
  name: string;
  normalizedName: string;
  provider: string | null;
  status: GameStatus;
  createdAt: string;
  updatedAt: string;
}

export interface GameImageRecord {
  id: number;
  gameId: number;
  imageType: ImageType;
  localPath: string;
  width: number;
  height: number;
  format: string;
  fileSize: number;
  source: string;
  sha256: string;
  confidence: number;
  createdAt: string;
}

export interface SearchResult {
  title: string;
  provider?: string | null;
  slug?: string | null;
  url: string;
  thumbnailUrl?: string | null;
  raw?: Record<string, unknown>;
}

export interface GamePageResult {
  title: string;
  provider?: string | null;
  slug?: string | null;
  url: string;
  html?: string;
  json?: unknown;
  networkPayloads?: unknown[];
}

export interface ImageCandidate {
  url: string;
  alt?: string | null;
  title?: string | null;
  filename?: string | null;
  context?: string | null;
  cssClass?: string | null;
  sourceHint?: string | null;
  score?: number;
}

export interface MatchScoreBreakdown {
  total: number;
  reasons: string[];
}

export interface ScrapeOptions {
  source?: string;
  type?: ImageType;
  missingOnly?: boolean;
  overwrite?: boolean;
  limit?: number;
  concurrency?: number;
  dryRun?: boolean;
}

export interface AnalyzeSourceOptions {
  source: string;
  limit: number;
}

export interface SourceAnalysisReport {
  source: string;
  imagesAnalyzed: number;
  portrait: number;
  square: number;
  landscape: number;
  other: number;
  averageDimensions: {
    portrait?: { width: number; height: number };
    square?: { width: number; height: number };
    landscape?: { width: number; height: number };
    other?: { width: number; height: number };
  };
  httpScrapingWorks: boolean;
  playwrightRequired: boolean;
  commonImageHosts: string[];
  notes: string[];
}

export interface DownloadedImage {
  buffer: Buffer;
  contentType: string | null;
  finalUrl: string;
}

export interface ImageInspection {
  width: number;
  height: number;
  format: string;
  size: number;
  hasAlpha: boolean;
  ratio: number;
  imageType: ImageType;
}

export interface SourceStats {
  source: string;
  attempted: number;
  matched: number;
  downloaded: number;
  failed: number;
  review: number;
}
