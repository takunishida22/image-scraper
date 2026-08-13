import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import { fetchBuffer } from "../utils/http.js";
import { extensionFromFormat, inspectImage, sha256 } from "./inspector.js";
import { validateImage } from "./validator.js";
import {
  findImageByHash,
  getImageByType,
  upsertGameImage,
  type UpsertGameImageInput,
  type UpsertGameImageResult,
} from "../database/db.js";
import { slugifyGameName } from "../core/normalizer.js";
import type { GameRecord, ImageType } from "../types.js";
import { logger } from "../utils/logger.js";

export function gameImageDir(game: GameRecord): string {
  const slug = slugifyGameName(game.name) || `game`;
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
  preferType?: ImageType;
  allowOther?: boolean;
  upsertFn?: UpsertFn;
}): Promise<SaveImageResult> {
  const hash = sha256(options.buffer);
  let inspection;
  try {
    inspection = await inspectImage(options.buffer);
  } catch (err) {
    return { saved: false, reason: (err as Error).message, sha256: hash };
  }

  const validation = validateImage(inspection, options.contentType);
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
    if (existingSameHash.gameId !== options.game.id) {
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

  const existing = getImageByType(options.game.id, imageType);
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

  const ext = extensionFromFormat(inspection.format, options.contentType, options.sourceUrl);
  const localPath = path.join(gameImageDir(options.game), `${imageType}.${ext}`);
  const previousPath = existing?.localPath
    ? path.isAbsolute(existing.localPath)
      ? existing.localPath
      : path.resolve(process.cwd(), existing.localPath)
    : null;

  const plan = stageNativeImageFile(localPath, options.buffer, previousPath);
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
      fileSize: options.buffer.length,
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
  proxy?: string;
  preferType?: ImageType;
  allowOther?: boolean;
  upsertFn?: UpsertFn;
}): Promise<SaveImageResult> {
  const downloaded = await fetchBuffer(options.url, {
    proxy: options.proxy,
    label: `image:${options.source}`,
  });
  return persistValidatedBuffer({
    game: options.game,
    buffer: downloaded.buffer,
    contentType: downloaded.contentType,
    sourceUrl: downloaded.finalUrl,
    source: options.source,
    gameMatchScore: options.gameMatchScore,
    imageCandidateScore: options.imageCandidateScore,
    overwrite: options.overwrite,
    preferType: options.preferType,
    allowOther: options.allowOther,
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
  preferType?: ImageType;
  allowOther?: boolean;
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
    preferType: options.preferType,
    allowOther: options.allowOther,
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
