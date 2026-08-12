import type {
  ExpectedRatio,
  GamePageResult,
  GameRecord,
  ImageCandidate,
  SearchResult,
} from "../types.js";

export interface GameImageSource {
  name: string;
  expectedRatio?: ExpectedRatio;
  priority: number;
  /** Optional per-source concurrency override */
  concurrency?: number;
  /** Whether HTTP-only scraping is known to work */
  httpWorks?: boolean;
  /** Whether Playwright is typically required */
  playwrightRequired?: boolean;

  searchGame(game: GameRecord): Promise<SearchResult[]>;
  extractGame(result: SearchResult): Promise<GamePageResult>;
  extractImages(gamePage: GamePageResult): Promise<ImageCandidate[]>;

  /** Optional capability probe used by analyze-source */
  probe?(): Promise<{ httpWorks: boolean; playwrightRequired: boolean; notes: string[] }>;
}
