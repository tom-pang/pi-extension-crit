import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const baseDir = dirname(fileURLToPath(import.meta.url));
const viewerPath = join(baseDir, "..", "dist", "viewer.js");
const glimpsePath = join(baseDir, "..", "node_modules", "glimpseui", "src", "glimpse.mjs");

let win: any = null;

function buildHTML(
  viewerJS: string,
  data: {
    staged: string;
    unstaged: string;
    untracked: { path: string; content: string }[];
    repoName: string;
  }
): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0a0a0a;
    color: #fbfbfb;
    font-family: system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }
  #app {
    max-width: 100%;
    padding: 16px 20px 40px;
  }

  /* Repo header */
  .repo-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .repo-name {
    font-size: 16px;
    font-weight: 600;
    color: #fbfbfb;
  }
  .repo-label {
    font-size: 12px;
    color: rgba(255,255,255,0.4);
    font-weight: 400;
  }

  /* Summary bar */
  .summary-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: rgba(255,255,255,0.04);
    border-radius: 8px;
    margin-bottom: 20px;
    border: 1px solid rgba(255,255,255,0.06);
  }
  .summary-total {
    font-size: 13px;
    font-weight: 500;
    color: rgba(255,255,255,0.8);
  }
  .summary-right {
    display: flex;
    gap: 12px;
  }
  .summary-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: rgba(255,255,255,0.6);
  }
  .chip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* Sections */
  .diff-section {
    margin-bottom: 20px;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(255,255,255,0.03);
    border-radius: 6px;
    margin-bottom: 8px;
    border: 1px solid rgba(255,255,255,0.05);
    user-select: none;
    cursor: pointer;
  }
  .section-header:hover {
    background: rgba(255,255,255,0.06);
  }
  .section-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .section-label {
    font-size: 13px;
    font-weight: 600;
    color: rgba(255,255,255,0.9);
  }
  .section-count {
    font-size: 12px;
    color: rgba(255,255,255,0.4);
    margin-left: auto;
  }
  .section-toggle {
    font-size: 10px;
    color: rgba(255,255,255,0.3);
    width: 14px;
    text-align: center;
  }

  /* File diffs */
  .file-diff-wrapper {
    margin-bottom: 4px;
    border-radius: 6px;
    overflow: hidden;
  }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: rgba(255,255,255,0.3);
    font-size: 14px;
  }

  /* Pierre dark theme overrides */
  :root {
    --diffs-dark: #fbfbfb;
    --diffs-dark-bg: #0a0a0a;
    --diffs-dark-addition-color: #00cab1;
    --diffs-dark-deletion-color: #ff2e3f;
    --diffs-dark-modified-color: #009fff;
  }
</style>
</head>
<body>
<div id="loading" style="padding:40px;text-align:center;color:rgba(255,255,255,0.4);font-size:13px;">Loading diffs…</div>
<div id="app"></div>
<script>
  window.__DIFF_DATA__ = ${JSON.stringify(data).replace(/<\//g, "<\\/")};
</script>
<script>${viewerJS.replace(/<\/script/gi, "<\\/script")}</script>
</body>
</html>`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diffs", {
    description: "Show git diffs in a native window",
    handler: async (_args, ctx) => {
      // Check for viewer bundle
      if (!existsSync(viewerPath)) {
        ctx.ui.notify(
          "Viewer not built. Run: cd ~/Projects/pi-extension-diffs && npm run build",
          "error"
        );
        return;
      }

      // Dynamically import glimpse
      let openFn: any;
      try {
        const glimpse = await import(glimpsePath);
        openFn = glimpse.open;
      } catch (e: any) {
        ctx.ui.notify(`Failed to load Glimpse: ${e.message}`, "error");
        return;
      }

      // Check git repo
      const gitCheck = await pi.exec("git", [
        "rev-parse",
        "--is-inside-work-tree",
      ]);
      if (gitCheck.code !== 0) {
        ctx.ui.notify("Not in a git repository", "error");
        return;
      }

      // Gather diffs
      const [stagedResult, unstagedResult, untrackedResult] =
        await Promise.all([
          pi.exec("git", ["diff", "--cached"]),
          pi.exec("git", ["diff"]),
          pi.exec("git", ["ls-files", "--others", "--exclude-standard"]),
        ]);

      const staged = stagedResult.stdout || "";
      const unstaged = unstagedResult.stdout || "";
      const untrackedPaths = untrackedResult.stdout
        .split("\n")
        .filter((p) => p.trim());

      // Check if there are any changes
      if (!staged && !unstaged && untrackedPaths.length === 0) {
        ctx.ui.notify("No changes", "info");
        return;
      }

      // Read untracked file contents
      const untracked: { path: string; content: string }[] = [];
      for (const filePath of untrackedPaths) {
        try {
          const result = await pi.exec("cat", [filePath]);
          if (result.code === 0) {
            untracked.push({ path: filePath, content: result.stdout });
          }
        } catch {
          // Skip files we can't read
        }
      }

      // Get repo name
      const repoName = basename(ctx.cwd);

      // Build HTML with viewer inlined
      const viewerJS = readFileSync(viewerPath, "utf-8");
      const html = buildHTML(viewerJS, {
        staged,
        unstaged,
        untracked,
        repoName,
      });

      // Open or update window
      if (win) {
        try {
          win.setHTML(html);
          return;
        } catch {
          win = null;
        }
      }

      win = openFn(html, {
        width: 960,
        height: 720,
        title: `Diffs — ${repoName}`,
      });
      win.on("closed", () => {
        win = null;
      });
    },
  });
}
