import assert from "node:assert/strict";
import test from "node:test";

test("betgaliano catalog probe returns games", async () => {
  const { betgalianoSource, _resetBetgalianoCatalogForTests } = await import(
    "../sources/betgaliano/index.js"
  );
  _resetBetgalianoCatalogForTests();
  const probe = await betgalianoSource.probe!();
  assert.equal(probe.httpWorks, true);
  assert.ok(probe.notes.some((note) => /\d+ games/i.test(note)));
});

test("betgaliano extracts only the thumbnail and ignores backgrounds", async () => {
  const { betgalianoSource } = await import(
    "../sources/betgaliano/index.js"
  );
  const thumbnail =
    "https://cdnlatam.modulesports.net/casino/games/hub/1/thumbnail/thumb.jpg";
  const background =
    "https://cdnlatam.modulesports.net/casino/games/hub/1/background/background.jpg";
  const page = await betgalianoSource.extractGame({
    title: "Example Game",
    provider: "Example Vendor",
    slug: "example-game",
    url: "https://modulesports.com:55000/api/MyCasino/SearchGames?siteid=7#game-1",
    thumbnailUrl: thumbnail,
    raw: {
      Id: 1,
      Name: "Example Game",
      VendorName: "Example Vendor",
      ImageUrl: thumbnail,
      BackImageUrl: background,
      ImageUrl1: thumbnail,
      ImageUrl2: background,
    },
  });

  const images = await betgalianoSource.extractImages(page);
  assert.deepEqual(images.map((candidate) => candidate.url), [thumbnail]);
  assert.equal(images[0]?.widthHint, 490);
});
