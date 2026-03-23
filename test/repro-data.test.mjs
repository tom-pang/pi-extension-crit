import test from "node:test";
import assert from "node:assert/strict";
import { buildReproData } from "../src/repro-data.js";

test("buildReproData creates a long prerendered diff payload", async () => {
  const data = await buildReproData();

  assert.equal(data.mode, "repro");
  assert.equal(data.file.path, "repro/long-example.js");
  assert.equal(typeof data.file.prerenderedHTML, "string");
  assert.match(data.file.prerenderedHTML, /data-dehydrated/);

  const oldLines = data.file.oldContent.trimEnd().split("\n");
  const newLines = data.file.newContent.trimEnd().split("\n");

  assert.ok(oldLines.length >= 800);
  assert.equal(oldLines.length, newLines.length);
  assert.notEqual(data.file.oldContent, data.file.newContent);
});
