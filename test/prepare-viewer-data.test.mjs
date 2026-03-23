import test from "node:test";
import assert from "node:assert/strict";
import { prepareViewerData } from "../src/prepare-viewer-data.js";

test("prepareViewerData splits patches into per-file entries and prerenders each diff", async () => {
  const patchOne = `diff --git a/src/foo.js b/src/foo.js
index 1111111..2222222 100644
--- a/src/foo.js
+++ b/src/foo.js
@@ -1 +1 @@
-console.log("old");
+console.log("new");
`;

  const patchTwo = `diff --git a/src/bar.js b/src/bar.js
index 3333333..4444444 100644
--- a/src/bar.js
+++ b/src/bar.js
@@ -1 +1,2 @@
 export const value = 1;
+export const next = 2;
`;

  const data = await prepareViewerData({
    staged: "",
    unstaged: `${patchOne}\n${patchTwo}`,
    untracked: [{ path: "src/new.js", content: "export const created = true;\n" }],
    repoName: "demo",
    branch: "main",
    commits: [
      {
        hash: "abcdef0",
        message: "Example commit",
        time: "1m",
        diff: patchOne,
      },
    ],
  });

  assert.equal(data.repoName, "demo");
  assert.equal(data.branch, "main");
  assert.equal(data.workingFiles.length, 3);

  assert.deepEqual(
    data.workingFiles.map((file) => ({
      path: file.path,
      section: file.section,
      additions: file.additions,
      deletions: file.deletions,
    })),
    [
      { path: "src/foo.js", section: "unstaged", additions: 1, deletions: 1 },
      { path: "src/bar.js", section: "unstaged", additions: 1, deletions: 0 },
      { path: "src/new.js", section: "untracked", additions: 2, deletions: 0 },
    ]
  );

  for (const file of data.workingFiles) {
    assert.equal(typeof file.prerenderedHTML, "string");
    assert.match(file.prerenderedHTML, /data-dehydrated/);
    assert.match(file.prerenderedHTML, new RegExp(file.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.equal(data.commits.length, 1);
  assert.equal(data.commits[0].files.length, 1);
  assert.equal(data.commits[0].files[0].path, "src/foo.js");
  assert.match(data.commits[0].files[0].prerenderedHTML, /data-dehydrated/);
});
