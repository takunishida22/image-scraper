import assert from "node:assert/strict";
import test from "node:test";

test("regency casino catalog probe returns live and slots totals", async () => {
  const { regencycasinoSource, _resetRegencyCasinoCatalogForTests } =
    await import("../sources/regencycasino/index.js");
  _resetRegencyCasinoCatalogForTests();

  const probe = await regencycasinoSource.probe!();
  assert.equal(probe.httpWorks, true);
  assert.ok(probe.notes.some((note) => /^live: \d+ games/i.test(note)));
  assert.ok(probe.notes.some((note) => /^slots: \d+ games/i.test(note)));
});

test("regency casino builds square and rectangular image variants from item_title", async () => {
  const { regencycasinoSource } = await import(
    "../sources/regencycasino/index.js"
  );
  const page = await regencycasinoSource.extractGame({
    title: "Ghost Father",
    provider: "Tequity",
    slug: "ghostfather",
    url: "https://games-api.netdnstrace1.com/v2/categories/slots#game-1",
    raw: {
      application_name: "Ghost Father",
      item_title: "GhostFather",
      game_provider: "Tequity",
    },
  });

  const images = await regencycasinoSource.extractImages(page);
  assert.equal(images.length, 6);
  assert.equal(
    images[0]?.url,
    "https://aws-origin.image-tech-storage.com/gameRes/sq/500/GhostFather.jpg",
  );
  assert.equal(
    images[1]?.url,
    "https://aws-origin.image-tech-storage.com/gameRes/rect/500/GhostFather.jpg",
  );
  assert.deepEqual(regencycasinoSource.supportedTypes, [
    "square",
    "landscape",
  ]);
  assert.equal(regencycasinoSource.minImageWidth, 250);
  assert.equal(regencycasinoSource.minImageHeight, 120);
});
