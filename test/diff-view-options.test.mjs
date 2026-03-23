import test from "node:test";
import assert from "node:assert/strict";
import { buildDiffViewOptions } from "../src/diff-view-options.js";

test("buildDiffViewOptions always uses built-in gutter utility callback for crit", () => {
  const onGutterUtilityClick = () => {};

  const opts = buildDiffViewOptions({
    splitView: false,
    onGutterUtilityClick,
  });

  assert.equal(opts.diffStyle, "unified");
  assert.equal(opts.enableGutterUtility, true);
  assert.equal(opts.onGutterUtilityClick, onGutterUtilityClick);

  const splitOpts = buildDiffViewOptions({
    splitView: true,
    onGutterUtilityClick,
  });

  assert.equal(splitOpts.diffStyle, "split");
  assert.equal(splitOpts.enableGutterUtility, true);
  assert.equal(splitOpts.onGutterUtilityClick, onGutterUtilityClick);
});
