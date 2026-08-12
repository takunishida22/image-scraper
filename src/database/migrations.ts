import type { DatabaseSync } from "node:sqlite";

export function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  const migrations: Array<{ name: string; sql: string }> = [
    {
      name: "001_init",
      sql: `
        CREATE TABLE IF NOT EXISTS games (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          provider TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_games_normalized_provider
          ON games (normalized_name, IFNULL(provider, ''));

        CREATE INDEX IF NOT EXISTS idx_games_status ON games (status);

        CREATE TABLE IF NOT EXISTS game_images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          game_id INTEGER NOT NULL,
          image_type TEXT NOT NULL,
          local_path TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          format TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          source TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_game_images_game_type
          ON game_images (game_id, image_type);

        CREATE INDEX IF NOT EXISTS idx_game_images_sha256 ON game_images (sha256);
        CREATE INDEX IF NOT EXISTS idx_game_images_source ON game_images (source);

        CREATE TABLE IF NOT EXISTS source_stats (
          source TEXT PRIMARY KEY,
          attempted INTEGER NOT NULL DEFAULT 0,
          matched INTEGER NOT NULL DEFAULT 0,
          downloaded INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0,
          review INTEGER NOT NULL DEFAULT 0
        );
      `,
    },
  ];

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(migration.name);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
