import assert from "node:assert/strict";
import test from "node:test";

test("multiwin slot games expose all three requested image fields", async () => {
  const { multiwinSource } = await import("../sources/multiwin/index.js");
  const page = await multiwinSource.extractGame({
    title: "Cat Mansion",
    provider: "NinjaGaming",
    slug: "game-id",
    url: "https://multiwin11.com/api/game-id",
    thumbnailUrl: null,
    raw: {
      _product: "casino",
      name: "Cat Mansion",
      background_image: "/storage/background__S.avif",
      cover_image: "/storage/cover__M.avif",
      custom_background_image: "/storage/custom.avif",
    },
  });

  const images = await multiwinSource.extractImages(page);
  assert.deepEqual(
    images.map((candidate) => candidate.url),
    [
      "https://multiwin11.com/storage/background__S.avif",
      "https://multiwin11.com/storage/cover__M.avif",
      "https://multiwin11.com/storage/custom.avif",
    ],
  );
  assert.equal(multiwinSource.saveAllCandidates, true);
  assert.equal(multiwinSource.squareMinRatio, 0.85);
  assert.equal(multiwinSource.landscapeMaxRatio, 10);
});

test("multiwin live games exclude custom background images", async () => {
  const { multiwinSource } = await import("../sources/multiwin/index.js");
  const page = await multiwinSource.extractGame({
    title: "Blackjack 1",
    provider: "Ninja gaming lc",
    slug: "live-id",
    url: "https://multiwin11.com/api/live-id",
    thumbnailUrl: null,
    raw: {
      _product: "live_casino",
      name: "Blackjack 1",
      background_image: "/storage/live__S.avif",
      cover_image: "/storage/live__M.avif",
      custom_background_image: "/storage/ignored.avif",
    },
  });

  const images = await multiwinSource.extractImages(page);
  assert.equal(images.length, 2);
  assert.ok(images.every((candidate) => !candidate.url.includes("ignored")));
});
