import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { dirname, join, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { prepareViewerData } from "./prepare-viewer-data.js";
import { buildReproData } from "./repro-data.js";

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
let lastHeartbeat = 0;

// Comment accumulation for the active /crit session
interface AgentFindingContext {
  file: string;
  line: number;
  priority: string;
  title: string;
  description: string;
  suggested_fix?: string;
  agent: string;
}

interface CritComment {
  id: string;
  filePath: string;
  lineNumber: number;
  side: "additions" | "deletions";
  text: string;
  replyToFindings?: AgentFindingContext[];
}

let activeComments: Map<string, CritComment> = new Map();
let closeResolve: (() => void) | null = null;

// Agent review state — stores prepared viewer data between command and tool call
let pendingCritReviewData: string | null = null;
let dismissedFindings: Set<string> = new Set();

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
    font-family: 'Comic Mono', monospace;
    -webkit-font-smoothing: antialiased;
  }
  #app {
    height: 100%; display: none;
    --diffs-font-family: 'Comic Mono', monospace;
    --diffs-header-font-family: 'Comic Mono', monospace;
    --diffs-font-size: 18px;
    --diffs-line-height: 26px;
  }

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
    font-family: 'Comic Mono', monospace;
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
    font-family: 'Comic Mono', monospace;
  }

  /* ─── Main panel ─── */
  .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }

  .commit-banner {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 14px; background: #2a2b3d;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    font-size: 12px; flex-shrink: 0;
  }
  .commit-banner-hash {
    font-family: 'Comic Mono', monospace; color: #bd93f9; font-size: 11px;
    background: rgba(189,147,249,0.12); padding: 2px 6px; border-radius: 3px;
  }
  .commit-banner-message {
    color: rgba(255,255,255,0.85); flex: 1; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .commit-banner-time { color: rgba(255,255,255,0.3); font-size: 11px; flex-shrink: 0; }

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
  .tab-panel, .repro-panel { height: 100%; overflow-y: auto; overflow-x: hidden; }
  .tab-panel::-webkit-scrollbar, .repro-panel::-webkit-scrollbar { width: 8px; }
  .tab-panel::-webkit-scrollbar-track, .repro-panel::-webkit-scrollbar-track { background: transparent; }
  .tab-panel::-webkit-scrollbar-thumb, .repro-panel::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
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
    font-family: 'Comic Mono', monospace;
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
    font-family: 'Comic Mono', monospace;
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

  /* ─── Agent Comment Bubbles ─── */
  .agent-comment-bubble {
    background: #2a2b3d;
    border: 1px solid rgba(139, 92, 246, 0.25);
    border-left: 3px solid;
    border-radius: 8px;
    padding: 10px 14px;
    margin: 6px 16px;
    font-size: 13px;
  }
  .agent-comment-bubble.p0 { border-left-color: #ff5555; }
  .agent-comment-bubble.p1 { border-left-color: #ffb86c; }
  .agent-comment-bubble.p2 { border-left-color: #50fa7b; }
  .agent-comment-bubble.p3 { border-left-color: #6272a4; }
  .agent-comment-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .agent-comment-priority {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    color: white;
  }
  .agent-comment-priority.p0 { background: rgba(255, 85, 85, 0.25); color: #ff5555; }
  .agent-comment-priority.p1 { background: rgba(255, 184, 108, 0.25); color: #ffb86c; }
  .agent-comment-priority.p2 { background: rgba(80, 250, 123, 0.25); color: #50fa7b; }
  .agent-comment-priority.p3 { background: rgba(98, 114, 164, 0.25); color: #6272a4; }
  .agent-comment-agent {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    font-family: 'Comic Mono', monospace;
  }
  .agent-comment-title {
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    margin-bottom: 4px;
    line-height: 1.4;
  }
  .agent-comment-description {
    color: rgba(255, 255, 255, 0.65);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .agent-comment-fix {
    margin-top: 8px;
    padding: 8px 10px;
    background: rgba(80, 250, 123, 0.06);
    border: 1px solid rgba(80, 250, 123, 0.15);
    border-radius: 6px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    line-height: 1.4;
  }
  .agent-comment-fix-label {
    font-size: 10px;
    font-weight: 600;
    color: #50fa7b;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .agent-comment-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .agent-comment-dismiss {
    font-size: 10px;
    color: rgba(255, 255, 255, 0.3);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .agent-comment-dismiss:hover {
    color: rgba(255, 255, 255, 0.6);
    background: rgba(255, 255, 255, 0.06);
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
    font-family: 'Comic Mono', monospace;
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
    font-family: 'Comic Mono', monospace;
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
// Cmd+W closes the window (send message to Node side so closed event fires)
document.addEventListener('keydown', function(e) {
  if (e.metaKey && e.key === 'w') {
    e.preventDefault();
    try { window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({type: "close-requested"})); } catch {}
  }
});

// Heartbeat so Node side can detect when the window dies
setInterval(function() {
  try { window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({type: "heartbeat"})); } catch {}
}, 1000);

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
      lastHeartbeat = Date.now();
      if (readyResolve) {
        readyResolve();
        readyResolve = null;
      }
    }

    if (data?.type === "heartbeat") {
      lastHeartbeat = Date.now();
    }

    if (data?.type === "close-requested") {
      // Directly clean up and resolve — don't rely on closed event
      win = null;
      ready = false;
      if (closeResolve) {
        closeResolve();
        closeResolve = null;
      }
      try { w.close(); } catch {}
      setTimeout(() => prewarm(), 100);
    }

    // Comment messages from the viewer
    if (data?.type === "comment-added" && data.comment) {
      const c = data.comment as CritComment;
      if (data.replyToFindings) {
        c.replyToFindings = data.replyToFindings;
      }
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

    // Track dismissed agent findings
    if (data?.type === "finding-dismissed" && data.commentId) {
      dismissedFindings.add(data.commentId);
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

/** Wait for the window to close, polling heartbeat as a safety net.
 *  Also intercepts Escape in pi terminal as an exit mechanism. */
function waitForClose(ctx?: { ui: { onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => () => void } }): Promise<void> {
  if (!win) return Promise.resolve();
  lastHeartbeat = Date.now();
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(poll);
      unsubInput?.();
      closeResolve = null;
      if (win) {
        try { win.close(); } catch {}
        win = null;
      }
      ready = false;
      resolve();
    };

    // Poll every 1s — if no heartbeat for 3s, the window is gone
    const poll = setInterval(() => {
      if (!win) { cleanup(); return; }
      if (Date.now() - lastHeartbeat > 3000) {
        cleanup();
      }
    }, 1000);

    // Intercept Escape in the pi terminal to exit crit
    let unsubInput: (() => void) | undefined;
    if (ctx?.ui?.onTerminalInput) {
      unsubInput = ctx.ui.onTerminalInput((data: string) => {
        if (data === "\x1b") {
          cleanup();
          return { consume: true };
        }
        return undefined;
      });
    }

    closeResolve = cleanup;
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

      // If this comment is a reply to agent findings, include the context
      if (c.replyToFindings?.length) {
        for (const f of c.replyToFindings) {
          md += `> **[${f.agent}] ${f.priority}: ${f.title}**\n`;
          for (const line of f.description.split("\n")) {
            md += `> ${line}\n`;
          }
          if (f.suggested_fix) {
            md += `> **Suggested fix:** ${f.suggested_fix}\n`;
          }
          md += `\n`;
        }
      }

      md += `${c.text}\n\n`;
    }
  }

  const dir = join(homedir(), ".pi", "crit", repoName);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${timestamp}.md`);
  writeFileSync(filePath, md);
  return filePath;
}

async function detectFrontmostWindowGeometry(pi: ExtensionAPI) {
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
        return { x, y, width: w, height: h };
      }
    }
  } catch {}
  return null;
}

async function openViewerWindow(pi: ExtensionAPI, ctx: any, title: string, dataJSON: string, termGeom?: { x: number; y: number; width: number; height: number } | null) {
  if (win && ready) {
    try {
      win.send("1");
    } catch {
      win = null;
      ready = false;
    }
  }

  if (!win) {
    win = openFn(null, {
      width: termGeom?.width ?? 1120,
      height: termGeom?.height ?? 760,
      title,
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
    return false;
  }

  win.send(`window.updateCrit(${dataJSON})`);
  win.show({ title });

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

  return true;
}

/**
 * Fetch old+new file contents for all changed files in a revision.
 * Pass null for working copy changes (compares @- to @).
 * Pass a commit hash for a specific commit (compares parent to commit).
 */
async function getChangedFileContents(
  pi: ExtensionAPI,
  rev: string | null
): Promise<{ path: string; oldContent: string; newContent: string }[]> {
  const summaryArgs = rev ? ["diff", "--summary", "-r", rev] : ["diff", "--summary"];
  const summaryResult = await pi.exec("jj", summaryArgs);
  const lines = (summaryResult.stdout || "").split("\n").filter((l) => l.trim());

  if (lines.length === 0) return [];

  const oldRev = rev ? `${rev}-` : "@-";
  const newRev = rev || "@";

  const results = await Promise.all(
    lines.map(async (line) => {
      const status = line[0];
      const path = line.slice(2).trim();

      let oldContent = "";
      let newContent = "";

      if (status !== "A") {
        const old = await pi.exec("jj", ["file", "show", "-r", oldRev, path]);
        oldContent = old.code === 0 ? old.stdout : "";
      }

      if (status !== "D") {
        const cur = await pi.exec("jj", ["file", "show", "-r", newRev, path]);
        newContent = cur.code === 0 ? cur.stdout : "";
      }

      return { path, oldContent, newContent };
    })
  );

  return results;
}

// ── VCS Helpers ──────────────────────────────────────────

function execQuiet(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
    }).trim();
  } catch {
    return "";
  }
}

function detectVcs(cwd?: string): "jj" | "git" | "none" {
  const jjRoot = execQuiet("jj root 2>/dev/null", cwd);
  const gitRoot = execQuiet("git rev-parse --show-toplevel 2>/dev/null", cwd);
  if (jjRoot && gitRoot) {
    return jjRoot.length >= gitRoot.length ? "jj" : "git";
  }
  if (jjRoot) return "jj";
  if (gitRoot) return "git";
  return "none";
}

// ── Review Agent Config ──────────────────────────────────

const REVIEW_AGENTS = [
  "review-logic",
  "review-security",
  "review-silent-failures",
  "review-test-coverage",
  "review-types",
];

function loadReviewGuidelines(): string | null {
  const candidates = [
    join(process.cwd(), "REVIEW_GUIDELINES.md"),
    join(process.cwd(), ".pi", "review-rules.md"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8").trim();
        if (content) return content;
      } catch {}
    }
  }
  return null;
}

interface ReviewTarget {
  label: string;
  diff_cmd: string;
}

function buildCritReviewPrompt(target: ReviewTarget, guidelines: string | null): string {
  const guidelinesBlock = guidelines
    ? `\n\nThis project has additional review guidelines:\n\n${guidelines}`
    : "";

  return `You are orchestrating a parallel code review. Follow these steps exactly.

**Step 1:** Use the \`parallel_subagents\` tool to dispatch 5 review specialists simultaneously.

Each agent's task should be:

\`\`\`
Review the code changes.

Diff command: \`${target.diff_cmd}\`

Review only changes shown in the diff, not pre-existing code. Trace into related files for context as needed.${guidelinesBlock}
\`\`\`

Call parallel_subagents with:
\`\`\`
{
  "agents": [
    { "name": "review-logic", "agent": "review-logic", "task": "<the task above>" },
    { "name": "review-security", "agent": "review-security", "task": "<the task above>" },
    { "name": "review-silent-failures", "agent": "review-silent-failures", "task": "<the task above>" },
    { "name": "review-test-coverage", "agent": "review-test-coverage", "task": "<the task above>" },
    { "name": "review-types", "agent": "review-types", "task": "<the task above>" }
  ]
}
\`\`\`

**Step 2:** After all agents complete, extract the JSON findings block from each agent's summary. Each agent outputs a \`\`\`json code block at the end of its response containing \`{"findings": [...]}\`.

**Step 3:** Merge all findings into a single array. For each finding, add an \`"agent"\` field with the agent name (e.g. "review-logic").

**Step 4:** Deduplicate: if two findings reference the same file and line with similar titles, keep the higher-priority one.

**Step 5:** Sort by priority: P0 first, then P1, P2, P3.

**Step 6:** Call the \`crit_review_findings\` tool with:
- \`findings\`: the merged findings array
- \`target\`: "${target.label}"
- \`agents_used\`: ${JSON.stringify(REVIEW_AGENTS)}

Do not add commentary between steps. Execute the tool calls.`;
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
      let data: { files: { path: string; oldContent: string; newContent: string }[]; untracked: { path: string; content: string }[]; repoName: string; branch: string; commits: any[] };

      // Decide mode: file path, jj revset, or default (working copy)
      let mode: "file" | "revset" | "default" = "default";
      if (arg) {
        const expanded = arg.startsWith("~/") ? join(homedir(), arg.slice(2)) : arg;
        const absPath = resolve(ctx.cwd, expanded);
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
        const expandedArg = arg!.startsWith("~/") ? join(homedir(), arg!.slice(2)) : arg!;
        const absPath = resolve(ctx.cwd, expandedArg);

        const jjCheck = await pi.exec("jj", ["root"]);
        const inJjRepo = jjCheck.code === 0;

        const files: { path: string; oldContent: string; newContent: string }[] = [];
        const untracked: { path: string; content: string }[] = [];
        let branch = "";

        if (inJjRepo) {
          const branchResult = await pi.exec("jj", [
            "log", "-r", "@-", "--no-graph",
            "-T", "bookmarks",
          ]);
          branch = branchResult.stdout.trim();

          const summaryResult = await pi.exec("jj", [
            "diff", "--summary", "--", expandedArg,
          ]);
          const summary = (summaryResult.stdout || "").trim();

          if (summary) {
            const [oldResult, newResult] = await Promise.all([
              pi.exec("jj", ["file", "show", "-r", "@-", expandedArg]),
              pi.exec("jj", ["file", "show", "-r", "@", expandedArg]),
            ]);
            files.push({
              path: expandedArg,
              oldContent: oldResult.code === 0 ? oldResult.stdout : "",
              newContent: newResult.code === 0 ? newResult.stdout : "",
            });
          }
        }

        // No jj diff — show the whole file for review
        if (files.length === 0) {
          try {
            const content = readFileSync(absPath, "utf-8");
            untracked.push({ path: expandedArg, content });
          } catch (e: any) {
            ctx.ui.notify(`Cannot read file: ${e.message}`, "error");
            return;
          }
        }

        data = { files, untracked, repoName, branch, commits: [] };

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

        const commits = await Promise.all(
          parsedCommits.map(async (c) => ({
            ...c,
            files: await getChangedFileContents(pi, c.hash),
          }))
        );

        data = { files: [], untracked: [], repoName, branch, commits };

      // ─── Full repo mode ───
      } else {
        const jjCheck = await pi.exec("jj", ["root"]);
        if (jjCheck.code !== 0) {
          ctx.ui.notify("Not in a jj repository", "error");
          return;
        }

        const [branchResult, workingFiles] = await Promise.all([
          pi.exec("jj", [
            "log", "-r", "@-", "--no-graph",
            "-T", "bookmarks",
          ]),
          getChangedFileContents(pi, null),
        ]);

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

        const commits = await Promise.all(
          parsedCommits.map(async (c) => ({
            ...c,
            files: await getChangedFileContents(pi, c.hash),
          }))
        );

        if (workingFiles.length === 0 && commits.length === 0) {
          ctx.ui.notify("No changes", "info");
          return;
        }

        data = { files: workingFiles, untracked: [], repoName, branch, commits };
      }
      const viewerData = await prepareViewerData(data);
      const dataJSON = JSON.stringify(viewerData);

      // Reset comments for this session
      activeComments = new Map();

      const termGeom = await detectFrontmostWindowGeometry(pi);

      // Show widget before opening the window so it's visible immediately
      const reviewing = mode === "default" ? "working changes" : arg!;

      // Compute diffstat from the viewer data we already have
      let totalAdd = 0;
      let totalDel = 0;
      if (mode !== "file") {
        for (const f of viewerData.workingFiles) {
          totalAdd += f.additions;
          totalDel += f.deletions;
        }
        for (const c of viewerData.commits) {
          for (const f of c.files) {
            totalAdd += f.additions;
            totalDel += f.deletions;
          }
        }
      }
      if (mode !== "file") {
        ctx.ui.setWidget("crit", (_tui: any, theme: any) => ({
          invalidate() {},
          render() {
            const added = theme.fg("success", `+${totalAdd}`);
            const removed = theme.fg("error", `-${totalDel}`);
            return [`🔍 reviewing ${reviewing} ${added}/${removed} (Escape to exit)`];
          },
        }));
      } else {
        ctx.ui.setWidget("crit", [`🔍 reviewing ${reviewing} (Escape to exit)`]);
      }

      if (!(await openViewerWindow(pi, ctx, `Crit — ${repoName}`, dataJSON, termGeom))) {
        ctx.ui.setWidget("crit", undefined);
        return;
      }

      // Block until the window is closed
      await waitForClose(ctx);

      ctx.ui.setWidget("crit", undefined);

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

  // ── crit_review_findings tool ────────────────────────────

  pi.registerTool({
    name: "crit_review_findings",
    label: "crit_review_findings",
    description:
      "Open code review findings in the Crit native diff viewer with agent comments in the gutter. Called by the orchestrator after merging findings from all specialist agents.",
    parameters: Type.Object({
      findings: Type.Array(
        Type.Object({
          file: Type.String(),
          line: Type.Number(),
          end_line: Type.Optional(Type.Number()),
          priority: Type.String(),
          category: Type.Optional(Type.String()),
          title: Type.String(),
          description: Type.String(),
          suggested_fix: Type.Optional(Type.String()),
          agent: Type.String(),
        }),
        { description: "Merged findings from all review agents" },
      ),
      target: Type.String({ description: "What was reviewed" }),
      agents_used: Type.Array(Type.String(), { description: "Which agents ran" }),
      elapsed_seconds: Type.Optional(Type.Number({ description: "Total review time in seconds" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { findings, target, agents_used } = params;

      if (!pendingCritReviewData) {
        return {
          content: [{ type: "text" as const, text: "Error: No pending crit review data. Run /crit-agent-review first." }],
        };
      }

      if (!ctx.hasUI) {
        const summary = findings.length === 0
          ? "No findings. Code looks good."
          : findings.map((f: any) => `${f.priority} [${f.agent}] ${f.file}:${f.line} — ${f.title}`).join("\n");
        pendingCritReviewData = null;
        return {
          content: [{ type: "text" as const, text: `Review complete: ${findings.length} findings.\n\n${summary}` }],
        };
      }

      // Parse the stored viewer data and inject agent findings
      const viewerData = JSON.parse(pendingCritReviewData);
      viewerData.agentFindings = findings;
      const dataJSON = JSON.stringify(viewerData);
      pendingCritReviewData = null;

      // Reset tracking state
      activeComments = new Map();
      dismissedFindings = new Set();

      const repoName = viewerData.repoName || "review";
      const termGeom = await detectFrontmostWindowGeometry(pi);

      const findingCounts: Record<string, number> = {};
      for (const f of findings) {
        findingCounts[f.priority] = (findingCounts[f.priority] || 0) + 1;
      }
      const countStr = Object.entries(findingCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([p, n]) => `${n}×${p}`)
        .join(" ");

      ctx.ui.setWidget("crit", (_tui: any, theme: any) => ({
        invalidate() {},
        render() {
          return [`🔍 ${agents_used.length} agents found ${findings.length} issues (${countStr}) — reviewing in Crit (Escape to exit)`];
        },
      }));

      if (!(await openViewerWindow(pi, ctx, `Crit Review — ${repoName}`, dataJSON, termGeom))) {
        ctx.ui.setWidget("crit", undefined);
        return {
          content: [{ type: "text" as const, text: "Failed to open Crit viewer." }],
        };
      }

      // Block until window closes
      await waitForClose(ctx);
      ctx.ui.setWidget("crit", undefined);

      // Write user comments to file (same as /crit)
      const branch = viewerData.branch || "";
      const critFile = writeCommentFile(repoName, branch);

      // Build summary of what happened
      const totalFindings = findings.length;
      const dismissed = dismissedFindings.size;
      const kept = totalFindings - dismissed;
      const userCommentCount = activeComments.size;

      let summary = `Review complete: ${totalFindings} findings from ${agents_used.length} agents.\n`;
      summary += `${kept} findings kept, ${dismissed} dismissed.\n`;

      if (critFile) {
        summary += `${userCommentCount} user comment(s) saved to ${critFile}.\n`;
        // Send user comments as follow-up
        const contents = await pi.exec("cat", [critFile]);
        if (contents.code === 0) {
          pi.sendUserMessage(
            `Review feedback from /crit-agent-review (${userCommentCount} comments, saved to ${critFile}):\n\n${contents.stdout}`,
            { deliverAs: "followUp" }
          );
        }
      }

      if (kept > 0) {
        summary += "\nKept findings:\n";
        for (const f of findings) {
          const fId = `agent-${findings.indexOf(f)}`;
          if (!dismissedFindings.has(fId)) {
            summary += `  ${f.priority} [${f.agent}] ${f.file}:${f.line} — ${f.title}\n`;
          }
        }
      }

      return {
        content: [{ type: "text" as const, text: summary }],
      };
    },
  });

  // ── /crit-agent-review command ─────────────────────────

  pi.registerCommand("crit-agent-review", {
    description: "Multi-agent code review shown in the Crit native diff viewer — dispatches 5 specialist agents, opens findings in gutter",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("crit-agent-review requires interactive mode", "error");
        return;
      }

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

      if (!existsSync(shellPath)) writeShellHTML();

      const vcs = detectVcs(ctx.cwd);
      if (vcs === "none") {
        ctx.ui.notify("Not in a git or jj repository", "error");
        return;
      }

      const arg = _args.trim() || null;
      let target: ReviewTarget | null = null;
      let diffArg: string | null = null;

      // Parse shortcut args (same as /review)
      if (arg) {
        const a = arg.toLowerCase();
        if (a === "trunk" || a === "since-trunk") {
          if (vcs === "jj") {
            target = { label: "changes since trunk", diff_cmd: "jj diff --from trunk()" };
          } else {
            const mergeBase = execQuiet(`git merge-base HEAD main`, ctx.cwd) || "main";
            target = { label: "changes vs main", diff_cmd: `git diff ${mergeBase}` };
          }
        } else if (a === "wc" || a === "working-copy" || a === "uncommitted") {
          if (vcs === "jj") {
            target = { label: "working copy", diff_cmd: "jj diff" };
          } else {
            target = { label: "uncommitted changes", diff_cmd: "git diff HEAD" };
          }
        } else {
          // Treat as revision/commit ref
          if (vcs === "jj") {
            target = { label: `revision ${arg}`, diff_cmd: `jj diff -r ${arg}` };
            diffArg = arg;
          } else {
            target = { label: `commit ${arg.slice(0, 7)}`, diff_cmd: `git diff ${arg}~1..${arg}` };
            diffArg = arg;
          }
        }
      }

      // Default: working copy for jj, uncommitted for git
      if (!target) {
        if (vcs === "jj") {
          target = { label: "working copy", diff_cmd: "jj diff" };
        } else {
          target = { label: "uncommitted changes", diff_cmd: "git diff HEAD" };
        }
      }

      // Prepare viewer data (same as /crit)
      const repoName = basename(ctx.cwd);
      let data: { staged: string; unstaged: string; untracked: { path: string; content: string }[]; repoName: string; branch: string; commits: any[] };

      if (vcs === "jj") {
        const [diffResult, branchResult] = await Promise.all([
          pi.exec("jj", ["diff", "--git", "--context=100", ...(diffArg ? ["-r", diffArg] : target.diff_cmd.includes("--from") ? ["--from", "trunk()"] : [])]),
          pi.exec("jj", ["log", "-r", "@-", "--no-graph", "-T", "bookmarks"]),
        ]);
        const unstaged = diffResult.stdout || "";
        const branch = branchResult.stdout.trim();

        if (!unstaged) {
          ctx.ui.notify("No changes to review", "info");
          return;
        }

        data = { staged: "", unstaged, untracked: [], repoName, branch, commits: [] };
      } else {
        const diffCmd = target.diff_cmd.replace(/^git diff /, "");
        const diffParts = diffCmd.split(/\s+/);
        const [diffResult, branchResult] = await Promise.all([
          pi.exec("git", ["diff", "--context=100", ...diffParts]),
          pi.exec("git", ["branch", "--show-current"]),
        ]);
        const unstaged = diffResult.stdout || "";
        const branch = branchResult.stdout.trim();

        if (!unstaged) {
          ctx.ui.notify("No changes to review", "info");
          return;
        }

        data = { staged: "", unstaged, untracked: [], repoName, branch, commits: [] };
      }

      // Prepare and store the viewer data for the tool to pick up
      const viewerData = await prepareViewerData(data);
      pendingCritReviewData = JSON.stringify(viewerData);

      const guidelines = loadReviewGuidelines();
      const prompt = buildCritReviewPrompt(target, guidelines);

      ctx.ui.notify(`Starting agent review: ${target.label} (5 agents) — will open in Crit when complete`, "info");
      pi.sendUserMessage(prompt);
    },
  });

  pi.registerCommand("crit-repro", {
    description: "Open a minimal long-file @pierre/diffs repro in a native window.",
    handler: async (_args, ctx) => {
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

      if (!existsSync(shellPath)) writeShellHTML();

      activeComments = new Map();
      const reproData = await buildReproData();
      const dataJSON = JSON.stringify(reproData);
      const termGeom = await detectFrontmostWindowGeometry(pi);

      ctx.ui.setWidget("crit", ["🔬 running crit repro (Escape to exit)"]);

      if (!(await openViewerWindow(pi, ctx, "Crit Repro", dataJSON, termGeom))) {
        ctx.ui.setWidget("crit", undefined);
        return;
      }

      await waitForClose(ctx);
      ctx.ui.setWidget("crit", undefined);
    },
  });
}
