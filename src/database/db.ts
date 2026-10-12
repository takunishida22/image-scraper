import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config/index.js";
import type {
  GameImageRecord,
  GameRecord,
  GameStatus,
  ImageType,
  SourceAttemptRecord,
  SourceAttemptStatus,
  SourceStats,
} from "../types.js";
import { canonicalizeGameName, normalizeGameName } from "../core/normalizer.js";
import { runMigrations } from "./migrations.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  db = new DatabaseSync(config.databasePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db);
  return db;
}

function mapGame(row: Record<string, unknown>): GameRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    normalizedName: String(row.normalized_name),
    provider: row.provider == null ? null : String(row.provider),
    status: String(row.status) as GameStatus,
    externalId: row.external_id == null || row.external_id === "" ? null : String(row.external_id),
    imgUrl: row.img_url == null || row.img_url === "" ? null : String(row.img_url),
    imgVerticalUrl:
      row.img_vertical_url == null || row.img_vertical_url === ""
        ? null
        : String(row.img_vertical_url),
    imgWideUrl:
      row.img_wide_url == null || row.img_wide_url === "" ? null : String(row.img_wide_url),
    imgSquareUrl:
      row.img_square_url == null || row.img_square_url === "" ? null : String(row.img_square_url),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapImage(row: Record<string, unknown>): GameImageRecord {
  const gameMatchScore = Number(row.game_match_score ?? row.confidence ?? 0);
  const imageCandidateScore = Number(row.image_candidate_score ?? 0);
  return {
    id: Number(row.id),
    gameId: Number(row.game_id),
    imageType: String(row.image_type) as ImageType,
    localPath: String(row.local_path),
    width: Number(row.width),
    height: Number(row.height),
    format: String(row.format),
    fileSize: Number(row.file_size),
    source: String(row.source),
    sha256: String(row.sha256),
    confidence: gameMatchScore,
    gameMatchScore,
    imageCandidateScore,
    createdAt: String(row.created_at),
  };
}

