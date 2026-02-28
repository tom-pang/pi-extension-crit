import React from "react";
import { createRoot } from "react-dom/client";
import { PatchDiff, MultiFileDiff } from "@pierre/diffs/react";
import type { FileDiffOptions } from "@pierre/diffs/react";

declare global {
  interface Window {
    __DIFF_DATA__: {
      staged: string;
      unstaged: string;
      untracked: { path: string; content: string }[];
      repoName: string;
    };
  }
}

const diffOptions: FileDiffOptions<undefined> = {
  theme: "pierre-dark",
  diffStyle: "unified",
  overflow: "scroll",
  themeType: "dark",
};

function Section({
  label,
  color,
  count,
  children,
}: {
  label: string;
  color: string;
  count: number;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  if (count === 0) return null;

  return (
    <div className="diff-section">
      <div
        className="section-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="section-dot" style={{ background: color }} />
        <span className="section-label">{label}</span>
        <span className="section-count">
          {count} file{count !== 1 ? "s" : ""}
        </span>
        <span className="section-toggle">{collapsed ? "▶" : "▼"}</span>
      </div>
      {!collapsed && <div className="section-body">{children}</div>}
    </div>
  );
}

function StagedOrUnstagedSection({
  label,
  color,
  patch,
}: {
  label: string;
  color: string;
  patch: string;
}) {
  if (!patch.trim()) return null;

  // Count files in patch
  const fileCount = (patch.match(/^diff --git /gm) || []).length;

  return (
    <Section label={label} color={color} count={fileCount}>
      <PatchDiff patch={patch} options={diffOptions} />
    </Section>
  );
}

function UntrackedSection({
  untracked,
}: {
  untracked: { path: string; content: string }[];
}) {
  if (untracked.length === 0) return null;

  return (
    <Section label="Untracked" color="#3B82F6" count={untracked.length}>
      {untracked.map(({ path, content }) => (
        <div key={path} className="file-diff-wrapper">
          <MultiFileDiff
            oldFile={{ name: path, contents: "" }}
            newFile={{ name: path, contents: content }}
            options={diffOptions}
          />
        </div>
      ))}
    </Section>
  );
}

function App() {
  const data = window.__DIFF_DATA__;

  const stagedCount = (data.staged.match(/^diff --git /gm) || []).length;
  const unstagedCount = (data.unstaged.match(/^diff --git /gm) || []).length;
  const totalFiles = stagedCount + unstagedCount + data.untracked.length;

  return (
    <>
      <div className="repo-header">
        <span className="repo-name">{data.repoName}</span>
        <span className="repo-label">working changes</span>
      </div>

      {totalFiles > 0 && (
        <div className="summary-bar">
          <div className="summary-left">
            <span className="summary-total">
              {totalFiles} file{totalFiles !== 1 ? "s" : ""} changed
            </span>
          </div>
          <div className="summary-right">
            {stagedCount > 0 && (
              <span className="summary-chip">
                <span className="chip-dot" style={{ background: "#00cab1" }} />
                {stagedCount} staged
              </span>
            )}
            {unstagedCount > 0 && (
              <span className="summary-chip">
                <span className="chip-dot" style={{ background: "#F59E0B" }} />
                {unstagedCount} unstaged
              </span>
            )}
            {data.untracked.length > 0 && (
              <span className="summary-chip">
                <span className="chip-dot" style={{ background: "#3B82F6" }} />
                {data.untracked.length} untracked
              </span>
            )}
          </div>
        </div>
      )}

      <StagedOrUnstagedSection
        label="Staged"
        color="#00cab1"
        patch={data.staged}
      />
      <StagedOrUnstagedSection
        label="Unstaged"
        color="#F59E0B"
        patch={data.unstaged}
      />
      <UntrackedSection untracked={data.untracked} />

      {totalFiles === 0 && (
        <div className="empty-state">No changes</div>
      )}
    </>
  );
}

// Mount
const loading = document.getElementById("loading");
if (loading) loading.style.display = "none";

const root = createRoot(document.getElementById("app")!);
root.render(<App />);
