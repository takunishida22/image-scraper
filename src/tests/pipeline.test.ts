import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";

async function withTempEnv(fn: (dirs: { root: string; db: string; images: string }) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgis-"));
  const db = path.join(root, "test.db");
  const images = path.join(root, "images");
  fs.mkdirSync(images, { recursive: true });

  const { config } = await import("../config/index.js");
  const { resetDbConnection, closeDb } = await import("../database/db.js");

  const prev = {
    databasePath: config.databasePath,
    imagesDir: config.imagesDir,
    logsDir: config.logsDir,
    minImageWidth: config.minImageWidth,
    minImageHeight: config.minImageHeight,
  };

  config.databasePath = db;
  config.imagesDir = images;
  config.logsDir = path.join(root, "logs");
  config.minImageWidth = 50;
  config.minImageHeight = 50;
  resetDbConnection();

  try {
    await fn({ root, db, images });
  } finally {
    closeDb();
    config.databasePath = prev.databasePath;
    config.imagesDir = prev.imagesDir;
    config.logsDir = prev.logsDir;
    config.minImageWidth = prev.minImageWidth;
    config.minImageHeight = prev.minImageHeight;
    resetDbConnection();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function makeImage(
  width: number,
  height: number,
  format: "png" | "jpeg" | "webp" = "png",
): Promise<Buffer> {
  const img = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 180, g: 40, b: 90 },
    },
  });
  if (format === "png") return img.png().toBuffer();
  if (format === "webp") return img.webp({ quality: 80 }).toBuffer();
  return img.jpeg({ quality: 80 }).toBuffer();
}

test("ratio enforcement: prefer portrait rejects square", async () => {
  await withTempEnv(async () => {
    const { getDb, importGames, listGames } = await import("../database/db.js");
    const { storeImageBuffer } = await import("../images/downloader.js");
    getDb();
    importGames([{ name: "Ratio Game", provider: "A" }]);
    const game = listGames({})[0]!;
    const square = await makeImage(400, 400, "png");
    const result = await storeImageBuffer({
      game,
      buffer: square,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 50,
      preferType: "portrait",
    });
    assert.equal(result.saved, false);
    assert.equal(result.reason, "wrong_image_type:square");
  });
});

test("native bytes preserved: saved hash equals input hash", async () => {
  await withTempEnv(async () => {
    const { getDb, importGames, listGames } = await import("../database/db.js");
    const { storeImageBuffer } = await import("../images/downloader.js");
    const { sha256 } = await import("../images/inspector.js");
    getDb();
    importGames([{ name: "Native Bytes", provider: "A" }]);
    const game = listGames({})[0]!;
    const buf = await makeImage(300, 450, "png");
    const inputHash = sha256(buf);
    const result = await storeImageBuffer({
      game,
      buffer: buf,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 50,
      preferType: "portrait",
    });
    assert.equal(result.saved, true);
    assert.equal(result.sha256, inputHash);
    assert.ok(result.localPath);
    const saved = fs.readFileSync(path.resolve(result.localPath!));
    assert.equal(sha256(saved), inputHash);
  });
});

test("extension follows actual bytes not URL", async () => {
  await withTempEnv(async () => {
    const { extensionFromFormat } = await import("../images/inspector.js");
    const { inspectImage } = await import("../images/inspector.js");
    const webp = await makeImage(320, 480, "webp");
    const insp = await inspectImage(webp);
    const ext = extensionFromFormat(insp.format, "image/webp", "https://cdn.example/game.jpg");
    assert.equal(ext, "webp");
  });
});

test("game path collision: same name different ids get different dirs", async () => {
  await withTempEnv(async () => {
    const { getDb, importGames, listGames } = await import("../database/db.js");
    const { gameImageDir, storeImageBuffer } = await import("../images/downloader.js");
    getDb();
    importGames([
      { name: "Lucky Dragon", provider: "Provider A" },
      { name: "Lucky Dragon", provider: "Provider B" },
    ]);
    const games = listGames({});
    assert.equal(games.length, 2);
    const dirA = gameImageDir(games[0]!);
    const dirB = gameImageDir(games[1]!);
    assert.notEqual(dirA, dirB);
    assert.match(path.basename(dirA), /__\d+$/);

    const buf = await makeImage(300, 450, "png");
    await storeImageBuffer({
      game: games[0]!,
      buffer: buf,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 40,
      preferType: "portrait",
    });
    await storeImageBuffer({
      game: games[1]!,
      buffer: await makeImage(310, 470, "png"),
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 40,
      preferType: "portrait",
    });
    assert.ok(fs.existsSync(path.join(dirA, "portrait.png")));
    assert.ok(fs.existsSync(path.join(dirB, "portrait.png")));
  });
});

