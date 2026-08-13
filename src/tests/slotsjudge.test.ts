import assert from "node:assert/strict";
import test from "node:test";
import {
  slotsjudgeSlug,
  slotsjudgeSlugCandidates,
  unwrapSlotsjudgeImageUrl,
} from "../sources/slotsjudge/index.js";

test("slotsjudge slug candidates cover apostrophes and suffixes", () => {
  const gonzo = slotsjudgeSlugCandidates("Gonzo's Quest");
  assert.ok(gonzo.includes("gonzo-s-quest"));
  assert.ok(gonzo.includes("gonzos-quest"));

  const quentin = slotsjudgeSlugCandidates("San Quentin xWays");
  assert.ok(quentin.includes("san-quentin-xways"));
  assert.ok(quentin.includes("san-quentin"));

  assert.equal(slotsjudgeSlug("The Dog House"), "the-dog-house");
});

test("slotsjudge unwraps cached resized URLs to originals", () => {
  const cached =
    "https://slotsjudge.com/image/cache/data/slots/gates-of-olympus/gates-of-olympus-gameplay-slot-970x550sw.jpg";
  assert.equal(
    unwrapSlotsjudgeImageUrl(cached),
    "https://slotsjudge.com/image/data/slots/gates-of-olympus/gates-of-olympus-gameplay-slot.jpg",
  );
});
