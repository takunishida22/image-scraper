import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  canonicalizeGameName,
  createRequestHandler,
  fallbackOrder,
  ImageRepository,
} from "./server.mjs";

test("normalizes names and orders fallbacks", () => {
  assert.equal(canonicalizeGameName("Sweet-Bonanza™"), "sweet-bonanza");
  assert.equal(canonicalizeGameName("The &quot;Best&quot; Game"), "the-best-game");
  assert.deepEqual(fallbackOrder(), ["portrait", "square", "landscape"]);
  assert.deepEqual(fallbackOrder("square"), ["square", "portrait", "landscape"]);
});

test("repository refreshes automatically after newly scraped files appear", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "image-repository-"));
  const imagesRoot = path.join(root, "images");
  const gameDir = path.join(imagesRoot, "Sweet-bonanza");
  const databasePath = path.join(root, "scraper.db");
  fs.mkdirSync(gameDir, { recursive: true });
  fs.writeFileSync(path.join(gameDir, "portrait.webp"), "portrait");

  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE games (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL
    );
    CREATE TABLE game_images (
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL,
      image_type TEXT NOT NULL,
      local_path TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      format TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      source TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      game_match_score REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO games VALUES (1, 'Sweet Bonanza', 'Sweet-bonanza');
    INSERT INTO game_images VALUES (
      1, 1, 'portrait', 'images/Sweet-bonanza/portrait.webp',
      300, 400, 'webp', 8, 'shuffle', 'portrait-hash', 100, datetime('now')
    );
  `);
  db.close();

  const repository = new ImageRepository({
    databasePath,
    storageRoot: root,
    imagesRoot,
    indexPollMs: 250,
  });
  try {
    assert.equal(repository.resolve("SWEET BONANZA")?.imageType, "portrait");

    fs.writeFileSync(path.join(gameDir, "square.webp"), "square");
    const writer = new DatabaseSync(databasePath);
    writer
      .prepare(
        `INSERT INTO game_images VALUES (
          2, 1, 'square', 'images/Sweet-bonanza/square.webp',
          400, 400, 'webp', 6, 'csv', 'square-hash', 100, datetime('now')
        )`,
      )
      .run();
    writer.close();

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(repository.resolve("Sweet Bonanza", "square")?.imageType, "square");
  } finally {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP endpoint serves the resolved WebP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-http-"));
  const imagePath = path.join(dir, "portrait.webp");
  const bytes = Buffer.from("fake-webp");
  fs.writeFileSync(imagePath, bytes);

  const repository = {
    resolve: () => ({
      gameName: "Sweet Bonanza",
      imageType: "portrait",
      absolutePath: imagePath,
      fileSize: bytes.length,
      sha256: "abc123",
      lastModified: new Date(0).toUTCString(),
    }),
    health: () => ({ games: 1, images: 1 }),
  };
  const server = http.createServer(createRequestHandler(repository));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/Sweet%20Bonanza`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "fake-webp");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