test("existing higher quality is not replaced", async () => {
  await withTempEnv(async () => {
    const { getDb, importGames, listGames, getImageByType } = await import("../database/db.js");
    const { storeImageBuffer } = await import("../images/downloader.js");
    getDb();
    importGames([{ name: "Quality Game", provider: "A" }]);
    const game = listGames({})[0]!;
    const big = await makeImage(600, 800, "png");
    const small = await makeImage(300, 400, "png");
    const first = await storeImageBuffer({
      game,
      buffer: big,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 50,
      preferType: "portrait",
    });
    assert.equal(first.saved, true);
    const second = await storeImageBuffer({
      game,
      buffer: small,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 50,
      preferType: "portrait",
    });
    assert.equal(second.saved, false);
    assert.equal(second.reason, "existing_better_or_equal");
    const record = getImageByType(game.id, "portrait");
    assert.equal(record?.width, 600);
  });
});

test("better native image replaces worse", async () => {
  await withTempEnv(async () => {
    const { getDb, importGames, listGames, getImageByType } = await import("../database/db.js");
    const { storeImageBuffer } = await import("../images/downloader.js");
    getDb();
    importGames([{ name: "Upgrade Game", provider: "A" }]);
    const game = listGames({})[0]!;
    const small = await makeImage(300, 400, "jpeg");
    const big = await makeImage(600, 800, "webp");
    await storeImageBuffer({
      game,
      buffer: small,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 40,
      preferType: "portrait",
      fakeUrl: "https://cdn.example/x.jpg",
    });
    const upgraded = await storeImageBuffer({
      game,
      buffer: big,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 60,
      preferType: "portrait",
      fakeUrl: "https://cdn.example/x.jpg",
    });
    assert.equal(upgraded.saved, true);
    const record = getImageByType(game.id, "portrait");
    assert.equal(record?.width, 600);
    assert.equal(record?.format, "webp");
    assert.ok(record?.localPath?.endsWith("portrait.webp"));
    assert.equal(fs.existsSync(path.resolve(record!.localPath.replace(/portrait\.webp$/, "portrait.jpg"))), false);
  });
});

test("cross-game duplicate is suspicious", async () => {
  await withTempEnv(async () => {
    const { getDb, importGames, listGames } = await import("../database/db.js");
    const { storeImageBuffer } = await import("../images/downloader.js");
    getDb();
    importGames([
      { name: "Game One", provider: "A" },
      { name: "Game Two", provider: "B" },
    ]);
    const [g1, g2] = listGames({});
    const buf = await makeImage(300, 450, "png");
    const first = await storeImageBuffer({
      game: g1!,
      buffer: buf,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 40,
      preferType: "portrait",
    });
    assert.equal(first.saved, true);
    const second = await storeImageBuffer({
      game: g2!,
      buffer: buf,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 40,
      preferType: "portrait",
    });
    assert.equal(second.saved, false);
    assert.equal(second.reason, "cross_game_duplicate");
  });
});

test("source attempt failure does not wipe other source image coverage", async () => {
  await withTempEnv(async () => {
    const {
      getDb,
      importGames,
      listGames,
      upsertSourceAttempt,
      refreshGameCompletionStatus,
      getGameById,
    } = await import("../database/db.js");
    const { storeImageBuffer } = await import("../images/downloader.js");
    getDb();
    importGames([{ name: "Multi Source", provider: "A" }]);
    const game = listGames({})[0]!;
    await storeImageBuffer({
      game,
      buffer: await makeImage(400, 400, "png"),
      source: "source-a",
      gameMatchScore: 100,
      imageCandidateScore: 40,
      preferType: "square",
    });
    refreshGameCompletionStatus(game.id);
    upsertSourceAttempt({
      gameId: game.id,
      source: "stake",
      targetType: "portrait",
      status: "failed",
      lastError: "search_failed",
      incrementAttempt: true,
    });
    const status = refreshGameCompletionStatus(game.id);
    assert.equal(status, "partial");
    assert.equal(getGameById(game.id)?.status, "partial");
  });
});

test("srcset prefers highest native width descriptor", async () => {
  await withTempEnv(async () => {
    const { parseSrcsetEntries } = await import("../images/discovery.js");
    const { rankImageCandidates } = await import("../core/matcher.js");
    const entries = parseSrcsetEntries(
      "image-320.jpg 320w, image-640.jpg 640w, image-1200.jpg 1200w",
    );
    assert.equal(entries.length, 3);
    assert.equal(entries[2]?.widthHint, 1200);

    const game = {
      id: 1,
      name: "Srcset Game",
      normalizedName: "srcset game",
      provider: null,
      status: "pending" as const,
      createdAt: "",
      updatedAt: "",
    };
    const ranked = rankImageCandidates(
      game,
      entries.map((e) => ({
        url: `https://cdn.example/${e.url}`,
        widthHint: e.widthHint,
        sourceHint: "img[srcset]",
        context: "thumbnail",
      })),
    );
    assert.ok(ranked[0]?.candidate.url.includes("1200"));
  });
});
