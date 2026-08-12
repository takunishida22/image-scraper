import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import { fetchBuffer } from "../utils/http.js";
import { inspectImage, sha256 } from "./inspector.js";
import { validateImage } from "./validator.js";
import { isDuplicateHash } from "./duplicate.js";
import { findImageByHash, getImageByType, upsertGameImage } from "../database/db.js";
import { slugifyGameName } from "../core/normalizer.js";
import type { GameRecord, ImageType } from "../types.js";
import { logger } from "../utils/logger.js";

function extensionFrom(contentType: string | null, url: string, format: string): string {
  const fromUrl = path.extname(new URL(url, "https://example.com").pathname).replace(".", "").toLowerCase();
  if (fromUrl && /^[a-z0-9]+$/.test(fromUrl) && fromUrl !== "aspx") return fromUrl;

  if (contentType) {
    const map: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
      "image/bmp": "bmp",
    };
    const ct = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (map[ct]) return map[ct];
  }

  if (format && format !== "unknown" && format !== "jpeg") return format;
  if (format === "jpeg") return "jpg";
  return "bin";
}

export function gameImageDir(game: GameRecord): string {
  const slug = slugifyGameName(game.name) || `game-${game.id}`;
  return path.join(config.imagesDir, slug);
}

export interface SaveImageResult {
  saved: boolean;
  reason?: string;
  localPath?: string;
  imageType?: ImageType;
  width?: number;
  height?: number;
  sha256?: string;
}

export async function downloadAndStoreImage(options: {
  game: GameRecord;
  url: string;
  source: string;
  confidence: number;
  overwrite?: boolean;
  proxy?: string;
  /** If set, only save when classified type matches (still inspects actual dims). */
  preferType?: ImageType;
}): Promise<SaveImageResult> {
  const { game, url, source, confidence, overwrite = false, proxy, preferType } = options;

  const downloaded = await fetchBuffer(url, { proxy, label: `image:${source}` });
  const inspection = await inspectImage(downloaded.buffer);
  const validation = validateImage(inspection, downloaded.contentType);

  if (!validation.ok) {
    return { saved: false, reason: validation.reason };
  }

  const imageType = inspection.imageType;
  if (preferType && imageType !== preferType && imageType !== "other") {
    // Still allow saving as its true type; preferType is a soft filter for skip logic elsewhere
  }

  const dup = isDuplicateHash(downloaded.buffer);
  if (dup.duplicate) {
    const existingSameGame = getImageByType(game.id, imageType);
    if (existingSameGame && existingSameGame.sha256 === dup.sha256) {
      return {
        saved: false,
        reason: "already_stored",
        localPath: existingSameGame.localPath,
        imageType,
        width: inspection.width,
        height: inspection.height,
        sha256: dup.sha256,
      };
    }
    // Exact bytes already exist for another game/type — still allow path reuse metadata but avoid re-writing file
    const existing = findImageByHash(dup.sha256);
    if (existing && !overwrite) {
      // If same type already present with equal/better quality, skip
      const current = getImageByType(game.id, imageType);
      if (current && current.width * current.height >= inspection.width * inspection.height) {
        return { saved: false, reason: "duplicate_hash_existing_better", sha256: dup.sha256 };
      }
    }
  }

  const existing = getImageByType(game.id, imageType);
  if (existing && !overwrite) {
    const existingPixels = existing.width * existing.height;
    const newPixels = inspection.width * inspection.height;
    if (newPixels <= existingPixels) {
      return {
        saved: false,
        reason: "existing_better_or_equal",
        localPath: existing.localPath,
        imageType,
        width: existing.width,
        height: existing.height,
        sha256: existing.sha256,
      };
    }
  }

  const dir = gameImageDir(game);
  fs.mkdirSync(dir, { recursive: true });

  const ext = extensionFrom(downloaded.contentType, downloaded.finalUrl, inspection.format);
  let filename = `${imageType}.${ext}`;
  let localPath = path.join(dir, filename);

  // Collision with different type name shouldn't happen; if file exists and overwrite false with worse quality handled above
  if (fs.existsSync(localPath) && overwrite) {
    // replace in place
  } else if (fs.existsSync(localPath) && existing) {
    // upgrading — write then replace
  }

  // Preserve original bytes — no recompression
  fs.writeFileSync(localPath, downloaded.buffer);

  const hash = sha256(downloaded.buffer);
  const result = upsertGameImage({
    gameId: game.id,
    imageType,
    localPath: path.relative(process.cwd(), localPath).replace(/\\/g, "/"),
    width: inspection.width,
    height: inspection.height,
    format: ext,
    fileSize: downloaded.buffer.length,
    source,
    sha256: hash,
    confidence,
    overwrite,
  });

  if (!result.saved) {
    // DB decided not to keep — remove file we just wrote if it wasn't the previous path
    if (!existing || existing.localPath !== result.record?.localPath) {
      try {
        fs.unlinkSync(localPath);
      } catch {
        /* ignore */
      }
    }
    return { saved: false, reason: result.reason, imageType, sha256: hash };
  }

  logger.info(
    `Saved ${game.name} [${imageType}] ${inspection.width}x${inspection.height} from ${source}`,
  );

  return {
    saved: true,
    localPath: result.record?.localPath,
    imageType,
    width: inspection.width,
    height: inspection.height,
    sha256: hash,
  };
}

export async function inspectRemoteImage(
  url: string,
  proxy?: string,
): Promise<{
  inspection: Awaited<ReturnType<typeof inspectImage>>;
  contentType: string | null;
  host: string;
}> {
  const downloaded = await fetchBuffer(url, { proxy, label: "analyze-image" });
  const inspection = await inspectImage(downloaded.buffer);
  let host = "";
  try {
    host = new URL(downloaded.finalUrl).host;
  } catch {
    host = "";
  }
  return { inspection, contentType: downloaded.contentType, host };
}
