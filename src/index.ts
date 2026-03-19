import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dirname, join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const baseDir = dirname(fileURLToPath(import.meta.url));
const distDir = join(baseDir, "..", "dist");
const viewerPath = join(distDir, "viewer.js");
const shellPath = join(distDir, "shell.html");

// Resolve glimpseui from node_modules — dynamic import to avoid jiti issues
const glimpsePath = join(baseDir, "..", "node_modules", "glimpseui", "src", "glimpse.mjs");

let win: any = null;
let openFn: any = null;
let ready = false;
let readyResolve: (() => void) | null = null;

// Comment accumulation for the active /crit session
interface CritComment {
  id: string;
  filePath: string;
  lineNumber: number;
  side: "additions" | "deletions";
  text: string;
}

let activeComments: Map<string, CritComment> = new Map();
let closeResolve: (() => void) | null = null;

/**
 * Write shell.html to dist/ — a tiny HTML file with a loading spinner
 * that loads viewer.js via <script> after the first paint.
 * WKWebView loads both files from disk, no stdin overhead.
 */
function writeShellHTML() {
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; overflow: hidden; }
  body {
    background: #282a36;
    color: #f8f8f2;
    font-family: system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  #app { height: 100%; display: none; }

  /* ─── Loading ─── */
  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 20px;
  }
  .loading-spinner {
    width: 24px;
    height: 24px;
    border: 2px solid rgba(255,255,255,0.08);
    border-top-color: rgba(255,255,255,0.4);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .loading-text {
    font-size: 12px;
    color: rgba(255,255,255,0.2);
    letter-spacing: 0.3px;
  }

  /* ─── Layout ─── */
  .layout { display: flex; height: 100%; }

  /* ─── Sidebar ─── */
  .sidebar {
    width: 260px; min-width: 260px;
    background: #21222c;
    border-right: 1px solid rgba(255,255,255,0.08);
    display: flex; flex-direction: column; overflow: hidden;
  }
  .sidebar-header {
    padding: 14px 16px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    display: flex; align-items: baseline; gap: 8px; flex-shrink: 0;
  }
  .sidebar-repo { font-size: 13px; font-weight: 600; color: rgba(255,255,255,0.9); }
  .sidebar-count { font-size: 11px; color: rgba(255,255,255,0.35); margin-left: auto; }
  .sidebar-files { flex: 1; overflow-y: auto; padding: 8px 0; }
  .sidebar-files::-webkit-scrollbar { width: 5px; }
  .sidebar-files::-webkit-scrollbar-track { background: transparent; }
  .sidebar-files::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }

  .sidebar-section { margin-bottom: 4px; }
  .sidebar-section-header {
    display: flex; align-items: center; gap: 7px; padding: 6px 16px; user-select: none;
  }
  .sidebar-section-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .sidebar-section-label {
    font-size: 11px; font-weight: 600; color: rgba(255,255,255,0.45);
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .sidebar-section-count {
    font-size: 10px; color: rgba(255,255,255,0.25); margin-left: auto;
    background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 8px;
  }

  .sidebar-file {
    padding: 6px 16px 6px 14px; border-left: 2px solid transparent;
    cursor: pointer; transition: background 0.1s;
  }
  .sidebar-file:hover { background: rgba(255,255,255,0.04); }
  .sidebar-file.active { background: rgba(255,255,255,0.07); }
  .sidebar-file-name {
    font-size: 12px; font-weight: 500; color: rgba(255,255,255,0.85);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    display: flex; align-items: center; gap: 6px;
  }
  .sidebar-file-tab-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; }
  .sidebar-file-path {
    font-size: 10px; color: rgba(255,255,255,0.25);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-top: 1px; min-height: 13px;
  }
  .sidebar-file-stats { display: flex; gap: 6px; margin-top: 2px; }
  .stat-add { font-size: 10px; color: #50fa7b; font-weight: 500; font-variant-numeric: tabular-nums; }
  .stat-del { font-size: 10px; color: #ff5555; font-weight: 500; font-variant-numeric: tabular-nums; }

  /* ─── Commit list ─── */
  .commit-list {
    border-bottom: 1px solid rgba(255,255,255,0.08);
    padding: 8px 0;
    flex-shrink: 0;
  }
  .commit-entry {
    padding: 6px 16px 6px 14px;
    border-left: 2px solid transparent;
    cursor: pointer;
    transition: background 0.1s;
  }
  .commit-entry:hover { background: rgba(255,255,255,0.04); }
  .commit-entry.active { background: rgba(255,255,255,0.07); }
  .commit-entry-working .commit-entry-label {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
    font-weight: 500;
    color: rgba(255,255,255,0.85);
  }
  .commit-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .commit-count {
    font-size: 10px;
    color: rgba(255,255,255,0.25);
    margin-left: auto;
    background: rgba(255,255,255,0.06);
    padding: 1px 6px;
    border-radius: 8px;
  }
  .commit-info {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .commit-hash {
    font-family: ui-monospace, 'SF Mono', monospace;
    font-size: 11px;
    color: rgba(255,255,255,0.35);
    flex-shrink: 0;
  }
  .commit-message {
    font-size: 12px;
    color: rgba(255,255,255,0.7);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }
  .commit-time {
    font-size: 10px;
    color: rgba(255,255,255,0.2);
    flex-shrink: 0;
    white-space: nowrap;
  }
  .sidebar-branch {
    font-size: 11px;
    color: rgba(255,255,255,0.3);
    background: rgba(255,255,255,0.06);
    padding: 1px 7px;
    border-radius: 8px;
    font-family: ui-monospace, 'SF Mono', monospace;
  }

  /* ─── Main panel ─── */
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }

  .tab-bar {
    display: flex; background: #21222c;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    overflow-x: auto; flex-shrink: 0; -webkit-app-region: no-drag;
  }
  .tab-bar::-webkit-scrollbar { height: 0; }
  .tab {
    display: flex; align-items: center; gap: 6px; padding: 8px 14px;
    font-size: 12px; color: rgba(255,255,255,0.5); cursor: pointer;
    white-space: nowrap; border-right: 1px solid rgba(255,255,255,0.04);
    flex-shrink: 0; transition: background 0.1s;
  }
  .tab:hover { background: rgba(255,255,255,0.04); color: rgba(255,255,255,0.7); }
  .tab-active { background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.9); }
  .tab-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .tab-name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
  .tab-close {
    font-size: 14px; line-height: 1; color: rgba(255,255,255,0.25);
    cursor: pointer; padding: 0 2px; border-radius: 3px;
  }
  .tab-close:hover { color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.1); }
  .tab-comment-count {
    font-size: 10px;
    color: rgba(255,255,255,0.5);
    background: rgba(255,255,255,0.1);
    padding: 1px 5px;
    border-radius: 6px;
    min-width: 16px;
    text-align: center;
  }

  .main-content { flex: 1; overflow: hidden; position: relative; }
  .tab-panel { height: 100%; overflow-y: auto; overflow-x: hidden; }
  .tab-panel::-webkit-scrollbar { width: 8px; }
  .tab-panel::-webkit-scrollbar-track { background: transparent; }
  .tab-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
  .diff-content { padding: 0; }

  .empty-state {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: rgba(255,255,255,0.25); font-size: 13px;
  }

  :root {
    --diffs-dark: #f8f8f2;
    --diffs-dark-bg: #282a36;
    --diffs-dark-addition-color: #50fa7b;
    --diffs-dark-deletion-color: #ff5555;
    --diffs-dark-modified-color: #8be9fd;
  }

  /* ─── Comment UI ─── */
  .gutter-plus-btn {
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 4px;
    background: #bd93f9;
    color: white;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.85;
    transition: opacity 0.1s, transform 0.1s;
  }
  .gutter-plus-btn:hover {
    opacity: 1;
    transform: scale(1.1);
  }

  .comment-form {
    background: #44475a;
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 8px;
    padding: 12px;
    margin: 8px 16px;
  }
  .comment-textarea {
    width: 100%;
    min-height: 72px;
    background: #343746;
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    color: #f8f8f2;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 13px;
    padding: 10px 12px;
    resize: vertical;
    outline: none;
    transition: border-color 0.15s;
  }
  .comment-textarea:focus {
    border-color: rgba(59, 130, 246, 0.5);
  }
  .comment-textarea::placeholder {
    color: rgba(255,255,255,0.25);
  }
  .comment-form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }
  .comment-btn {
    padding: 6px 14px;
    border: none;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
  }
  .comment-btn-cancel {
    background: rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.6);
  }
  .comment-btn-cancel:hover {
    background: rgba(255,255,255,0.12);
  }
  .comment-btn-submit {
    background: #bd93f9;
    color: white;
  }
  .comment-btn-submit:hover {
    background: #a67bf5;
  }
  .comment-btn-submit:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .comment-bubble {
    background: #44475a;
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 8px;
    padding: 10px 14px;
    margin: 6px 16px;
  }
  .comment-bubble-text {
    font-size: 13px;
    color: rgba(255,255,255,0.85);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .comment-bubble-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .comment-bubble-line {
    font-size: 10px;
    color: rgba(255,255,255,0.3);
    font-family: ui-monospace, 'SF Mono', monospace;
  }
  .comment-bubble-btn {
    font-size: 10px;
    color: rgba(255,255,255,0.35);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 3px;
  }
  .comment-bubble-btn:hover {
    color: rgba(255,255,255,0.7);
    background: rgba(255,255,255,0.08);
  }
  .comment-bubble-btn-delete:hover {
    color: #ff4757;
  }

  .comment-reply-btn {
    font-size: 11px;
    color: rgba(59, 130, 246, 0.7);
    background: none;
    border: none;
    cursor: pointer;
    padding: 4px 8px;
    margin: 4px 16px;
    border-radius: 4px;
  }
  .comment-reply-btn:hover {
    color: #bd93f9;
    background: rgba(59, 130, 246, 0.1);
  }

  .annotation-container {
    width: 100%;
  }

  /* ─── Comment Summary (sidebar bottom) ─── */
  .comment-summary {
    border-top: 1px solid rgba(255,255,255,0.08);
    padding: 8px 0;
    flex-shrink: 0;
    max-height: 200px;
    overflow-y: auto;
  }
  .comment-summary::-webkit-scrollbar { width: 5px; }
  .comment-summary::-webkit-scrollbar-track { background: transparent; }
  .comment-summary::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
  .comment-summary-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 16px 6px;
  }
  .comment-summary-icon { font-size: 12px; }
  .comment-summary-count {
    font-size: 11px;
    font-weight: 600;
    color: rgba(255,255,255,0.5);
  }
  .comment-summary-list { padding: 0 8px; }
  .comment-summary-file { margin-bottom: 4px; }
  .comment-summary-file-name {
    font-size: 10px;
    font-weight: 600;
    color: rgba(255,255,255,0.4);
    padding: 2px 8px;
    font-family: ui-monospace, 'SF Mono', monospace;
  }
  .comment-summary-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 2px 8px;
  }
  .comment-summary-line {
    font-size: 10px;
    color: rgba(59, 130, 246, 0.6);
    font-family: ui-monospace, 'SF Mono', monospace;
    flex-shrink: 0;
  }
  .comment-summary-text {
    font-size: 11px;
    color: rgba(255,255,255,0.5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .stat-comments {
    font-size: 10px;
    color: rgba(59, 130, 246, 0.7);
    font-weight: 500;
  }
</style>
</head>
<body>
<div id="loading" class="loading">
  <div class="loading-spinner"></div>
  <div class="loading-text">Loading viewer…</div>
</div>
<div id="app"></div>
<script>
// Small delay lets the spinner paint before the heavy JS parse starts.
// Using setTimeout instead of rAF because rAF doesn't fire in hidden windows (prewarm).
setTimeout(function() {
  var s = document.createElement('script');
  s.src = 'viewer.js';
  document.body.appendChild(s);
}, 10);
</script>
</body>
</html>`;
  writeFileSync(shellPath, html);
}

/** Wire up window events. */
function wireWindow(w: any) {
  w.loadFile(shellPath);

  w.on("message", (data: any) => {
    if (data?.type === "viewer-ready") {
      ready = true;
      if (readyResolve) {
        readyResolve();
        readyResolve = null;
      }
    }

    // Comment messages from the viewer
    if (data?.type === "comment-added" && data.comment) {
      const c = data.comment as CritComment;
      activeComments.set(c.id, c);
    }
    if (data?.type === "comment-deleted" && data.commentId) {
      activeComments.delete(data.commentId);
    }
    if (data?.type === "comment-edited" && data.commentId && data.text) {
      const existing = activeComments.get(data.commentId);
      if (existing) {
        activeComments.set(data.commentId, { ...existing, text: data.text });
      }
    }
  });

  w.on("closed", () => {
    win = null;
    ready = false;
    readyResolve = null;

    // Resolve the close promise so /crit can finish
    if (closeResolve) {
      closeResolve();
      closeResolve = null;
    }

    setTimeout(() => prewarm(), 100);
  });
}

/** Prewarm: hidden window with viewer.js already parsed. */
function prewarm() {
  if (!openFn || !existsSync(shellPath) || win) return;

  win = openFn(null, {
    width: 1120,
    height: 760,
    title: "Crit",
    hidden: true,
  });
  ready = false;
  wireWindow(win);
}

/** Wait for viewer.js to finish loading (with timeout). */
function waitForReady(timeoutMs = 15000): Promise<void> {
  if (ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readyResolve = null;
      reject(new Error("Timed out waiting for viewer to load"));
    }, timeoutMs);
    readyResolve = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

/** Wait for the window to close. */
function waitForClose(): Promise<void> {
  if (!win) return Promise.resolve();
  return new Promise((resolve) => {
    closeResolve = resolve;
  });
}

/** Write accumulated comments to ~/.pi/crit/<repoName>/<timestamp>.md */
function writeCommentFile(repoName: string, branch: string): string | null {
  if (activeComments.size === 0) return null;

  const comments = Array.from(activeComments.values());

  // Group by file
  const grouped = new Map<string, CritComment[]>();
  for (const c of comments) {
    const arr = grouped.get(c.filePath) || [];
    arr.push(c);
    grouped.set(c.filePath, arr);
  }

  // Sort comments within each file by line number
  for (const arr of grouped.values()) {
    arr.sort((a, b) => a.lineNumber - b.lineNumber);
  }

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);

  let md = `# Crit — ${repoName}\n\n`;
  md += `Branch: ${branch || "unknown"}\n`;
  md += `Date: ${now.toISOString()}\n\n`;

  for (const [filePath, fileComments] of grouped) {
    md += `## ${filePath}\n\n`;
    for (const c of fileComments) {
      const side = c.side === "additions" ? "new" : "old";
      md += `### L${c.lineNumber} (${side})\n\n`;
      md += `${c.text}\n\n`;
    }
  }

  const dir = join(homedir(), ".pi", "crit", repoName);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${timestamp}.md`);
  writeFileSync(filePath, md);
  return filePath;
}

export default function (pi: ExtensionAPI) {
  // Write shell.html, load glimpse, then prewarm
  (async () => {
    try {
      if (!existsSync(viewerPath)) return;
      writeShellHTML();
      const glimpse = await import(glimpsePath);
      openFn = glimpse.open;
      prewarm();
    } catch {
      // Silently fail — prewarm is best-effort
    }
  })();

  pi.registerCommand("crit", {
    description: "Show jj changes in a native window — add inline review comments, saved on close. Pass a file path or jj revset.",
    handler: async (_args, ctx) => {
      const arg = _args.trim() || null;
      if (!existsSync(viewerPath)) {
        ctx.ui.notify(
          "Viewer not built. Run 'npm run build' in the pi-extension-crit package directory.",
          "error"
        );
        return;
      }

      if (!openFn) {
        try {
          const glimpse = await import(glimpsePath);
          openFn = glimpse.open;
        } catch (e: any) {
          ctx.ui.notify(`Failed to load Glimpse: ${e.message}`, "error");
          return;
        }
      }

      // Ensure shell.html exists
      if (!existsSync(shellPath)) writeShellHTML();

      const repoName = basename(ctx.cwd);
      let data: { staged: string; unstaged: string; untracked: { path: string; content: string }[]; repoName: string; branch: string; commits: any[] };

      // Decide mode: file path, jj revset, or default (working copy)
      let mode: "file" | "revset" | "default" = "default";
      if (arg) {
        const absPath = resolve(ctx.cwd, arg);
        if (existsSync(absPath)) {
          mode = "file";
        } else {
          // Try as a jj revset
          const revCheck = await pi.exec("jj", [
            "log", "-r", arg, "--no-graph", "--limit", "1",
            "-T", 'commit_id.short() ++ "\n"',
          ]);
          if (revCheck.code === 0 && revCheck.stdout.trim()) {
            mode = "revset";
          } else {
            ctx.ui.notify(`Not a file or valid jj revset: ${arg}`, "error");
            return;
          }
        }
      }

      // ─── Single-file mode ───
      if (mode === "file") {
        const absPath = resolve(ctx.cwd, arg!);

        const jjCheck = await pi.exec("jj", ["root"]);
        const inJjRepo = jjCheck.code === 0;

        let unstaged = "";
        const untracked: { path: string; content: string }[] = [];
        let branch = "";

        if (inJjRepo) {
          const branchResult = await pi.exec("jj", [
            "log", "-r", "@-", "--no-graph",
            "-T", "bookmarks",
          ]);
          branch = branchResult.stdout.trim();

          const diffResult = await pi.exec("jj", [
            "diff", "--git", "--", arg!,
          ]);
          unstaged = diffResult.stdout || "";
        }

        // No jj diff — show the whole file for review
        if (!unstaged) {
          try {
            const content = readFileSync(absPath, "utf-8");
            untracked.push({ path: arg!, content });
          } catch (e: any) {
            ctx.ui.notify(`Cannot read file: ${e.message}`, "error");
            return;
          }
        }

        data = { staged: "", unstaged, untracked, repoName, branch, commits: [] };

      // ─── Revset mode ───
      } else if (mode === "revset") {
        const jjCheck = await pi.exec("jj", ["root"]);
        if (jjCheck.code !== 0) {
          ctx.ui.notify("Not in a jj repository", "error");
          return;
        }

        const branchResult = await pi.exec("jj", [
          "log", "-r", "@-", "--no-graph",
          "-T", "bookmarks",
        ]);
        const branch = branchResult.stdout.trim();

        // Enumerate all revisions matched by the revset
        const commitLogResult = await pi.exec("jj", [
          "log",
          "-r", arg!,
          "--no-graph",
          "-T", 'commit_id.short() ++ "|" ++ description.first_line() ++ "|" ++ committer.timestamp().ago() ++ "\n"',
        ]);

        const commitLines = (commitLogResult.stdout || "")
          .split("\n")
          .filter((l) => l.trim());

        const parsedCommits = commitLines
          .map((line) => {
            const parts = line.split("|");
            const hash = parts[0] ?? "";
            const time = parts[parts.length - 1] ?? "";
            const message = parts.slice(1, parts.length - 1).join("|");
            return { hash, message, time };
          })
          .filter((c) => c.hash);

        if (parsedCommits.length === 0) {
          ctx.ui.notify("No commits matched the revset", "info");
          return;
        }

        const commitDiffs = await Promise.all(
          parsedCommits.map((c) =>
            pi.exec("jj", ["diff", "-r", c.hash, "--git"])
          )
        );

        const commits = parsedCommits.map((c, i) => ({
          ...c,
          diff: commitDiffs[i].stdout || "",
        }));

        data = { staged: "", unstaged: "", untracked: [], repoName, branch, commits };

      // ─── Full repo mode ───
      } else {
        const jjCheck = await pi.exec("jj", ["root"]);
        if (jjCheck.code !== 0) {
          ctx.ui.notify("Not in a jj repository", "error");
          return;
        }

        const [diffResult, branchResult] = await Promise.all([
          pi.exec("jj", ["diff", "--git"]),
          pi.exec("jj", [
            "log", "-r", "@-", "--no-graph",
            "-T", "bookmarks",
          ]),
        ]);

        const unstaged = diffResult.stdout || "";
        const branch = branchResult.stdout.trim();

        // Gather commits since trunk (up to 5)
        const commitLogResult = await pi.exec("jj", [
          "log",
          "-r", "trunk()..@-",
          "--limit", "5",
          "--no-graph",
          "-T", 'commit_id.short() ++ "|" ++ description.first_line() ++ "|" ++ committer.timestamp().ago() ++ "\n"',
        ]);

        const commitLines = (commitLogResult.stdout || "")
          .split("\n")
          .filter((l) => l.trim());

        const parsedCommits = commitLines
          .map((line) => {
            const parts = line.split("|");
            const hash = parts[0] ?? "";
            const time = parts[parts.length - 1] ?? "";
            const message = parts.slice(1, parts.length - 1).join("|");
            return { hash, message, time };
          })
          .filter((c) => c.hash);

        const commitDiffs = await Promise.all(
          parsedCommits.map((c) =>
            pi.exec("jj", ["diff", "-r", c.hash, "--git"])
          )
        );

        const commits = parsedCommits.map((c, i) => ({
          ...c,
          diff: commitDiffs[i].stdout || "",
        }));

        if (!unstaged && commits.length === 0) {
          ctx.ui.notify("No changes", "info");
          return;
        }

        data = { staged: "", unstaged, untracked: [], repoName, branch, commits };
      }
      const dataJSON = JSON.stringify(data);

      // Reset comments for this session
      activeComments = new Map();

      // Detect the frontmost terminal window geometry so Crit overlaps it
      // Captures position/size in AppleScript coords (top-left origin) for later repositioning
      let termGeom: { x: number; y: number; width: number; height: number } | null = null;
      try {
        const geo = await pi.exec("osascript", ["-e", `
tell application "System Events"
  set fp to first application process whose frontmost is true
  set {wx, wy} to position of window 1 of fp
  set {ww, wh} to size of window 1 of fp
end tell
return "" & wx & "," & wy & "," & ww & "," & wh`]);
        if (geo.code === 0 && geo.stdout.trim()) {
          const [x, y, w, h] = geo.stdout.trim().split(",").map(Number);
          if ([x, y, w, h].every((n) => !isNaN(n))) {
            termGeom = { x, y, width: w, height: h };
          }
        }
      } catch {}

      // Open window if needed (reuse prewarmed)
      if (!win) {
        win = openFn(null, {
          width: termGeom?.width ?? 1120,
          height: termGeom?.height ?? 760,
          title: `Crit — ${repoName}`,
        });
        ready = false;
        wireWindow(win);
      }

      try {
        await waitForReady();
      } catch (e: any) {
        ctx.ui.notify(`Crit viewer failed: ${e.message}`, "error");
        win = null;
        ready = false;
        return;
      }

      win.send(`window.updateCrit(${dataJSON})`);
      win.show({ title: `Crit — ${repoName}` });

      // Resize and reposition the window to overlap the terminal
      if (termGeom) {
        try {
          await pi.exec("osascript", ["-e", `
tell application "System Events"
  tell process "Glimpse"
    set position of window 1 to {${termGeom.x}, ${termGeom.y}}
    set size of window 1 to {${termGeom.width}, ${termGeom.height}}
  end tell
end tell`]);
        } catch {}
      }

      // Block until the window is closed
      await waitForClose();

      // Write comments to file
      const critFile = writeCommentFile(repoName, data.branch);
      if (critFile) {
        const count = activeComments.size;
        ctx.ui.notify(`Wrote ${count} comment(s) to ${critFile}`, "info");

        // Send the feedback as a follow-up message so the agent processes it
        const contents = await pi.exec("cat", [critFile]);
        if (contents.code === 0) {
          pi.sendUserMessage(
            `Review feedback from /crit (${count} comments, saved to ${critFile}):\n\n${contents.stdout}`,
            { deliverAs: "followUp" }
          );
        }
      } else {
        ctx.ui.notify("No comments were left", "info");
      }
    },
  });
}
