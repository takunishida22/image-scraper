import type { GameImageSource } from "./SourceAdapter.js";
import { getSourceConfig } from "../config/index.js";
import type { GamePageResult, GameRecord, ImageCandidate, SearchResult } from "../types.js";

function notImplemented(name: string): never {
  throw new Error(
    `${name} adapter is scaffolded but not implemented yet. Stake is the first production source.`,
  );
}

export function makeStubSource(name: string, priority: number): GameImageSource {
  const cfg = getSourceConfig(name);
  return {
    name,
    implemented: false,
    enabled: cfg?.enabled ?? true,
    expectedRatio: cfg?.expectedRatio ?? "unknown",
    priority: cfg?.priority ?? priority,
    concurrency: cfg?.concurrency,
    async searchGame(_game: GameRecord): Promise<SearchResult[]> {
      notImplemented(name);
    },
    async extractGame(_result: SearchResult): Promise<GamePageResult> {
      notImplemented(name);
    },
    async extractImages(_gamePage: GamePageResult): Promise<ImageCandidate[]> {
      notImplemented(name);
    },
    async probe() {
      return {
        httpWorks: false,
        playwrightRequired: false,
        notes: [`${name} adapter not implemented yet`],
      };
    },
  };
}
