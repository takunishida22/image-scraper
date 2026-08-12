import { config } from "../config/index.js";
import type { ImageInspection } from "../types.js";

const IMAGE_MIME_PREFIXES = ["image/"];

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateImage(
  inspection: ImageInspection,
  contentType: string | null,
  options: { minWidth?: number; minHeight?: number } = {},
): ValidationResult {
  const minWidth = options.minWidth ?? config.minImageWidth;
  const minHeight = options.minHeight ?? config.minImageHeight;

  if (!inspection.width || !inspection.height) {
    return { ok: false, reason: "missing_dimensions" };
  }

  if (inspection.width < minWidth || inspection.height < minHeight) {
    return {
      ok: false,
      reason: `too_small:${inspection.width}x${inspection.height}`,
    };
  }

  if (inspection.format === "unknown" || inspection.format === "svg") {
    return { ok: false, reason: `unsupported_format:${inspection.format}` };
  }

  if (contentType) {
    const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (ct && !IMAGE_MIME_PREFIXES.some((p) => ct.startsWith(p)) && ct !== "application/octet-stream") {
      return { ok: false, reason: `bad_content_type:${ct}` };
    }
  }

  // Likely transparent placeholder: very small payload with alpha
  if (inspection.hasAlpha && inspection.size < 1500) {
    return { ok: false, reason: "likely_transparent_placeholder" };
  }

  return { ok: true };
}
