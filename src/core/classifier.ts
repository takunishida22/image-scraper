import { config } from "../config/index.js";
import type { ImageType } from "../types.js";
import type { RatioThresholds } from "../config/index.js";

export function classifyRatio(
  width: number,
  height: number,
  thresholds: RatioThresholds = config.ratios,
): ImageType {
  if (!width || !height || width <= 0 || height <= 0) return "other";

  const ratio = width / height;
  const {
    portraitMin,
    portraitMax,
    squareMin,
    squareMax,
    landscapeMin,
    landscapeMax,
  } = thresholds;

  if (ratio >= portraitMin && ratio <= portraitMax) return "portrait";
  if (ratio >= squareMin && ratio <= squareMax) return "square";
  if (ratio >= landscapeMin && ratio <= landscapeMax) return "landscape";
  return "other";
}

export function computeRatio(width: number, height: number): number {
  if (!height) return 0;
  return width / height;
}
