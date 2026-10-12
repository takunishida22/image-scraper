import assert from "node:assert/strict";
import test from "node:test";

test("bcgame catalog probe returns Finland lobby", async () => {
  const { bcgameSource, _resetBcgameCatalogForTests } = await import(
    "../sources/bcgame/index.js"
  );
  _resetBcgameCatalogForTests();
  const probe = await bcgameSource.probe!();
  assert.equal(probe.httpWorks, true);
  assert.ok(probe.notes.some((n) => /Finland|\d+ games/i.test(n)));
});

test("bcgame extracts portrait tile URLs from catalog node", async () => {
  const { bcgameSource } = await import("../sources/bcgame/index.js");
  const page = await bcgameSource.extractGame({
    title: "Sweet Bonanza",
    provider: "Pragmatic Play",
    slug: "sweet-bonanza-by-pragmatic-play",
    url: "https://bc.game/game/sweet-bonanza-by-pragmatic-play",
    thumbnailUrl: "https://imgxcut.com/game/image/a2c12edb7c.png",
    raw: {
      fullName: "Sweet Bonanza",
      providerName: "Pragmatic Play",
      thumbnail: "https://imgxcut.com/game/image/bbbbbbbbbb.png",
      iconThreeFour: "https://imgxcut.com/game/image/aaaaaaaaaa.png",
      liveBgImage: {
        imageUrl: "https://imgxcut.com/slots/live/example.jpg?v=1",
      },
      gameIdentity: { gameUrl: "sweet-bonanza-by-pragmatic-play" },
    },
  });
  const images = await bcgameSource.extractImages(page);
  assert.equal(images[0]?.url, "https://imgxcut.com/game/image/aaaaaaaaaa.png");
  assert.ok(images.some((c) => c.url === "https://imgxcut.com/slots/live/example.jpg"));
  assert.ok(images.every((c) => /^https:\/\/imgxcut\.com\//.test(c.url)));
});
