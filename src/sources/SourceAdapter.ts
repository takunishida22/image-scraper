import type {
  ExpectedRatio,
  GamePageResult,
  GameRecord,
  ImageCandidate,
  ImageType,
  SearchResult,
} from "../types.js";

export interface GameImageSource {
  name: string;
  /** Production-ready adapter (false for stubs). */
  implemented: boolean;
  /** Runtime enable flag; config can also disable. */
  enabled: boolean;

  expectedRatio?: ExpectedRatio;
  /** Known image types exposed by this source; narrows untyped missing-only runs. */
  supportedTypes?: ImageType[];
  /** Download once and use the detected type during untyped missing-only runs. */
  detectTypeOnce?: boolean;
  /** Optional source-specific validation thresholds. */
  minImageWidth?: number;
  minImageHeight?: number;
  /** Optionally classify near-square "other" ratios as square. */
  squareMinRatio?: number;
  squareMaxRatio?: number;
  /** Optionally classify extra-wide "other" ratios as landscape. */
  landscapeMaxRatio?: number;
  /** Permit duplicate bytes only across records with the same normalized name. */
  allowSameNameDuplicateImages?: boolean;
  /** Continue after a successful candidate so different detected types are all stored. */
  saveAllCandidates?: boolean;
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
