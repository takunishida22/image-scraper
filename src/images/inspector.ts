import crypto from "node:crypto";
import sharp from "sharp";
import { classifyRatio, computeRatio } from "../core/classifier.js";
import type { ImageInspection } from "../types.js";

export async function inspectImage(buffer: Buffer): Promise<ImageInspection> {
  const image = sharp(buffer, { failOn: "none" });
  const meta = await image.metadata();

  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const format = meta.format ?? "unknown";
  const hasAlpha = Boolean(meta.hasAlpha);
  const ratio = computeRatio(width, height);
  const imageType = classifyRatio(width, height);

  return {
    width,
    height,
    format,
    size: buffer.length,
    hasAlpha,
    ratio,
    imageType,
  };
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
