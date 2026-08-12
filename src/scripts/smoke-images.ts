import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  closeDb,
  getDb,
  getOverallStats,
  importGames,
  listGames,
  upsertGameImage,
} from "../database/db.js";
import { inspectImage } from "../images/inspector.js";
import { validateImage } from "../images/validator.js";

getDb();

const buf = await sharp({
  create: {
    width: 600,
    height: 800,
    channels: 3,
    background: { r: 200, g: 40, b: 80 },
  },
}).png().toBuffer();

const insp = await inspectImage(buf);
console.log("inspection", insp);
console.log("valid", validateImage(insp, "image/png"));

const dir = "./images/test-portrait-game";
fs.mkdirSync(dir, { recursive: true });
const local = path.join(dir, "portrait.png");
fs.writeFileSync(local, buf);
const hash = crypto.createHash("sha256").update(buf).digest("hex");

importGames([{ name: "Test Portrait Game", provider: "Test" }]);
const g = listGames({}).find((x) => x.name === "Test Portrait Game");
if (!g) throw new Error("missing game");

const r = upsertGameImage({
  gameId: g.id,
  imageType: insp.imageType,
  localPath: local.replace(/\\/g, "/"),
  width: insp.width,
  height: insp.height,
  format: "png",
  fileSize: buf.length,
  source: "local-test",
  sha256: hash,
  confidence: 100,
});

console.log("saved", r.saved, insp.imageType);
console.log(getOverallStats());
closeDb();
