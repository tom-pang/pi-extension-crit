import test from "node:test";
import assert from "node:assert/strict";
import { prepareViewerData } from "../src/prepare-viewer-data.js";

test("prepareViewerData uses old/new file contents and prerenders each diff", async () => {
  const data = await prepareViewerData({
    files: [
      {
        path: "src/foo.js",
        oldContent: 'console.log("old");\n',
        newContent: 'console.log("new");\n',
      },
      {
        path: "src/bar.js",
        oldContent: "export const value = 1;\n",
        newContent: "export const value = 1;\nexport const next = 2;\n",
      },
    ],
    untracked: [{ path: "src/new.js", content: "export const created = true;\n" }],
    repoName: "demo",
    branch: "main",
    commits: [
      {
        hash: "abcdef0",
        message: "Example commit",
        time: "1m",
        files: [
          {
            path: "src/foo.js",
            oldContent: 'console.log("old");\n',
            newContent: 'console.log("new");\n',
          },
        ],
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

  // All files should have oldContent and newContent
  for (const file of data.workingFiles) {
    assert.equal(typeof file.oldContent, "string");
    assert.equal(typeof file.newContent, "string");
  }

  // All files should have prerendered HTML
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
