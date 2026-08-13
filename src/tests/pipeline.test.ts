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

test("retry-failed resets only selected attempt IDs", async () => {
  await withTempEnv(async () => {
    const {
      getDb,
      importGames,
      listGames,
      upsertSourceAttempt,
      listFailedSourceAttempts,
      resetSourceAttemptsByIds,
      countSourceAttemptsByStatus,
    } = await import("../database/db.js");
    getDb();

    const rows = Array.from({ length: 100 }, (_, i) => ({
      name: `Retry Game ${i}`,
      provider: "P",
    }));
    importGames(rows);
    const games = listGames({});
    assert.equal(games.length, 100);

    for (const game of games) {
      upsertSourceAttempt({
        gameId: game.id,
        source: "stake",
        targetType: "portrait",
        status: "failed",
        lastError: "test",
        incrementAttempt: true,
      });
    }

    assert.equal(countSourceAttemptsByStatus("failed"), 100);

    const selected = listFailedSourceAttempts({ source: "stake", targetType: "portrait", limit: 10 });
    assert.equal(selected.length, 10);
    const reset = resetSourceAttemptsByIds(selected.map((a) => a.id));
    assert.equal(reset, 10);
    assert.equal(countSourceAttemptsByStatus("pending"), 10);
    assert.equal(countSourceAttemptsByStatus("failed"), 90);
  });
});

test("DB failure during same-path replacement restores old image", async () => {
  await withTempEnv(async () => {
    const { getDb, importGames, listGames, getImageByType } = await import("../database/db.js");
    const { storeImageBuffer, gameImageDir } = await import("../images/downloader.js");
    const { sha256 } = await import("../images/inspector.js");
    getDb();
    importGames([{ name: "Replace Safe", provider: "A" }]);
    const game = listGames({})[0]!;

    const original = await makeImage(300, 400, "png");
    const originalHash = sha256(original);
    const first = await storeImageBuffer({
      game,
      buffer: original,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 40,
      preferType: "portrait",
    });
    assert.equal(first.saved, true);
    const before = getImageByType(game.id, "portrait")!;
    const filePath = path.resolve(before.localPath);
    assert.equal(sha256(fs.readFileSync(filePath)), originalHash);

    const bigger = await makeImage(600, 800, "png");
    const failed = await storeImageBuffer({
      game,
      buffer: bigger,
      source: "test",
      gameMatchScore: 100,
      imageCandidateScore: 50,
      preferType: "portrait",
      upsertFn: () => {
        throw new Error("simulated db failure");
      },
    });
    assert.equal(failed.saved, false);
    assert.match(failed.reason ?? "", /db_update_failed/);

    const after = getImageByType(game.id, "portrait")!;
    assert.equal(after.sha256, originalHash);
    assert.equal(after.width, 300);
    assert.equal(sha256(fs.readFileSync(filePath)), originalHash);
    // No leftover backups in game dir
    const leftovers = fs.readdirSync(gameImageDir(game)).filter((n) => n.includes(".bak.") || n.endsWith(".tmp"));
    assert.equal(leftovers.length, 0);
  });
});

test("cross-game duplicate continues to next unique candidate", async () => {
  await withTempEnv(async () => {
    const { getDb, importGames, listGames, getImageByType } = await import("../database/db.js");
    const { storeImageBuffer } = await import("../images/downloader.js");
    const { sha256 } = await import("../images/inspector.js");
    getDb();
    importGames([
      { name: "Dup Host", provider: "A" },
      { name: "Unique Target", provider: "A" },
    ]);
    const games = listGames({});
    const host = games.find((g) => g.name === "Dup Host")!;
    const target = games.find((g) => g.name === "Unique Target")!;

    const dupBuf = await makeImage(300, 450, "png");
    const uniqueBuf = await makeImage(320, 480, "png");
    await storeImageBuffer({
      game: host,
      buffer: dupBuf,
      source: "seed",
      gameMatchScore: 100,
      imageCandidateScore: 40,
      preferType: "portrait",
    });

    // Mirrors scraper candidate loop: duplicate first, unique second
    const candidates = [dupBuf, uniqueBuf];
    let savedAny = false;
    let sawCrossGameDup = false;
    let lastReason = "unknown";

    for (const buffer of candidates) {
      const saved = await storeImageBuffer({
        game: target,
        buffer,
        source: "test",
        gameMatchScore: 100,
        imageCandidateScore: 50,
        preferType: "portrait",
      });
      if (saved.saved) {
        savedAny = true;
        break;
      }
      lastReason = saved.reason ?? "not_saved";
      if (saved.reason === "cross_game_duplicate") {
        sawCrossGameDup = true;
        continue;
      }
    }

    assert.equal(sawCrossGameDup, true);
    assert.equal(savedAny, true);
    assert.equal(lastReason === "cross_game_duplicate" || savedAny, true);
    const record = getImageByType(target.id, "portrait");
    assert.ok(record);
    assert.equal(record!.sha256, sha256(uniqueBuf));
    assert.notEqual(record!.sha256, sha256(dupBuf));
  });
});

test("dry-run does not persist successful source attempts", async () => {
  await withTempEnv(async () => {
    const { getDb, importGames, countSourceAttemptsByStatus } = await import("../database/db.js");
    const { registerSource } = await import("../sources/registry.js");
    const { runScrape } = await import("../core/scraper.js");
    getDb();
    importGames([{ name: "Dry Run Game", provider: "A" }]);

    registerSource({
      name: "fixture-dry",
      implemented: true,
      enabled: true,
      expectedRatio: "portrait",
      priority: 1,
      async searchGame(game) {
        return [
          {
            title: game.name,
            provider: game.provider,
            slug: "dry-run-game",
            url: "https://example.com/dry",
          },
        ];
      },
      async extractGame(result) {
        return { title: result.title, url: result.url };
      },
      async extractImages() {
        return [];
      },
    });

    await runScrape({ source: "fixture-dry", dryRun: true, limit: 1 });
    assert.equal(countSourceAttemptsByStatus("success"), 0);
    assert.equal(countSourceAttemptsByStatus("processing"), 0);
    assert.equal(countSourceAttemptsByStatus("failed"), 0);
  });
});

test("orphan tmp cleanup keeps recent files and removes old ones", async () => {
  await withTempEnv(async ({ images }) => {
    const { cleanOrphanTmpFiles } = await import("../images/downloader.js");
    const dir = path.join(images, "tmp-clean");
    fs.mkdirSync(dir, { recursive: true });

    const recent = path.join(dir, ".portrait.png.tmp.recent-uuid.tmp");
    const old = path.join(dir, ".portrait.png.tmp.old-uuid.tmp");
    fs.writeFileSync(recent, "recent");
    fs.writeFileSync(old, "old");

    const oldTime = Date.now() - 2 * 60 * 60 * 1000;
    fs.utimesSync(old, oldTime / 1000, oldTime / 1000);

    const result = cleanOrphanTmpFiles(dir, {
      nowMs: Date.now(),
      maxAgeMs: 60 * 60 * 1000,
    });

    assert.ok(fs.existsSync(recent));
    assert.equal(fs.existsSync(old), false);
    assert.ok(result.kept.some((p) => p.endsWith("recent-uuid.tmp")));
    assert.ok(result.removed.some((p) => p.endsWith("old-uuid.tmp")));
  });
});
