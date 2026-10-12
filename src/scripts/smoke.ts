/**
 * Offline smoke test — no live casino sites.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgis-smoke-"));
const dbPath = path.join(root, "smoke.db");
const imagesDir = path.join(root, "images");
const logsDir = path.join(root, "logs");
const csvPath = path.join(root, "games.csv");

fs.mkdirSync(imagesDir, { recursive: true });
fs.writeFileSync(
  csvPath,
  "name,provider\nSmoke Portrait,TestCo\nSmoke Square,TestCo\nLucky Dragon,Alpha\nLucky Dragon,Beta\n",
  "utf8",
);

const { config } = await import("../config/index.js");
config.databasePath = dbPath;
config.imagesDir = imagesDir;
config.logsDir = logsDir;
config.minImageWidth = 50;
config.minImageHeight = 50;

const { resetDbConnection, getDb, closeDb, getOverallStats, listGames, getImageByType, upsertSourceAttempt, refreshGameCompletionStatus } =
  await import("../database/db.js");
const { importGamesFromCsv } = await import("../cli/importCsv.js");
const { storeImageBuffer, gameImageDir } = await import("../images/downloader.js");
const { inspectImage, sha256, extensionFromFormat } = await import("../images/inspector.js");
const { classifyRatio } = await import("../core/classifier.js");
const { formatStats } = await import("../cli/stats.js");

resetDbConnection();
getDb();

console.log("1) DB migration + CSV import");
const imported = importGamesFromCsv(csvPath);
assert.ok(imported.inserted >= 4);

console.log("2) Ratio classification");
assert.equal(classifyRatio(600, 800), "portrait");
assert.equal(classifyRatio(600, 600), "square");
assert.equal(classifyRatio(800, 450), "landscape");

console.log("3) Native byte preservation + correct extension");
const portraitPng = await sharp({
  create: { width: 300, height: 450, channels: 3, background: { r: 10, g: 100, b: 200 } },
}).png().toBuffer();
const games = listGames({});
const gPortrait = games.find((g) => g.name === "Smoke Portrait")!;
const hashIn = sha256(portraitPng);
const saved = await storeImageBuffer({
  game: gPortrait,
  buffer: portraitPng,
  source: "fixture",
  gameMatchScore: 130,
  imageCandidateScore: 55,
  preferType: "portrait",
  fakeUrl: "https://cdn.example/art.jpg",
});
assert.equal(saved.saved, true);
assert.equal(saved.sha256, hashIn);
assert.ok(saved.localPath?.endsWith(".png"));
const onDisk = fs.readFileSync(path.resolve(saved.localPath!));
assert.equal(sha256(onDisk), hashIn);

const insp = await inspectImage(portraitPng);
assert.equal(extensionFromFormat(insp.format, "image/png", "https://x/a.jpg"), "png");

console.log("4) Wrong-ratio rejection");
const square = await sharp({
  create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 20, b: 20 } },
}).png().toBuffer();
const rejected = await storeImageBuffer({
  game: gPortrait,
  buffer: square,
  source: "fixture",
  gameMatchScore: 100,
  imageCandidateScore: 40,
  preferType: "portrait",
});
assert.equal(rejected.saved, false);
assert.equal(rejected.reason, "wrong_image_type:square");

console.log("5) Same-name games share one folder");
const dragons = games.filter((g) => g.name === "Lucky Dragon");
assert.equal(dragons.length, 2);
assert.equal(gameImageDir(dragons[0]!), gameImageDir(dragons[1]!));
assert.doesNotMatch(path.basename(gameImageDir(dragons[0]!)), /__\d+$/);

console.log("6) Duplicate detection");
const gSquare = games.find((g) => g.name === "Smoke Square")!;
await storeImageBuffer({
  game: gSquare,
  buffer: await sharp({
    create: { width: 400, height: 400, channels: 3, background: { r: 20, g: 200, b: 20 } },
  }).png().toBuffer(),
  source: "fixture",
  gameMatchScore: 100,
  imageCandidateScore: 40,
  preferType: "square",
});
const cross = await storeImageBuffer({
  game: gSquare,
  buffer: portraitPng,
  source: "fixture",
  gameMatchScore: 100,
  imageCandidateScore: 40,
  preferType: "portrait",
});
assert.equal(cross.reason, "cross_game_duplicate");

console.log("7) Source failure keeps partial game status");
upsertSourceAttempt({
  gameId: gSquare.id,
  source: "stake",
  targetType: "portrait",
  status: "failed",
  lastError: "blocked",
  incrementAttempt: true,
});
assert.equal(refreshGameCompletionStatus(gSquare.id), "partial");
assert.ok(getImageByType(gSquare.id, "square"));

console.log("8) Stats");
const stats = getOverallStats();
assert.ok(stats.total >= 4);
assert.ok(stats.portrait >= 1);
assert.ok(stats.square >= 1);
console.log(formatStats());

closeDb();
fs.rmSync(root, { recursive: true, force: true });
console.log("\nSMOKE OK");
