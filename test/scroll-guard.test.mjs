import test from "node:test";
import assert from "node:assert/strict";
import { createScrollGuard } from "../src/scroll-guard.js";

test("does not restore while the user is still actively scrolling", () => {
  const guard = createScrollGuard({ idleMs: 120, minJump: 80 });

  guard.recordUserScroll(200, 100);

  assert.equal(guard.getRestoreTarget(150, 140), null);
});

test("does not restore after idle for a small upward drift", () => {
  const guard = createScrollGuard({ idleMs: 120, minJump: 80 });

  guard.recordUserScroll(400, 100);

  assert.equal(guard.getRestoreTarget(360, 260), null);
});

test("restores the last stable scroll position after an idle large upward jump", () => {
  const guard = createScrollGuard({ idleMs: 120, minJump: 80 });

  guard.recordUserScroll(400, 100);

  assert.equal(guard.getRestoreTarget(240, 260), 400);
});

test("does not treat programmatic restore scroll events as fresh user input", () => {
  const guard = createScrollGuard({ idleMs: 120, minJump: 80 });

  guard.recordUserScroll(180, 100);
  assert.equal(guard.getRestoreTarget(0, 260), 180);

  guard.recordProgrammaticScroll(180);

  assert.equal(guard.getRestoreTarget(0, 300), 180);
});
