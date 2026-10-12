import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "../config/index.js";
import { gameFolderSlug } from "../core/normalizer.js";
import { createLimiter } from "../core/queue.js";
import { closeDb, getDb } from "../database/db.js";

const CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.WEBP_CONCURRENCY ?? "8", 10) || 8,
);
const WEBP_OPTIONS = { quality: 90, alphaQuality: 100, effort: 4 } as const;
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".heif",
  ".heic",
  ".gif",
  ".avif",
  ".tif",
  ".tiff",
  ".bmp",
]);

interface DbImageRow {
  id: number;
  local_path: string;
}

interface Report {
  dbConverted: number;
  dbRepaired: number;
  looseConverted: number;
  removedSuperseded: number;
  alreadyWebp: number;
  missing: number;
  failed: number;
  staleRowsRemoved: number;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function relativeToWorkspace(file: string): string {
  return path.relative(process.cwd(), file).replace(/\\/g, "/");
}

function webpPath(file: string): string {
  return path.join(path.dirname(file), `${path.parse(file).name}.webp`);
}

async function convertBuffer(file: string): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
}> {
  const buffer = await sharp(file).webp(WEBP_OPTIONS).toBuffer();
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    throw new Error("converted image has no dimensions");
  }
  return { buffer, width: meta.width, height: meta.height };
}

function writeAtomically(target: string, buffer: Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
}

function listFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, local_path FROM game_images ORDER BY id")
    .all() as unknown as DbImageRow[];
  const update = db.prepare(
    `UPDATE game_images
     SET local_path = ?, format = 'webp', file_size = ?, sha256 = ?,
         width = ?, height = ?
     WHERE id = ?`,
  );
  const limit = createLimiter(CONCURRENCY);
  const report: Report = {
    dbConverted: 0,
    dbRepaired: 0,
    looseConverted: 0,
    removedSuperseded: 0,
    alreadyWebp: 0,
    missing: 0,
    failed: 0,
    staleRowsRemoved: 0,
  };

  console.log(`Converting ${rows.length} database images to WebP…`);
  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        const source = path.isAbsolute(row.local_path)
          ? row.local_path
          : path.resolve(process.cwd(), row.local_path);
        if (!fs.existsSync(source)) {
          report.missing++;
          return;
        }

        if (path.extname(source).toLowerCase() === ".webp") {
          report.alreadyWebp++;
          return;
        }

        const target = webpPath(source);
        try {
          const converted = await convertBuffer(source);
          writeAtomically(target, converted.buffer);
          update.run(
            relativeToWorkspace(target),
            converted.buffer.length,
            sha256(converted.buffer),
            converted.width,
            converted.height,
            row.id,
          );
          if (path.resolve(source) !== path.resolve(target) && fs.existsSync(source)) {
            fs.unlinkSync(source);
          }
          report.dbConverted++;
          if (report.dbConverted % 1000 === 0) {
            console.log(`Database images converted: ${report.dbConverted}/${rows.length}`);
          }
        } catch (err) {
          report.failed++;
          console.warn(`Failed ${row.local_path}: ${(err as Error).message}`);
        }
      }),
    ),
  );

  // Convert files not represented by the current DB too.
  const roots = new Set([
    config.imagesDir,
    path.resolve(process.cwd(), "images"),
    path.resolve(process.cwd(), "images-verify"),
  ]);
  const loose = [...roots]
    .flatMap(listFilesRecursive)
    .filter((file) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase()));

  console.log(`Converting ${loose.length} remaining filesystem images…`);
  await Promise.all(
    loose.map((source) =>
      limit(async () => {
        const target = webpPath(source);
        try {
          if (fs.existsSync(target)) {
            fs.unlinkSync(source);
            report.removedSuperseded++;
            return;
          }
          const converted = await convertBuffer(source);
          writeAtomically(target, converted.buffer);
          fs.unlinkSync(source);
          report.looseConverted++;
        } catch (err) {
          report.failed++;
          console.warn(
            `Failed loose file ${relativeToWorkspace(source)}: ${(err as Error).message}`,
          );
        }
      }),
    ),
  );

  // Old folder-case migrations may have left DB paths pointing at files that
  // now live in the canonical game folder. Reconnect those rows after all
  // loose files have been converted.
  const joinedRows = db
    .prepare(
      `SELECT gi.id, gi.image_type, gi.local_path, g.id AS game_id, g.name
       FROM game_images gi
       JOIN games g ON g.id = gi.game_id
       ORDER BY gi.id`,
    )
    .all() as unknown as Array<
    DbImageRow & { image_type: string; game_id: number; name: string }
  >;
  const deleteStale = db.prepare("DELETE FROM game_images WHERE id = ?");
  for (const row of joinedRows) {
    const current = path.isAbsolute(row.local_path)
      ? row.local_path
      : path.resolve(process.cwd(), row.local_path);
    if (fs.existsSync(current)) continue;

    const expected = path.join(
      config.imagesDir,
      gameFolderSlug(row.name),
      `${row.image_type}.webp`,
    );
    if (!fs.existsSync(expected)) {
      deleteStale.run(row.id);
      report.staleRowsRemoved++;
      continue;
    }

    try {
      const buffer = fs.readFileSync(expected);
      const meta = await sharp(buffer).metadata();
      if (!meta.width || !meta.height) throw new Error("WebP has no dimensions");
      update.run(
        relativeToWorkspace(expected),
        buffer.length,
        sha256(buffer),
        meta.width,
        meta.height,
        row.id,
      );
      report.dbRepaired++;
    } catch (err) {
      report.failed++;
      console.warn(`Failed DB repair ${row.local_path}: ${(err as Error).message}`);
    }
  }

  console.log(
    [
      `DB converted: ${report.dbConverted}`,
      `DB paths repaired: ${report.dbRepaired}`,
      `Loose converted: ${report.looseConverted}`,
      `Already WebP: ${report.alreadyWebp}`,
      `Superseded originals removed: ${report.removedSuperseded}`,
      `Missing DB files: ${report.missing}`,
      `Stale DB rows removed: ${report.staleRowsRemoved}`,
      `Failed: ${report.failed}`,
    ].join("\n"),
  );
  closeDb();
}

await main();
