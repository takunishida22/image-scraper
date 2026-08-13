import { getSourceConfig } from "../config/index.js";
import type { GameImageSource } from "./SourceAdapter.js";
import { stakeSource } from "./stake/index.js";
import { slotsjudgeSource } from "./slotsjudge/index.js";
import { bitcasinoSource } from "./bitcasino/index.js";
import { slotcatalogSource } from "./slotcatalog/index.js";
import { casinoguruSource } from "./casinoguru/index.js";

const adapters: GameImageSource[] = [
  stakeSource,
  slotsjudgeSource,
  bitcasinoSource,
  slotcatalogSource,
  casinoguruSource,
];

function isUsable(adapter: GameImageSource): boolean {
  if (!adapter.implemented) return false;
  if (!adapter.enabled) return false;
  const cfg = getSourceConfig(adapter.name);
  if (cfg && !cfg.enabled) return false;
  return true;
}

export function listSources(): GameImageSource[] {
  return adapters.filter(isUsable).sort((a, b) => a.priority - b.priority);
}

export function listAllRegisteredSources(): GameImageSource[] {
  return [...adapters].sort((a, b) => a.priority - b.priority);
}

export function getSource(name: string): GameImageSource {
  const source = adapters.find((a) => a.name === name);
  if (!source) {
    throw new Error(
      `Unknown source "${name}". Available: ${adapters.map((a) => a.name).join(", ")}`,
    );
  }
  const cfg = getSourceConfig(name);
  if (cfg && !cfg.enabled) {
    throw new Error(`Source "${name}" is disabled in config`);
  }
  return source;
}

export function registerSource(adapter: GameImageSource): void {
  const idx = adapters.findIndex((a) => a.name === adapter.name);
  if (idx >= 0) adapters[idx] = adapter;
  else adapters.push(adapter);
}
