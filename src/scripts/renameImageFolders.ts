/**
 * One-shot: rename image folders to letter/number/'-' slugs (no __gameId),
 * and update games.normalized_name + game_images.local_path.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/index.js";
import { gameFolderSlug, normalizeGameName } from "../core/normalizer.js";
import { closeDb, getDb } from "../database/db.js";

const FOLDER_RE = /^(.+)__(\d+)$/;

function mergeDir(from: string, to: string): { moved: boolean; conflict?: string } {
  if (from === to) return { moved: false };
  if (!fs.existsSync(from)) return { moved: false };
  if (!fs.existsSync(to)) {
    fs.renameSync(from, to);
    return { moved: true };
  }
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (fs.existsSync(dest)) {
      if (fs.statSync(src).isFile()) fs.unlinkSync(src);
      continue;
    }
    fs.renameSync(src, dest);
  }
  const leftover = fs.readdirSync(from);
  if (leftover.length === 0) {
    fs.rmdirSync(from);
    return { moved: true };
  }
  return { moved: true, conflict: `${from} -> ${to} (leftover: ${leftover.join(", ")})` };
}

function renameFoldersIn(
  dir: string,
  folderByGameId: Map<number, string>,
): { renamed: number; skipped: number; conflicts: string[] } {
  let renamed = 0;
  let skipped = 0;
  const conflicts: string[] = [];
  if (!fs.existsSync(dir)) return { renamed, skipped, conflicts };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = path.join(dir, entry.name);
    const m = FOLDER_RE.exec(entry.name);
    const gameId = m ? Number(m[2]) : NaN;
    const nextName = Number.isFinite(gameId) && folderByGameId.has(gameId)
      ? folderByGameId.get(gameId)!
      : gameFolderSlug(m ? m[1]! : entry.name);
    const to = path.join(dir, nextName);
    if (to === from) {
      skipped += 1;
      continue;
    }
    const result = mergeDir(from, to);
    if (result.conflict) conflicts.push(result.conflict);
    if (result.moved) renamed += 1;
    else skipped += 1;
  }
  return { renamed, skipped, conflicts };
}

function patchLocalPath(localPath: string, expectedFolder: string): string {
  const normalized = localPath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const lastDirIdx = parts.length >= 2 ? parts.length - 2 : -1;
  if (lastDirIdx < 0) return localPath;
  if (parts[lastDirIdx] === expectedFolder) return localPath;
  parts[lastDirIdx] = expectedFolder;
  return parts.join("/");
}

function main(): void {
  const db = getDb();
  const games = db.prepare(`SELECT id, name, normalized_name FROM games`).all() as Array<{
    id: number;
    name: string;
    normalized_name: string;
  }>;
  const folderByGameId = new Map(games.map((g) => [g.id, gameFolderSlug(g.name)]));

  const dirs = new Set<string>([
    config.imagesDir,
    path.resolve(process.cwd(), "images"),
    path.resolve(process.cwd(), "images-verify"),
  ]);

  console.log("Renaming folders…");
  for (const dir of dirs) {
    const result = renameFoldersIn(dir, folderByGameId);
    console.log(
      `  ${dir}: renamed=${result.renamed} alreadyOk=${result.skipped} conflicts=${result.conflicts.length}`,
    );
    for (const c of result.conflicts.slice(0, 20)) console.warn(`    conflict: ${c}`);
  }

  const updateGame = db.prepare(`UPDATE games SET normalized_name = ?, updated_at = datetime('now') WHERE id = ?`);
  let gamesUpdated = 0;
  for (const g of games) {
    const next = normalizeGameName(g.name);
    if (next !== g.normalized_name) {
      updateGame.run(next, g.id);
      gamesUpdated += 1;
    }
  }
  console.log(`Updated games.normalized_name: ${gamesUpdated}/${games.length}`);

  const images = db
    .prepare(
      `SELECT gi.id, gi.local_path, g.name
       FROM game_images gi
       JOIN games g ON g.id = gi.game_id`,
    )
    .all() as Array<{ id: number; local_path: string; name: string }>;
  const updateImage = db.prepare(`UPDATE game_images SET local_path = ? WHERE id = ?`);
  let imagesUpdated = 0;
  for (const img of images) {
    const next = patchLocalPath(img.local_path, gameFolderSlug(img.name));
    if (next !== img.local_path) {
      updateImage.run(next, img.id);
      imagesUpdated += 1;
    }
  }
  console.log(`Updated game_images.local_path: ${imagesUpdated}/${images.length}`);

  closeDb();
}

main();
