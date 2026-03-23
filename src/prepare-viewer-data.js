import { preloadMultiFileDiff, preloadPatchDiff } from "@pierre/diffs/ssr";
import { critDiffOptions } from "./diff-options.js";

function splitPatch(patch) {
  const parts = [];
  const lines = patch.split("\n");
  let current = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      parts.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }

  if (current.length > 0 && current.some((line) => line.startsWith("diff --git "))) {
    parts.push(current.join("\n"));
  }

  return parts;
}

function extractPathFromPatch(patch) {
  const match = patch.match(/^diff --git a\/(.*?) b\/(.*)/m);
  if (match) return match[2];
  return "unknown";
}

function countChanges(patch) {
  let additions = 0;
  let deletions = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }

  return { additions, deletions };
}

async function prerenderPatch(patch) {
  const { prerenderedHTML } = await preloadPatchDiff({
    patch,
    options: critDiffOptions,
  });
  return prerenderedHTML;
}

async function prerenderUntracked(path, content) {
  const { prerenderedHTML } = await preloadMultiFileDiff({
    oldFile: { name: path, contents: "" },
    newFile: { name: path, contents: content },
    options: critDiffOptions,
  });
  return prerenderedHTML;
}

async function preparePatchEntries(patch, section, idPrefix = "") {
  const patches = patch.trim() ? splitPatch(patch) : [];

  return Promise.all(
    patches.map(async (filePatch) => {
      const path = extractPathFromPatch(filePatch);
      const { additions, deletions } = countChanges(filePatch);
      return {
        id: `${idPrefix}${path}`,
        name: path.split("/").pop() || path,
        path,
        section,
        additions,
        deletions,
        patch: filePatch,
        prerenderedHTML: await prerenderPatch(filePatch),
      };
    })
  );
}

async function prepareUntrackedEntries(untracked) {
  return Promise.all(
    untracked.map(async ({ path, content }) => ({
      id: `untracked:${path}`,
      name: path.split("/").pop() || path,
      path,
      section: "untracked",
      additions: content.split("\n").length,
      deletions: 0,
      content,
      prerenderedHTML: await prerenderUntracked(path, content),
    }))
  );
}

export async function prepareViewerData(rawData) {
  const [stagedFiles, unstagedFiles, untrackedFiles, commits] = await Promise.all([
    preparePatchEntries(rawData.staged || "", "staged", "staged:"),
    preparePatchEntries(rawData.unstaged || "", "unstaged", "unstaged:"),
    prepareUntrackedEntries(rawData.untracked || []),
    Promise.all(
      (rawData.commits || []).map(async (commit) => ({
        hash: commit.hash,
        message: commit.message,
        time: commit.time,
        files: await preparePatchEntries(commit.diff || "", "committed", `commit:${commit.hash}:`),
      }))
    ),
  ]);

  return {
    repoName: rawData.repoName,
    branch: rawData.branch,
    workingFiles: [...stagedFiles, ...unstagedFiles, ...untrackedFiles],
    commits,
  };
}
