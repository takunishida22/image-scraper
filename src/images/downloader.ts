import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import { fetchBuffer } from "../utils/http.js";
import { extensionFromFormat, inspectImage, sha256 } from "./inspector.js";
import { validateImage } from "./validator.js";
import { findImageByHash, getImageByType, upsertGameImage } from "../database/db.js";
import { slugifyGameName } from "../core/normalizer.js";
import type { GameRecord, ImageType } from "../types.js";
import { logger } from "../utils/logger.js";

export function gameImageDir(game: GameRecord): string {
  const slug = slugifyGameName(game.name) || `game`;
  // Include DB id so same name + different provider never collide on disk
  return path.join(config.imagesDir, `${slug}__${game.id}`);
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

function cleanOrphanTmpFiles(dir: string): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".tmp")) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
  }
}

/** Write exact bytes atomically (temp file in same directory + rename). */
export function atomicWriteFile(targetPath: string, buffer: Buffer): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  cleanOrphanTmpFiles(dir);

  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, buffer);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync may be unsupported on some FS */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, targetPath);
}

export async function downloadAndStoreImage(options: {
  game: GameRecord;
  url: string;
  source: string;
  gameMatchScore: number;
  imageCandidateScore: number;
  overwrite?: boolean;
  proxy?: string;
  /** Only save when classified type matches this exactly. */
  preferType?: ImageType;
  /** Allow saving "other" ratio (analyze / explicit --type other). */
  allowOther?: boolean;
}): Promise<SaveImageResult> {
  const {
    game,
    url,
    source,
    gameMatchScore,
    imageCandidateScore,
    overwrite = false,
    proxy,
    preferType,
    allowOther = false,
  } = options;

  const downloaded = await fetchBuffer(url, { proxy, label: `image:${source}` });
  const hash = sha256(downloaded.buffer);

  let inspection;
  try {
    inspection = await inspectImage(downloaded.buffer);
  } catch (err) {
    return { saved: false, reason: (err as Error).message, sha256: hash };
  }

  const validation = validateImage(inspection, downloaded.contentType);
  if (!validation.ok) {
    return {
      saved: false,
      reason: validation.reason,
      imageType: inspection.imageType,
      width: inspection.width,
      height: inspection.height,
      sha256: hash,
    };
  }

  const imageType = inspection.imageType;

  if (preferType && imageType !== preferType) {
    return {
      saved: false,
      reason: `wrong_image_type:${imageType}`,
      imageType,
      width: inspection.width,
      height: inspection.height,
      sha256: hash,
    };
  }

  if (imageType === "other" && preferType !== "other" && !allowOther) {
    return {
      saved: false,
      reason: "wrong_image_type:other",
      imageType,
      width: inspection.width,
      height: inspection.height,
      sha256: hash,
    };
  }

  const existingSameHash = findImageByHash(hash);
  if (existingSameHash) {
    if (existingSameHash.gameId === game.id && existingSameHash.imageType === imageType) {
      return {
        saved: false,
        reason: "already_stored",
        localPath: existingSameHash.localPath,
        imageType,
        width: inspection.width,
        height: inspection.height,
        sha256: hash,
      };
    }
    if (existingSameHash.gameId !== game.id) {
      return {
        saved: false,
        reason: "cross_game_duplicate",
        localPath: existingSameHash.localPath,
        imageType,
        width: inspection.width,
        height: inspection.height,
        sha256: hash,
      };
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

  const ext = extensionFromFormat(inspection.format, downloaded.contentType, downloaded.finalUrl);
  const filename = `${imageType}.${ext}`;
  const localPath = path.join(dir, filename);
  const relativePath = path.relative(process.cwd(), localPath).replace(/\\/g, "/");
  const previousPath = existing?.localPath
    ? path.isAbsolute(existing.localPath)
      ? existing.localPath
      : path.resolve(process.cwd(), existing.localPath)
    : null;

  // Preserve original network bytes — no Sharp transform / recompress
  atomicWriteFile(localPath, downloaded.buffer);

  const result = upsertGameImage({
    gameId: game.id,
    imageType,
    localPath: relativePath,
    width: inspection.width,
    height: inspection.height,
    format: ext,
    fileSize: downloaded.buffer.length,
    source,
    sha256: hash,
    gameMatchScore,
    imageCandidateScore,
    overwrite,
  });

  if (!result.saved) {
    // DB rejected — remove newly written file if it isn't the previous one
    if (!previousPath || path.resolve(previousPath) !== path.resolve(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch {
        /* ignore */
      }
    }
    return { saved: false, reason: result.reason, imageType, sha256: hash };
  }

  // After successful DB update, remove obsolete file if extension/path changed
  if (
    previousPath &&
    path.resolve(previousPath) !== path.resolve(localPath) &&
    fs.existsSync(previousPath)
  ) {
    try {
      fs.unlinkSync(previousPath);
    } catch {
      /* ignore */
    }
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

/**
 * Store already-downloaded native bytes (for tests / offline fixtures).
 * Still enforces preferType and never transforms bytes.
 */
export async function storeImageBuffer(options: {
  game: GameRecord;
  buffer: Buffer;
  source: string;
  gameMatchScore: number;
  imageCandidateScore: number;
  contentType?: string | null;
  fakeUrl?: string;
  overwrite?: boolean;
  preferType?: ImageType;
  allowOther?: boolean;
}): Promise<SaveImageResult> {
  const hash = sha256(options.buffer);
  let inspection;
  try {
    inspection = await inspectImage(options.buffer);
  } catch (err) {
    return { saved: false, reason: (err as Error).message, sha256: hash };
  }

  const validation = validateImage(inspection, options.contentType ?? null);
  if (!validation.ok) {
    return { saved: false, reason: validation.reason, imageType: inspection.imageType, sha256: hash };
  }

  const imageType = inspection.imageType;
  if (options.preferType && imageType !== options.preferType) {
    return {
      saved: false,
      reason: `wrong_image_type:${imageType}`,
      imageType,
      width: inspection.width,
      height: inspection.height,
      sha256: hash,
    };
  }
  if (imageType === "other" && options.preferType !== "other" && !options.allowOther) {
    return {
      saved: false,
      reason: "wrong_image_type:other",
      imageType,
      width: inspection.width,
      height: inspection.height,
      sha256: hash,
    };
  }

  const existingSameHash = findImageByHash(hash);
  if (existingSameHash && existingSameHash.gameId !== options.game.id) {
    return {
      saved: false,
      reason: "cross_game_duplicate",
      imageType,
      width: inspection.width,
      height: inspection.height,
      sha256: hash,
    };
  }
  if (
    existingSameHash &&
    existingSameHash.gameId === options.game.id &&
    existingSameHash.imageType === imageType
  ) {
    return {
      saved: false,
      reason: "already_stored",
      localPath: existingSameHash.localPath,
      imageType,
      sha256: hash,
    };
  }

  const existing = getImageByType(options.game.id, imageType);
  if (existing && !options.overwrite) {
    if (existing.width * existing.height >= inspection.width * inspection.height) {
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

  const dir = gameImageDir(options.game);
  const ext = extensionFromFormat(
    inspection.format,
    options.contentType ?? null,
    options.fakeUrl ?? `file.${inspection.format}`,
  );
  const localPath = path.join(dir, `${imageType}.${ext}`);
  const relativePath = path.relative(process.cwd(), localPath).replace(/\\/g, "/");
  const previousPath = existing?.localPath
    ? path.isAbsolute(existing.localPath)
      ? existing.localPath
      : path.resolve(process.cwd(), existing.localPath)
    : null;

  atomicWriteFile(localPath, options.buffer);

  const result = upsertGameImage({
    gameId: options.game.id,
    imageType,
    localPath: relativePath,
    width: inspection.width,
    height: inspection.height,
    format: ext,
    fileSize: options.buffer.length,
    source: options.source,
    sha256: hash,
    gameMatchScore: options.gameMatchScore,
    imageCandidateScore: options.imageCandidateScore,
    overwrite: options.overwrite,
  });

  if (!result.saved) {
    if (!previousPath || path.resolve(previousPath) !== path.resolve(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch {
        /* ignore */
      }
    }
    return { saved: false, reason: result.reason, imageType, sha256: hash };
  }

  if (
    previousPath &&
    path.resolve(previousPath) !== path.resolve(localPath) &&
    fs.existsSync(previousPath)
  ) {
    try {
      fs.unlinkSync(previousPath);
    } catch {
      /* ignore */
    }
  }

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
