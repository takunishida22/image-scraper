import type {
  ExpectedRatio,
  GamePageResult,
  GameRecord,
  ImageCandidate,
  SearchResult,
} from "../types.js";

export interface GameImageSource {
  name: string;
  /** Production-ready adapter (false for stubs). */
  implemented: boolean;
  /** Runtime enable flag; config can also disable. */
  enabled: boolean;

  expectedRatio?: ExpectedRatio;
  priority: number;
  concurrency?: number;
  httpWorks?: boolean;
  playwrightRequired?: boolean;

  searchGame(game: GameRecord): Promise<SearchResult[]>;
  extractGame(result: SearchResult): Promise<GamePageResult>;
  extractImages(gamePage: GamePageResult): Promise<ImageCandidate[]>;

  probe?(): Promise<{ httpWorks: boolean; playwrightRequired: boolean; notes: string[] }>;

  /** Optional lifecycle — browser pools, shared clients, etc. */
  init?(): Promise<void>;
  close?(): Promise<void>;
}
