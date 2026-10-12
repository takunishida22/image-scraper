import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config/index.js";
import { fetchBuffer } from "../utils/http.js";
import { inspectImage, sha256 } from "./inspector.js";
import { validateImage } from "./validator.js";
import {
  findImageByHash,
  getGameById,
  getImageByType,
  upsertGameImage,
  type UpsertGameImageInput,
  type UpsertGameImageResult,
} from "../database/db.js";
import { gameFolderSlug, normalizeGameName } from "../core/normalizer.js";
import type { GameRecord, ImageType } from "../types.js";
import { logger } from "../utils/logger.js";

export function gameImageDir(game: GameRecord): string {
  return path.join(config.imagesDir, gameFolderSlug(game.name));
}

export async function composeCenteredOverlay(
  background: Buffer,
  overlay: Buffer,
): Promise<Buffer> {
  const metadata = await sharp(background).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error("composition_missing_background_dimensions");

  const fittedOverlay = await sharp(overlay)
    .resize({
      width: Math.max(1, Math.floor(width * 0.8)),
      height: Math.max(1, Math.floor(height * 0.72)),
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  return sharp(background)
    .composite([{ input: fittedOverlay, gravity: "center" }])
    .toBuffer();
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

/** Delete only stale orphan temp files (never active writes from other processes). */
export function cleanOrphanTmpFiles(
  dir: string,
  options: { nowMs?: number; maxAgeMs?: number } = {},
): { removed: string[]; kept: string[] } {
  const removed: string[] = [];
  const kept: string[] = [];
  if (!fs.existsSync(dir)) return { removed, kept };

  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? config.tmpOrphanMaxAgeMs;

  for (const name of fs.readdirSync(dir)) {
    // Our temps look like: .<basename>.tmp.<uuid>.tmp or .<basename>.bak.<uuid>.tmp
    if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (nowMs - st.mtimeMs >= maxAgeMs) {
        fs.unlinkSync(full);
        removed.push(full);
      } else {
        kept.push(full);
      }
    } catch {
      /* ignore */
    }
  }
  return { removed, kept };
}

function tempPathBeside(targetPath: string, kind: "tmp" | "bak"): string {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  return path.join(dir, `.${base}.${kind}.${crypto.randomUUID()}.tmp`);
}

function writeBytesToTemp(tmpPath: string, buffer: Buffer): void {
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, buffer);
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync may be unsupported */
    }
  } finally {
    fs.closeSync(fd);
  }
}

export interface ReplacementPlan {
  localPath: string;
  relativePath: string;
  backupPath: string | null;
  isSamePathReplacement: boolean;
  isFirstWrite: boolean;
}

/**
 * Stage native bytes on disk safely.
 * Same-path replacements: write temp → move old to backup → move temp into place.
 * First writes: atomic temp → target.
 * Different-path upgrades: write new path; keep old until DB confirms.
 */
