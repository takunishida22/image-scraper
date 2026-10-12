import assert from "node:assert/strict";
import test from "node:test";

test("databetrix catalog probe returns games", async () => {
  const { databetrixSource, _resetDatabetrixCatalogForTests } = await import(
    "../sources/databetrix/index.js"
  );
  _resetDatabetrixCatalogForTests();

  const probe = await databetrixSource.probe!();
  assert.equal(probe.httpWorks, true);
  assert.ok(probe.notes.some((note) => /\d+ games/i.test(note)));
});

test("databetrix extracts only the direct game img field", async () => {
  const { databetrixSource } = await import(
    "../sources/databetrix/index.js"
  );
  const image =
    "https://u1jzkv11rsrc.mhjbneijrtonline.org/lobby/vs5luckytru.avif";
  const page = await databetrixSource.extractGame({
    title: "Lucky Tiger Gold",
    provider: "Pragmatic Play",
    slug: "game-id",
    url: "https://api.example.test/games#game-game-id",
    thumbnailUrl: image,
    raw: {
      id: "game-id",
      name: "Lucky Tiger Gold",
      img: image,
      img_custom: "https://example.test/custom-provider-art.png",
      img_vertical: "https://example.test/vertical-provider-art.png",
      provider: {
        name: "Pragmatic Play",
        img: "https://example.test/provider-logo.png",
      },
      _alternatives: [
        {
          name: "Lucky Tiger Gold",
          img: "https://images.example.test/lucky-tiger-gold.webp",
        },
      ],
    },
  });

  const images = await databetrixSource.extractImages(page);
  assert.deepEqual(images.map((candidate) => candidate.url), [
    image,
    "https://images.example.test/lucky-tiger-gold.webp",
  ]);
  assert.equal(databetrixSource.detectTypeOnce, true);
  assert.equal(databetrixSource.minImageWidth, 200);
  assert.equal(databetrixSource.minImageHeight, 130);
  assert.equal(databetrixSource.squareMaxRatio, 1.3);
  assert.equal(databetrixSource.allowSameNameDuplicateImages, true);
});