function mapAttempt(row: Record<string, unknown>): SourceAttemptRecord {
  return {
    id: Number(row.id),
    gameId: Number(row.game_id),
    source: String(row.source),
    targetType: String(row.target_type),
    status: String(row.status) as SourceAttemptStatus,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error == null ? null : String(row.last_error),
    lastAttemptAt: row.last_attempt_at == null ? null : String(row.last_attempt_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function importGames(
  rows: Array<{
    name: string;
    provider?: string | null;
    externalId?: string | null;
    imgUrl?: string | null;
    imgVerticalUrl?: string | null;
    imgWideUrl?: string | null;
    imgSquareUrl?: string | null;
  }>,
): { inserted: number; skipped: number; updated: number } {
  const database = getDb();
  const selectByExternal = database.prepare(
    "SELECT id FROM games WHERE external_id = ? AND external_id IS NOT NULL AND external_id != ''",
  );
  const selectByName = database.prepare(
    "SELECT id FROM games WHERE normalized_name = ? AND IFNULL(provider, '') = IFNULL(?, '')",
  );
  const insert = database.prepare(
    `INSERT INTO games (
       name, normalized_name, provider, status, external_id,
       img_url, img_vertical_url, img_wide_url, img_square_url,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  );
  const updateUrls = database.prepare(
    `UPDATE games SET
       name = ?,
       normalized_name = ?,
       provider = ?,
       external_id = COALESCE(?, external_id),
       img_url = COALESCE(?, img_url),
       img_vertical_url = COALESCE(?, img_vertical_url),
       img_wide_url = COALESCE(?, img_wide_url),
       img_square_url = COALESCE(?, img_square_url),
       updated_at = datetime('now')
     WHERE id = ?`,
  );

  let inserted = 0;
  let skipped = 0;
  let updated = 0;

  database.exec("BEGIN");
  try {
    for (const row of rows) {
      const name = row.name.trim();
      if (!name) {
        skipped++;
        continue;
      }
      const provider = row.provider?.trim() || null;
      const normalized = normalizeGameName(name);
      const externalId = row.externalId?.trim() || null;
      const imgUrl = normalizeSeedUrl(row.imgUrl);
      const imgVerticalUrl = normalizeSeedUrl(row.imgVerticalUrl);
      const imgWideUrl = normalizeSeedUrl(row.imgWideUrl);
      const imgSquareUrl = normalizeSeedUrl(row.imgSquareUrl);

      let existingId: number | undefined;
      if (externalId) {
        existingId = (selectByExternal.get(externalId) as { id: number } | undefined)?.id;
      }
      if (existingId == null) {
        existingId = (selectByName.get(normalized, provider) as { id: number } | undefined)?.id;
      }

      if (existingId != null) {
        updateUrls.run(
          name,
          normalized,
          provider,
          externalId,
          imgUrl,
          imgVerticalUrl,
          imgWideUrl,
          imgSquareUrl,
          existingId,
        );
        updated++;
        continue;
      }

      insert.run(
        name,
        normalized,
        provider,
        externalId,
        imgUrl,
        imgVerticalUrl,
        imgWideUrl,
        imgSquareUrl,
      );
      inserted++;
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  return { inserted, skipped, updated };
}

function normalizeSeedUrl(value?: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v || /^null$/i.test(v)) return null;
  if (!/^https?:\/\//i.test(v)) return null;
  if (/favicon\.ico/i.test(v)) return null;
  return v;
}

export function listGamesWithSeedUrls(options: { limit?: number } = {}): GameRecord[] {
  const database = getDb();
  const limit = options.limit ? `LIMIT ${Number(options.limit)}` : "";
  const rows = database
    .prepare(
      `SELECT * FROM games
       WHERE (img_url IS NOT NULL AND img_url != '')
          OR (img_vertical_url IS NOT NULL AND img_vertical_url != '')
          OR (img_wide_url IS NOT NULL AND img_wide_url != '')
          OR (img_square_url IS NOT NULL AND img_square_url != '')
       ORDER BY id ASC ${limit}`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(mapGame);
}

export function collectSeedUrls(game: GameRecord): string[] {
  const urls = [game.imgUrl, game.imgVerticalUrl, game.imgWideUrl, game.imgSquareUrl].filter(
    (u): u is string => Boolean(u),
  );
  return [...new Set(urls)];
}

export function listGames(options: {
  status?: GameStatus | GameStatus[];
  limit?: number;
  missingType?: ImageType;
  missingAnyType?: boolean;
  ids?: number[];
} = {}): GameRecord[] {
  const database = getDb();
  const clauses: string[] = [];
  const params: Array<string | number | null> = [];

  if (options.status) {
    const statuses = Array.isArray(options.status) ? options.status : [options.status];
    clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }

  if (options.missingType) {
    clauses.push(
      `NOT EXISTS (
         SELECT 1 FROM game_images gi
         WHERE gi.game_id = games.id AND gi.image_type = ?
       )`,
    );
    params.push(options.missingType);
  }

  if (options.missingAnyType) {
    clauses.push(
      `NOT (
         EXISTS (SELECT 1 FROM game_images gi WHERE gi.game_id = games.id AND gi.image_type = 'portrait')
         AND EXISTS (SELECT 1 FROM game_images gi WHERE gi.game_id = games.id AND gi.image_type = 'square')
         AND EXISTS (SELECT 1 FROM game_images gi WHERE gi.game_id = games.id AND gi.image_type = 'landscape')
       )`,
    );
  }

  if (options.ids?.length) {
    clauses.push(`id IN (${options.ids.map(() => "?").join(",")})`);
    params.push(...options.ids);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = options.limit ? `LIMIT ${Number(options.limit)}` : "";
  const stmt = database.prepare(`SELECT * FROM games ${where} ORDER BY id ASC ${limit}`);
  const rows = (params.length ? stmt.all(...params) : stmt.all()) as Record<string, unknown>[];
  return rows.map(mapGame);
}

/** All games whose normalized name equals the given name (case/format insensitive). */
export function listGamesByNormalizedName(name: string): GameRecord[] {
  const key = canonicalizeGameName(name);
  if (!key) return [];
  const rows = getDb()
    .prepare(`SELECT * FROM games WHERE lower(normalized_name) = ? ORDER BY id ASC`)
    .all(key) as Record<string, unknown>[];
  return rows.map(mapGame);
}

export function getGameById(id: number): GameRecord | null {
  const row = getDb().prepare("SELECT * FROM games WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapGame(row) : null;
}

export function updateGameStatus(id: number, status: GameStatus): void {
  getDb()
    .prepare("UPDATE games SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
}

export function recoverStaleProcessing(): number {
  const database = getDb();
  const games = database
    .prepare(
      "UPDATE games SET status = 'pending', updated_at = datetime('now') WHERE status = 'processing'",
    )
    .run();
  database
    .prepare(
      `UPDATE source_attempts
       SET status = 'pending', updated_at = datetime('now')
       WHERE status = 'processing'`,
    )
    .run();
  return Number(games.changes ?? 0);
}

export function getImagesForGame(gameId: number): GameImageRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM game_images WHERE game_id = ? ORDER BY id ASC")
    .all(gameId) as Record<string, unknown>[];
  return rows.map(mapImage);
}

export function getImageByType(gameId: number, imageType: ImageType): GameImageRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM game_images WHERE game_id = ? AND image_type = ? LIMIT 1")
    .get(gameId, imageType) as Record<string, unknown> | undefined;
  return row ? mapImage(row) : null;
}

export function findImageByHash(sha256: string): GameImageRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM game_images WHERE sha256 = ? LIMIT 1")
    .get(sha256) as Record<string, unknown> | undefined;
  return row ? mapImage(row) : null;
}

export function upsertGameImage(input: UpsertGameImageInput): UpsertGameImageResult {
  const database = getDb();
  const existing = getImageByType(input.gameId, input.imageType);
  const gameMatchScore = input.gameMatchScore ?? input.confidence ?? 0;
  const imageCandidateScore = input.imageCandidateScore ?? 0;

  if (existing && !input.overwrite) {
    const existingPixels = existing.width * existing.height;
    const newPixels = input.width * input.height;
    if (newPixels <= existingPixels) {
      return { saved: false, reason: "existing_better_or_equal", record: existing };
    }
  }

  if (existing) {
    database
      .prepare(
        `UPDATE game_images
         SET local_path = ?, width = ?, height = ?, format = ?, file_size = ?,
             source = ?, sha256 = ?, confidence = ?, game_match_score = ?,
             image_candidate_score = ?, created_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        input.localPath,
        input.width,
        input.height,
        input.format,
        input.fileSize,
        input.source,
        input.sha256,
        gameMatchScore,
        gameMatchScore,
        imageCandidateScore,
        existing.id,
      );
  } else {
    database
      .prepare(
        `INSERT INTO game_images
         (game_id, image_type, local_path, width, height, format, file_size, source, sha256,
          confidence, game_match_score, image_candidate_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        input.gameId,
        input.imageType,
        input.localPath,
        input.width,
        input.height,
        input.format,
        input.fileSize,
        input.source,
        input.sha256,
        gameMatchScore,
        gameMatchScore,
        imageCandidateScore,
      );
  }

  const record = getImageByType(input.gameId, input.imageType);
  return { saved: true, record: record ?? undefined };
}

export type UpsertGameImageInput = {
  gameId: number;
  imageType: ImageType;
  localPath: string;
  width: number;
  height: number;
  format: string;
  fileSize: number;
  source: string;
  sha256: string;
  gameMatchScore: number;
  imageCandidateScore: number;
  /** @deprecated */
  confidence?: number;
  overwrite?: boolean;
};

export type UpsertGameImageResult = {
  saved: boolean;
  reason?: string;
  record?: GameImageRecord;
};

/**
 * Derive game status from collected images only (not from a single source failure).
 */
export function refreshGameCompletionStatus(gameId: number): GameStatus {
  const images = getImagesForGame(gameId);
  const types = new Set(images.map((i) => i.imageType));
  const hasPortrait = types.has("portrait");
  const hasSquare = types.has("square");
  const hasLandscape = types.has("landscape");

  let status: GameStatus;
  if (hasPortrait && hasSquare && hasLandscape) status = "completed";
  else if (images.length > 0) status = "partial";
  else status = "pending";

  updateGameStatus(gameId, status);
  return status;
}

export function upsertSourceAttempt(input: {
  gameId: number;
  source: string;
  targetType: string;
  status: SourceAttemptStatus;
  lastError?: string | null;
  incrementAttempt?: boolean;
}): SourceAttemptRecord {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO source_attempts (game_id, source, target_type, status, attempt_count, last_error, last_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, NULL, datetime('now'), datetime('now'))
       ON CONFLICT(game_id, source, target_type) DO NOTHING`,
    )
    .run(input.gameId, input.source, input.targetType, input.status);

  if (input.incrementAttempt) {
    database
      .prepare(
        `UPDATE source_attempts
         SET status = ?, last_error = ?, attempt_count = attempt_count + 1,
             last_attempt_at = datetime('now'), updated_at = datetime('now')
         WHERE game_id = ? AND source = ? AND target_type = ?`,
      )
      .run(
        input.status,
        input.lastError ?? null,
        input.gameId,
        input.source,
        input.targetType,
      );
  } else {
    database
      .prepare(
        `UPDATE source_attempts
         SET status = ?, last_error = ?, last_attempt_at = datetime('now'), updated_at = datetime('now')
         WHERE game_id = ? AND source = ? AND target_type = ?`,
      )
      .run(
        input.status,
        input.lastError ?? null,
        input.gameId,
        input.source,
        input.targetType,
      );
  }

  const row = database
    .prepare(
      `SELECT * FROM source_attempts WHERE game_id = ? AND source = ? AND target_type = ?`,
    )
    .get(input.gameId, input.source, input.targetType) as Record<string, unknown>;
  return mapAttempt(row);
}

export function listFailedSourceAttempts(options: {
  source?: string;
  targetType?: string;
  limit?: number;
}): SourceAttemptRecord[] {
  const clauses: string[] = [`status IN ('failed', 'not_found')`];
  const params: Array<string | number> = [];
  if (options.source) {
    clauses.push("source = ?");
    params.push(options.source);
  }
  if (options.targetType) {
    clauses.push("target_type = ?");
    params.push(options.targetType);
  }
  const limit = options.limit ? `LIMIT ${Number(options.limit)}` : "";
  const rows = getDb()
    .prepare(
      `SELECT * FROM source_attempts WHERE ${clauses.join(" AND ")} ORDER BY id ASC ${limit}`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(mapAttempt);
}

export function resetSourceAttemptsToPending(options: {
  source?: string;
  targetType?: string;
}): number {
  const clauses: string[] = [`status IN ('failed', 'not_found', 'review')`];
  const params: string[] = [];
  if (options.source) {
    clauses.push("source = ?");
    params.push(options.source);
  }
  if (options.targetType) {
    clauses.push("target_type = ?");
    params.push(options.targetType);
  }
  const result = getDb()
    .prepare(
      `UPDATE source_attempts
       SET status = 'pending', updated_at = datetime('now')
       WHERE ${clauses.join(" AND ")}`,
    )
    .run(...params);
  return Number(result.changes ?? 0);
}

/** Reset only the exact attempt rows selected for a retry batch. */
export function resetSourceAttemptsByIds(ids: number[]): number {
  if (!ids.length) return 0;
  const database = getDb();
  const placeholders = ids.map(() => "?").join(",");
  const result = database
    .prepare(
      `UPDATE source_attempts
       SET status = 'pending', updated_at = datetime('now')
       WHERE id IN (${placeholders})
         AND status IN ('failed', 'not_found', 'review')`,
    )
    .run(...ids);
  return Number(result.changes ?? 0);
}

export function countSourceAttemptsByStatus(status: SourceAttemptStatus): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM source_attempts WHERE status = ?`)
    .get(status) as { c: number };
  return Number(row.c);
}

export function bumpSourceStat(
  source: string,
  field: "attempted" | "matched" | "downloaded" | "failed" | "review",
  amount = 1,
): void {
  const database = getDb();
  database
    .prepare(
      `INSERT INTO source_stats (source, attempted, matched, downloaded, failed, review)
       VALUES (?, 0, 0, 0, 0, 0)
       ON CONFLICT(source) DO NOTHING`,
    )
    .run(source);
  database.prepare(`UPDATE source_stats SET ${field} = ${field} + ? WHERE source = ?`).run(amount, source);
}

export function getSourceStats(): SourceStats[] {
  const rows = getDb()
    .prepare("SELECT * FROM source_stats ORDER BY source ASC")
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    source: String(row.source),
    attempted: Number(row.attempted),
    matched: Number(row.matched),
    downloaded: Number(row.downloaded),
    failed: Number(row.failed),
    review: Number(row.review),
  }));
}

export function getOverallStats() {
  const database = getDb();
  const total = Number(
    (database.prepare("SELECT COUNT(*) AS c FROM games").get() as { c: number }).c,
  );
  const countType = (type: ImageType) =>
    Number(
      (
        database
          .prepare("SELECT COUNT(DISTINCT game_id) AS c FROM game_images WHERE image_type = ?")
          .get(type) as { c: number }
      ).c,
    );

  const portrait = countType("portrait");
  const square = countType("square");
  const landscape = countType("landscape");

  const allThree = Number(
    (
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM (
             SELECT game_id FROM game_images
             WHERE image_type IN ('portrait','square','landscape')
             GROUP BY game_id
             HAVING COUNT(DISTINCT image_type) = 3
           )`,
        )
        .get() as { c: number }
    ).c,
  );

  const missingAll = Number(
    (
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM games g
           WHERE NOT EXISTS (SELECT 1 FROM game_images gi WHERE gi.game_id = g.id)`,
        )
        .get() as { c: number }
    ).c,
  );

  const review = Number(
    (
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM source_attempts WHERE status = 'review'`,
        )
        .get() as { c: number }
    ).c,
  );
  const failed = Number(
    (
      database
        .prepare(
          `SELECT COUNT(*) AS c FROM source_attempts WHERE status = 'failed'`,
        )
        .get() as { c: number }
    ).c,
  );

  return { total, portrait, square, landscape, allThree, missingAll, review, failed };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Test helper: point DB at a fresh file and reopen. */
export function resetDbConnection(): void {
  closeDb();
}
