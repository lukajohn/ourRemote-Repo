import assert from "node:assert/strict";
import {
  MIN_ITEM_REPEAT_GAP_MS,
  MIN_SLOT_INTERVAL_MS,
  initialState,
  itemRepeatEligibility,
  slotEligibility,
  normalizePublicImageUrl,
  normalizeState,
  selectCandidate,
} from "../src/logic.ts";

function item(id, sequence, lastPostedAt = null) {
  return {
    id,
    sequence,
    text: `post ${id}`,
    fingerprint: `hash-${id}`,
    createdAt: 100 + sequence,
    lastPostedAt,
    publishedCount: lastPostedAt ? 1 : 0,
  };
}

function test(name, fn) {
  fn();
  console.log(`PASS ${name}`);
}

test("new queue starts paused and empty", () => {
  const state = initialState();
  assert.equal(state.enabled, false);
  assert.equal(state.items.length, 0);
  assert.equal(state.cycleNumber, 1);
});

test("FIFO selector returns the oldest unseen item", () => {
  const state = initialState();
  state.items = [item("old", 1), item("new", 2)];
  state.cycleSeenIds = ["old"];
  assert.equal(selectCandidate(state).candidate?.id, "new");
});

test("an appended item joins the end of the current cycle", () => {
  const state = initialState();
  state.items = [item("a", 1), item("b", 2), item("c", 3)];
  state.cycleSeenIds = ["a"];
  assert.equal(selectCandidate(state).candidate?.id, "b");
});

test("cycle resets only after all currently queued items were seen", () => {
  const state = initialState();
  state.items = [item("a", 1), item("b", 2)];
  state.cycleSeenIds = ["a", "b"];
  const selection = selectCandidate(state);
  assert.equal(selection.didResetCycle, true);
  assert.equal(selection.cycleNumber, 2);
  assert.equal(selection.candidate?.id, "a");
});

test("FIFO order is preserved when a newly added item has not been seen", () => {
  const state = initialState();
  state.items = [item("a", 1), item("b", 2), item("c", 3)];
  state.cycleSeenIds = ["a", "b"];
  assert.equal(selectCandidate(state).candidate?.id, "c");
});

test("normalization repairs missing/corrupt top-level state", () => {
  const state = normalizeState({ enabled: true, items: [item("a", 2)], nextSequence: 1 });
  assert.equal(state.enabled, true);
  assert.equal(state.nextSequence, 3);
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.cycleSeenIds, []);
});

test("image URLs must use HTTPS and a public hostname", () => {
  assert.equal(normalizePublicImageUrl("https://cdn.example.com/photo.jpg"), "https://cdn.example.com/photo.jpg");
  assert.throws(() => normalizePublicImageUrl("http://cdn.example.com/photo.jpg"), /HTTPS/);
  assert.throws(() => normalizePublicImageUrl("https://localhost/photo.jpg"), /publicly accessible/);
  assert.throws(() => normalizePublicImageUrl("https://192.168.1.10/photo.jpg"), /IP address/);
});

test("slot cooldown blocks an immediate second run and opens after three hours", () => {
  assert.equal(MIN_SLOT_INTERVAL_MS, 3 * 60 * 60 * 1000);
  assert.equal(slotEligibility(1_000, 1_000 + MIN_SLOT_INTERVAL_MS - 1).eligible, false);
  assert.equal(slotEligibility(1_000, 1_000 + MIN_SLOT_INTERVAL_MS).eligible, true);
});

test("an item cannot repeat inside 24 hours but becomes eligible at the boundary", () => {
  assert.equal(MIN_ITEM_REPEAT_GAP_MS, 24 * 60 * 60 * 1000);
  const posted = item("old", 1, 5_000);
  assert.equal(itemRepeatEligibility(posted, 5_000 + MIN_ITEM_REPEAT_GAP_MS - 1).eligible, false);
  assert.equal(itemRepeatEligibility(posted, 5_000 + MIN_ITEM_REPEAT_GAP_MS).eligible, true);
  assert.equal(itemRepeatEligibility(item("new", 2, null), 5_001).eligible, true);
});

console.log("All logic tests passed.");