export function stageNativeImageFile(
  localPath: string,
  buffer: Buffer,
  previousAbsolutePath: string | null,
): ReplacementPlan {
  const dir = path.dirname(localPath);
  fs.mkdirSync(dir, { recursive: true });
  cleanOrphanTmpFiles(dir);

  const relativePath = path.relative(process.cwd(), localPath).replace(/\\/g, "/");
  const previousExists =
    Boolean(previousAbsolutePath) && fs.existsSync(previousAbsolutePath as string);
  const samePath =
    previousExists &&
    path.resolve(previousAbsolutePath as string) === path.resolve(localPath);

  if (!previousExists) {
    const tmp = tempPathBeside(localPath, "tmp");
    writeBytesToTemp(tmp, buffer);
    fs.renameSync(tmp, localPath);
    return {
      localPath,
      relativePath,
      backupPath: null,
      isSamePathReplacement: false,
      isFirstWrite: true,
    };
  }

  if (samePath) {
    const tmp = tempPathBeside(localPath, "tmp");
    const backup = tempPathBeside(localPath, "bak");
    writeBytesToTemp(tmp, buffer);
    // Keep old bytes as backup until DB update succeeds
    fs.renameSync(localPath, backup);
    try {
      fs.renameSync(tmp, localPath);
    } catch (err) {
      // Restore old file if promoting new file fails
      try {
        if (fs.existsSync(backup)) fs.renameSync(backup, localPath);
      } catch {
        /* ignore */
      }
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
    return {
      localPath,
      relativePath,
      backupPath: backup,
      isSamePathReplacement: true,
      isFirstWrite: false,
    };
  }

  // Format/path change: write new file; retain previous as backup to delete after DB success
  const tmp = tempPathBeside(localPath, "tmp");
  writeBytesToTemp(tmp, buffer);
  fs.renameSync(tmp, localPath);
  return {
    localPath,
    relativePath,
    backupPath: previousAbsolutePath,
    isSamePathReplacement: false,
    isFirstWrite: false,
  };
}

export function finalizeNativeImageFile(
  plan: ReplacementPlan,
  dbOk: boolean,
): void {
  if (dbOk) {
    if (plan.backupPath && fs.existsSync(plan.backupPath)) {
      // Same-path: backup is temp .bak; different-path: backup is previous image
      try {
        fs.unlinkSync(plan.backupPath);
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // DB failed — restore previous state
  if (plan.isSamePathReplacement && plan.backupPath && fs.existsSync(plan.backupPath)) {
    try {
      if (fs.existsSync(plan.localPath)) fs.unlinkSync(plan.localPath);
    } catch {
      /* ignore */
    }
    try {
      fs.renameSync(plan.backupPath, plan.localPath);
    } catch {
      /* ignore */
    }
    return;
  }

  // First write or different-path new file: remove the new file; keep previous untouched
  if (fs.existsSync(plan.localPath)) {
    // Only delete if this was a new path (not restoring into previous)
    if (plan.isFirstWrite || !plan.isSamePathReplacement) {
      // For different-path, localPath is the NEW file — delete it
      // For first write, delete the new file
      if (
        plan.isFirstWrite ||
        (plan.backupPath && path.resolve(plan.backupPath) !== path.resolve(plan.localPath))
      ) {
        try {
          fs.unlinkSync(plan.localPath);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

type UpsertFn = (input: UpsertGameImageInput) => UpsertGameImageResult;

async function persistValidatedBuffer(options: {
  game: GameRecord;
  buffer: Buffer;
  contentType: string | null;
  sourceUrl: string;
  source: string;
  gameMatchScore: number;
  imageCandidateScore: number;
  overwrite?: boolean;
  missingOnly?: boolean;
  preferType?: ImageType;
  forceType?: ImageType;
  allowOther?: boolean;
  allowCrossGameDuplicate?: boolean;
  minWidth?: number;
  minHeight?: number;
  squareMinRatio?: number;
  squareMaxRatio?: number;
  landscapeMaxRatio?: number;
  allowSameNameDuplicate?: boolean;
  upsertFn?: UpsertFn;
}): Promise<SaveImageResult> {
  let sourceInspection;
  try {
    sourceInspection = await inspectImage(options.buffer);
  } catch (err) {
    return {
      saved: false,
      reason: (err as Error).message,
      sha256: sha256(options.buffer),
    };
  }

  const validation = validateImage(sourceInspection, options.contentType, {
    minWidth: options.minWidth,
    minHeight: options.minHeight,
  });
  if (!validation.ok) {
    return {
      saved: false,
      reason: validation.reason,
      imageType: sourceInspection.imageType,
      width: sourceInspection.width,
      height: sourceInspection.height,
      sha256: sha256(options.buffer),
    };
  }

  let outputBuffer: Buffer;
  try {
    outputBuffer =
      sourceInspection.format === "webp"
        ? options.buffer
        : await sharp(options.buffer).webp({ quality: 90, alphaQuality: 100, effort: 4 }).toBuffer();
  } catch (err) {
    return {
      saved: false,
      reason: `webp_conversion_failed: ${(err as Error).message}`,
      imageType: sourceInspection.imageType,
      width: sourceInspection.width,
      height: sourceInspection.height,
      sha256: sha256(options.buffer),
    };
  }

  const inspection =
    sourceInspection.format === "webp"
      ? sourceInspection
      : await inspectImage(outputBuffer);
  const hash = sha256(outputBuffer);
  let imageType = options.forceType ?? inspection.imageType;
  if (
    imageType === "other" &&
    options.squareMaxRatio &&
    inspection.ratio >= (options.squareMinRatio ?? config.ratios.squareMin) &&
    inspection.ratio <= options.squareMaxRatio
  ) {
    imageType = "square";
  }
  if (
    imageType === "other" &&
    options.landscapeMaxRatio &&
    inspection.ratio >= config.ratios.landscapeMin &&
    inspection.ratio <= options.landscapeMaxRatio
  ) {
    imageType = "landscape";
  }
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
  if (imageType === "other" && options.preferType !== "other" && !options.forceType && !options.allowOther) {
    return {
      saved: false,
      reason: "wrong_image_type:other",
      imageType,
      width: inspection.width,
      height: inspection.height,
      sha256: hash,
    };
  }

  const existing = getImageByType(options.game.id, imageType);
  if (options.missingOnly && existing) {
    return {
      saved: false,
      reason: "image_type_already_exists",
      localPath: existing.localPath,
      imageType,
      width: existing.width,
      height: existing.height,
      sha256: existing.sha256,
    };
  }

  const existingSameHash = findImageByHash(hash);
  if (existingSameHash) {
    if (existingSameHash.gameId === options.game.id && existingSameHash.imageType === imageType) {
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
    const existingGame =
      existingSameHash.gameId !== options.game.id
        ? getGameById(existingSameHash.gameId)
        : null;
    const isSameNameDuplicate =
      Boolean(options.allowSameNameDuplicate) &&
      Boolean(existingGame) &&
      normalizeGameName(existingGame?.name ?? "") ===
        normalizeGameName(options.game.name);
    if (
      existingSameHash.gameId !== options.game.id &&
      !options.allowCrossGameDuplicate &&
      !isSameNameDuplicate
    ) {
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

  if (existing && !options.overwrite) {
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

  const ext = "webp";
  const localPath = path.join(gameImageDir(options.game), `${imageType}.webp`);
  const previousPath = existing?.localPath
    ? path.isAbsolute(existing.localPath)
      ? existing.localPath
      : path.resolve(process.cwd(), existing.localPath)
    : null;

  const plan = stageNativeImageFile(localPath, outputBuffer, previousPath);
  const upsert = options.upsertFn ?? upsertGameImage;

  let result: UpsertGameImageResult;
  try {
    result = upsert({
      gameId: options.game.id,
      imageType,
      localPath: plan.relativePath,
      width: inspection.width,
      height: inspection.height,
      format: ext,
      fileSize: outputBuffer.length,
      source: options.source,
      sha256: hash,
      gameMatchScore: options.gameMatchScore,
      imageCandidateScore: options.imageCandidateScore,
      overwrite: options.overwrite,
    });
  } catch (err) {
    finalizeNativeImageFile(plan, false);
    return {
      saved: false,
      reason: `db_update_failed: ${(err as Error).message}`,
      imageType,
      sha256: hash,
    };
  }

  if (!result.saved) {
    finalizeNativeImageFile(plan, false);
    return { saved: false, reason: result.reason, imageType, sha256: hash };
  }

  finalizeNativeImageFile(plan, true);

  logger.info(
    `Saved ${options.game.name} [${imageType}] ${inspection.width}x${inspection.height} from ${options.source}`,
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

export async function downloadAndStoreImage(options: {
  game: GameRecord;
  url: string;
  source: string;
  gameMatchScore: number;
  imageCandidateScore: number;
  overwrite?: boolean;
  missingOnly?: boolean;
  proxy?: string;
  preferType?: ImageType;
  forceType?: ImageType;
  allowOther?: boolean;
  allowCrossGameDuplicate?: boolean;
  minWidth?: number;
  minHeight?: number;
  squareMinRatio?: number;
  squareMaxRatio?: number;
  landscapeMaxRatio?: number;
  allowSameNameDuplicate?: boolean;
  overlayUrl?: string | null;
  upsertFn?: UpsertFn;
}): Promise<SaveImageResult> {
  const downloaded = await fetchBuffer(options.url, {
    proxy: options.proxy,
    label: `image:${options.source}`,
  });
  let buffer = downloaded.buffer;
  if (options.overlayUrl) {
    const overlay = await fetchBuffer(options.overlayUrl, {
      proxy: options.proxy,
      label: `image:${options.source}:overlay`,
    });
    buffer = await composeCenteredOverlay(buffer, overlay.buffer);
  }
  return persistValidatedBuffer({
    game: options.game,
    buffer,
    contentType: downloaded.contentType,
    sourceUrl: downloaded.finalUrl,
    source: options.source,
    gameMatchScore: options.gameMatchScore,
    imageCandidateScore: options.imageCandidateScore,
    overwrite: options.overwrite,
    missingOnly: options.missingOnly,
    preferType: options.preferType,
    forceType: options.forceType,
    allowOther: options.allowOther,
    allowCrossGameDuplicate: options.allowCrossGameDuplicate,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    squareMinRatio: options.squareMinRatio,
    squareMaxRatio: options.squareMaxRatio,
    landscapeMaxRatio: options.landscapeMaxRatio,
    allowSameNameDuplicate: options.allowSameNameDuplicate,
    upsertFn: options.upsertFn,
  });
}

export async function storeImageBuffer(options: {
  game: GameRecord;
  buffer: Buffer;
  source: string;
  gameMatchScore: number;
  imageCandidateScore: number;
  contentType?: string | null;
  fakeUrl?: string;
  overwrite?: boolean;
  missingOnly?: boolean;
  preferType?: ImageType;
  forceType?: ImageType;
  allowOther?: boolean;
  allowCrossGameDuplicate?: boolean;
  minWidth?: number;
  minHeight?: number;
  squareMinRatio?: number;
  squareMaxRatio?: number;
  landscapeMaxRatio?: number;
  allowSameNameDuplicate?: boolean;
  upsertFn?: UpsertFn;
}): Promise<SaveImageResult> {
  return persistValidatedBuffer({
    game: options.game,
    buffer: options.buffer,
    contentType: options.contentType ?? null,
    sourceUrl: options.fakeUrl ?? `file.${options.contentType ?? "bin"}`,
    source: options.source,
    gameMatchScore: options.gameMatchScore,
    imageCandidateScore: options.imageCandidateScore,
    overwrite: options.overwrite,
    missingOnly: options.missingOnly,
    preferType: options.preferType,
    forceType: options.forceType,
    allowOther: options.allowOther,
    allowCrossGameDuplicate: options.allowCrossGameDuplicate,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    squareMinRatio: options.squareMinRatio,
    squareMaxRatio: options.squareMaxRatio,
    landscapeMaxRatio: options.landscapeMaxRatio,
    allowSameNameDuplicate: options.allowSameNameDuplicate,
    upsertFn: options.upsertFn,
  });
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
