import { normalizeGameName, hasMeaningfulVariantDiff } from "../core/normalizer.js";
import { classifyRatio } from "../core/classifier.js";
import { scoreSearchMatch, decideMatch } from "../core/matcher.js";

const samples = ["Sweet Bonanza", "SWEET-BONANZA", "sweet_bonanza", "Sweet   Bonanza™"];
for (const s of samples) {
  console.log(`${s} -> ${normalizeGameName(s)}`);
}
console.log("variant 1000", hasMeaningfulVariantDiff("Sweet Bonanza", "Sweet Bonanza 1000"));
console.log("portrait", classifyRatio(600, 800));
console.log("square", classifyRatio(600, 600));
console.log("landscape", classifyRatio(800, 450));

const game = {
  id: 1,
  name: "Sweet Bonanza",
  normalizedName: "sweet bonanza",
  provider: "Pragmatic Play",
  status: "pending" as const,
  createdAt: "",
  updatedAt: "",
};
const exact = scoreSearchMatch(game, {
  title: "Sweet Bonanza",
  provider: "Pragmatic Play",
  url: "x",
  slug: "sweet-bonanza",
});
const v1000 = scoreSearchMatch(game, {
  title: "Sweet Bonanza 1000",
  provider: "Pragmatic Play",
  url: "x",
  slug: "sweet-bonanza-1000",
});
console.log("exact", exact.total, decideMatch(exact.total));
console.log("1000", v1000.total, decideMatch(v1000.total), v1000.reasons.join(","));
