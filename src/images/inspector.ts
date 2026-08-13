import crypto from "node:crypto";
import sharp from "sharp";
import { classifyRatio, computeRatio } from "../core/classifier.js";
import type { ImageInspection } from "../types.js";

/**
 * Inspect image bytes with Sharp.
 * Never transforms/re-encodes — metadata only.
 */
export async function inspectImage(buffer: Buffer): Promise<ImageInspection> {
  // Reject HTML/error pages quickly
  const head = buffer.subarray(0, Math.min(64, buffer.length)).toString("utf8").toLowerCase();
  if (
    head.includes("<!doctype html") ||
    head.includes("<html") ||
    head.includes("<head") ||
    head.trimStart().startsWith("{") && head.includes('"error"')
  ) {
    throw new Error("not_an_image:html_or_json_payload");
  }

  // failOn error catches truncated/corrupt files better than "none"
  let meta: sharp.Metadata;
  try {
    meta = await sharp(buffer, { failOn: "error" }).metadata();
  } catch (err) {
    throw new Error(`corrupt_or_unreadable_image: ${(err as Error).message}`);
  }

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

/** Map Sharp format / MIME to file extension. Format is primary truth. */
export function extensionFromFormat(
  format: string,
  contentType: string | null,
  url: string,
): string {
  const formatMap: Record<string, string> = {
    jpeg: "jpg",
    jpg: "jpg",
    png: "png",
    webp: "webp",
    gif: "gif",
    avif: "avif",
    heif: "heif",
    heic: "heic",
    tiff: "tiff",
    tif: "tif",
    bmp: "bmp",
  };

  const normalized = (format || "").toLowerCase();
  if (normalized && formatMap[normalized]) {
    return formatMap[normalized];
  }

  if (contentType) {
    const mimeMap: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
      "image/heif": "heif",
      "image/heic": "heic",
      "image/tiff": "tiff",
      "image/bmp": "bmp",
    };
    const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (mimeMap[ct]) return mimeMap[ct];
  }

  try {
    const fromUrl = new URL(url, "https://example.com").pathname
      .split("/")
      .pop()
      ?.split("?")[0]
      ?.split(".")
      .pop()
      ?.toLowerCase();
    if (fromUrl && formatMap[fromUrl]) return formatMap[fromUrl];
    if (fromUrl === "jpeg") return "jpg";
  } catch {
    /* ignore */
  }

  return "bin";
}
