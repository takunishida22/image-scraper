import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";

test("grosvenor builds a centered-layer landscape candidate", async () => {
  const { grosvenorcasinoSource } = await import(
    "../sources/grosvenorcasino/index.js"
  );
  const page = await grosvenorcasinoSource.extractGame({
    title: "3 Magic Pots",
    provider: null,
    slug: "/all-games/3-magic-pots/",
    url: "https://www.grosvenorcasinos.com/all-games/3-magic-pots/",
    thumbnailUrl: null,
    raw: {
      id: "game-id",
      gameName: "3 Magic Pots",
      backgroundLayer: {
        cropUrl:
          "https://media.example.test/background.jpg?width=250&format=webp",
      },
      gameLogoLayer: {
        cropUrl: "https://media.example.test/logo.png?width=250&format=webp",
      },
    },
  });

  const images = await grosvenorcasinoSource.extractImages(page);
  assert.equal(images.length, 1);
  assert.equal(
    new URL(images[0]!.url).searchParams.get("width"),
    "800",
  );
  assert.equal(
    new URL(images[0]!.overlayUrl!).searchParams.get("width"),
    "800",
  );
  assert.deepEqual(grosvenorcasinoSource.supportedTypes, ["landscape"]);
  assert.equal(grosvenorcasinoSource.allowSameNameDuplicateImages, true);
});

test("image composition centers the transparent logo", async () => {
  const { composeCenteredOverlay } = await import("../images/downloader.js");
  const background = await sharp({
    create: {
      width: 100,
      height: 60,
      channels: 3,
      background: { r: 220, g: 20, b: 20 },
    },
  })
    .png()
    .toBuffer();
  const logo = await sharp({
    create: {
      width: 40,
      height: 20,
      channels: 4,
      background: { r: 10, g: 30, b: 230, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const output = await composeCenteredOverlay(background, logo);
  const { data, info } = await sharp(output)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const offset = (y * info.width + x) * info.channels;
    return [...data.subarray(offset, offset + 3)];
  };

  assert.deepEqual(pixel(0, 0), [220, 20, 20]);
  assert.deepEqual(pixel(50, 30), [10, 30, 230]);
});
