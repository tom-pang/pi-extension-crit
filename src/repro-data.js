import { preloadMultiFileDiff } from "@pierre/diffs/ssr";
import { critDiffOptions } from "./diff-options.js";

function buildLongContents(lineCount = 1000) {
  const oldLines = [];
  const newLines = [];

  oldLines.push("export function longExample() {");
  newLines.push("export function longExample() {");

  for (let i = 1; i <= lineCount; i++) {
    oldLines.push(`  const value${i} = ${i};`);
    newLines.push(`  const value${i} = ${i} * 2;`);
  }

  oldLines.push("  return [");
  newLines.push("  return [");

  for (let i = 1; i <= lineCount; i++) {
    oldLines.push(`    value${i},`);
    newLines.push(`    value${i},`);
  }

  oldLines.push("  ].join(',');");
  newLines.push("  ].join(',');");
  oldLines.push("}");
  newLines.push("}");

  return {
    oldContent: `${oldLines.join("\n")}\n`,
    newContent: `${newLines.join("\n")}\n`,
  };
}

export async function buildReproData() {
  const path = "repro/long-example.js";
  const { oldContent, newContent } = buildLongContents();
  const { prerenderedHTML } = await preloadMultiFileDiff({
    oldFile: { name: path, contents: oldContent },
    newFile: { name: path, contents: newContent },
    options: critDiffOptions,
  });

  return {
    mode: "repro",
    title: "Crit Repro",
    file: {
      path,
      oldContent,
      newContent,
      prerenderedHTML,
    },
  };
}
