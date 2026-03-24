import { preloadMultiFileDiff } from "@pierre/diffs/ssr";
import { parseDiffFromFile } from "@pierre/diffs";
import { critDiffOptions } from "./diff-options.js";

function countChangesFromDiff(oldContent, newContent, path) {
  const fileDiff = parseDiffFromFile(
    { name: path, contents: oldContent },
    { name: path, contents: newContent }
  );
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

async function prerenderFileDiff(path, oldContent, newContent) {
  const { prerenderedHTML } = await preloadMultiFileDiff({
    oldFile: { name: path, contents: oldContent },
    newFile: { name: path, contents: newContent },
    options: critDiffOptions,
  });
  return prerenderedHTML;
}

async function prepareFileEntries(files, section, idPrefix = "") {
  return Promise.all(
    files.map(async ({ path, oldContent, newContent }) => {
      const { additions, deletions } = countChangesFromDiff(oldContent, newContent, path);
      return {
        id: `${idPrefix}${path}`,
        name: path.split("/").pop() || path,
        path,
        section,
        additions,
        deletions,
        oldContent,
        newContent,
        prerenderedHTML: await prerenderFileDiff(path, oldContent, newContent),
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
      oldContent: "",
      newContent: content,
      prerenderedHTML: await prerenderFileDiff(path, "", content),
    }))
  );
}

export async function prepareViewerData(rawData) {
  const [changedFiles, untrackedFiles, commits] = await Promise.all([
    prepareFileEntries(rawData.files || [], "unstaged", "unstaged:"),
    prepareUntrackedEntries(rawData.untracked || []),
    Promise.all(
      (rawData.commits || []).map(async (commit) => ({
        hash: commit.hash,
        message: commit.message,
        time: commit.time,
        files: await prepareFileEntries(commit.files || [], "committed", `commit:${commit.hash}:`),
      }))
    ),
  ]);

  return {
    repoName: rawData.repoName,
    branch: rawData.branch,
    workingFiles: [...changedFiles, ...untrackedFiles],
    commits,
  };
}
