import assert from "node:assert/strict";
import test from "node:test";
import { decideMatch, scoreSearchMatch } from "../core/matcher.js";
import { normalizeGameName, providerNormalize, slugifyGameName, gameFolderSlug, correctFolderSlug } from "../core/normalizer.js";
import type { GameRecord, SearchResult } from "../types.js";

function game(name: string, provider: string): GameRecord {
  return {
    id: 1,
    name,
    normalizedName: normalizeGameName(name),
    provider,
    status: "pending",
    externalId: null,
    imgUrl: null,
    imgVerticalUrl: null,
    imgWideUrl: null,
    imgSquareUrl: null,
    createdAt: "",
    updatedAt: "",
  };
}

function hit(title: string, provider: string, slug = "x"): SearchResult {
  return {
    title,
    provider,
    slug,
    url: `https://bc.game/game/${slug}`,
    thumbnailUrl: "https://imgxcut.com/game/image/a.png",
  };
}

test("normalizeGameName capitalizes only the first letter", () => {
  assert.equal(normalizeGameName("SWEET BONANZA"), "Sweet-bonanza");
  assert.equal(normalizeGameName("legend-of-perseus"), "Legend-of-perseus");
  assert.equal(normalizeGameName("3 Lucky Baozhu"), "3-lucky-baozhu");
  assert.equal(normalizeGameName("20 Super Hot"), "20-super-hot");
});

test("normalizeGameName keeps only letters, numbers, and hyphens", () => {
  assert.equal(normalizeGameName(`The "Best" Game`), "The-best-game");
  assert.equal(normalizeGameName("The &quot;Best&quot; Game"), "The-best-game");
  assert.equal(normalizeGameName("Play'n GO Wild"), "Play-n-go-wild");
  assert.equal(normalizeGameName("Foo_Bar/Baz"), "Foo-bar-baz");
});

test("slugifyGameName stays lowercase; folder slug capitalizes first letter", () => {
  assert.equal(slugifyGameName("Sweet Bonanza"), "sweet-bonanza");
  assert.equal(gameFolderSlug("Sweet Bonanza"), "Sweet-bonanza");
  assert.equal(gameFolderSlug("3 Lucky Baozhu"), "3-lucky-baozhu");
  assert.equal(correctFolderSlug("sweet-bonanza"), "Sweet-bonanza");
  assert.equal(correctFolderSlug("1000-moon-girls"), "1000-moon-girls");
  assert.equal(correctFolderSlug("Sweet-bonanza__142"), "Sweet-bonanza");
});

test("providerNormalize aligns common BC/CSV labels", () => {
  assert.equal(providerNormalize("Evolution"), providerNormalize("Evolution Gaming"));
  assert.equal(providerNormalize("Nolimit City"), providerNormalize("NoLimitCity"));
  assert.equal(providerNormalize("Play'n GO"), providerNormalize("Playn GO"));
  assert.equal(providerNormalize("PG Soft"), providerNormalize("PG"));
});

test("exact normalized name accepts and ignores provider", () => {
  const score = scoreSearchMatch(
    game("Lightning Roulette", "Evolution"),
    hit("Lightning Roulette", "Totally Different Provider"),
  );
  assert.equal(score.total, 100);
  assert.equal(decideMatch(score.total), "accept");
  assert.ok(!score.reasons.some((r) => /provider/i.test(r)));
});

test("partial title without exact name does not auto-accept", () => {
  const score = scoreSearchMatch(
    game("Sweet", "Pragmatic Play"),
    hit("Sweet Bonanza", "BGaming"),
  );
  assert.ok(score.total < 100);
  assert.equal(decideMatch(score.total), "reject");
});
