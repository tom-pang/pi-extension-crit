import React, { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PatchDiff, MultiFileDiff } from "@pierre/diffs/react";
import type { FileDiffOptions } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs";

interface CommitInfo {
  hash: string;
  message: string;
  time: string;
  diff: string;
}

interface DiffData {
  staged: string;
  unstaged: string;
  untracked: { path: string; content: string }[];
  repoName: string;
  branch: string;
  commits: CommitInfo[];
}

interface FileEntry {
  id: string;
  name: string;
  path: string;
  section: "staged" | "unstaged" | "untracked" | "committed";
  additions: number;
  deletions: number;
  patch?: string;
  content?: string;
}

interface Comment {
  id: string;
  filePath: string;
  lineNumber: number;
  side: "additions" | "deletions";
  text: string;
}

declare global {
  interface Window {
    updateCrit: (data: DiffData) => void;
  }
}

const SECTION_COLORS = {
  staged: "#50fa7b",
  unstaged: "#ffb86c",
  untracked: "#bd93f9",
  committed: "#6272a4",
} as const;

const SECTION_LABELS = {
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
  committed: "Committed",
} as const;

const diffOptions: FileDiffOptions<string> = {
  theme: "dracula",
  diffStyle: "unified",
  overflow: "scroll",
  themeType: "dark",
  enableGutterUtility: true,
  hunkSeparators: "line-info",
  expansionLineCount: 50,
};

/** Split a combined git diff into individual per-file patches. */
function splitPatch(patch: string): string[] {
  const parts: string[] = [];
  const lines = patch.split("\n");
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      parts.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0 && current.some((l) => l.startsWith("diff --git "))) {
    parts.push(current.join("\n"));
  }
  return parts;
}

/** Extract file path from a git diff header like "diff --git a/foo/bar.ts b/foo/bar.ts" */
function extractPathFromPatch(patch: string): string {
  const match = patch.match(/^diff --git a\/(.*?) b\/(.*)/m);
  if (match) return match[2];
  return "unknown";
}

/** Count additions and deletions from a patch */
function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}

/** Build file entries for working changes */
function buildWorkingEntries(data: DiffData): FileEntry[] {
  const entries: FileEntry[] = [];

  if (data.staged.trim()) {
    for (const patch of splitPatch(data.staged)) {
      const path = extractPathFromPatch(patch);
      const { additions, deletions } = countChanges(patch);
      entries.push({
        id: `staged:${path}`,
        name: path.split("/").pop() || path,
        path,
        section: "staged",
        additions,
        deletions,
        patch,
      });
    }
  }

  if (data.unstaged.trim()) {
    for (const patch of splitPatch(data.unstaged)) {
      const path = extractPathFromPatch(patch);
      const { additions, deletions } = countChanges(patch);
      entries.push({
        id: `unstaged:${path}`,
        name: path.split("/").pop() || path,
        path,
        section: "unstaged",
        additions,
        deletions,
        patch,
      });
    }
  }

  for (const { path, content } of data.untracked) {
    const lineCount = content.split("\n").length;
    entries.push({
      id: `untracked:${path}`,
      name: path.split("/").pop() || path,
      path,
      section: "untracked",
      additions: lineCount,
      deletions: 0,
      content,
    });
  }

  return entries;
}

/** Build file entries for a specific commit */
function buildCommitEntries(commit: CommitInfo): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const patch of splitPatch(commit.diff)) {
    const path = extractPathFromPatch(patch);
    const { additions, deletions } = countChanges(patch);
    entries.push({
      id: `commit:${commit.hash}:${path}`,
      name: path.split("/").pop() || path,
      path,
      section: "committed",
      additions,
      deletions,
      patch,
    });
  }
  return entries;
}

/** Check if there are any working changes */
function hasWorkingChanges(data: DiffData): boolean {
  return (
    data.staged.trim().length > 0 ||
    data.unstaged.trim().length > 0 ||
    data.untracked.length > 0
  );
}

/** Send a message to the extension via Glimpse */
function sendToExtension(msg: any) {
  try {
    (window as any).webkit.messageHandlers.glimpse.postMessage(
      JSON.stringify(msg)
    );
  } catch {}
}

let commentIdCounter = 0;
function nextCommentId(): string {
  return `comment-${++commentIdCounter}`;
}

// ─── Inline Comment Form ───

function InlineCommentForm({
  onSubmit,
  onCancel,
  initialText,
}: {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  initialText?: string;
}) {
  const [text, setText] = useState(initialText || "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault();
      if (text.trim()) onSubmit(text.trim());
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="comment-form">
      <textarea
        ref={textareaRef}
        className="comment-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Leave a comment… (⌘Enter to submit, Esc to cancel)"
        rows={3}
      />
      <div className="comment-form-actions">
        <button className="comment-btn comment-btn-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="comment-btn comment-btn-submit"
          onClick={() => text.trim() && onSubmit(text.trim())}
          disabled={!text.trim()}
        >
          Comment
        </button>
      </div>
    </div>
  );
}

// ─── Comment Display ───

function CommentBubble({
  comment,
  onDelete,
  onEdit,
}: {
  comment: Comment;
  onDelete: (id: string) => void;
  onEdit: (id: string, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <InlineCommentForm
        initialText={comment.text}
        onSubmit={(text) => {
          onEdit(comment.id, text);
          setEditing(false);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="comment-bubble">
      <div className="comment-bubble-text">{comment.text}</div>
      <div className="comment-bubble-actions">
        <span className="comment-bubble-line">
          L{comment.lineNumber} · {comment.side === "additions" ? "new" : "old"}
        </span>
        <button
          className="comment-bubble-btn"
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
        <button
          className="comment-bubble-btn comment-bubble-btn-delete"
          onClick={() => onDelete(comment.id)}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ─── Gutter "+" Button (rendered by @pierre/diffs) ───

function GutterPlusButton({
  getHoveredLine,
  onClickAdd,
}: {
  getHoveredLine: () => { lineNumber: number; side: "additions" | "deletions" } | undefined;
  onClickAdd: (lineNumber: number, side: "additions" | "deletions") => void;
}) {
  return (
    <button
      className="gutter-plus-btn"
      onClick={() => {
        const hovered = getHoveredLine();
        if (hovered) onClickAdd(hovered.lineNumber, hovered.side);
      }}
    >
      +
    </button>
  );
}

// ─── Sidebar ───

function SidebarFile({
  file,
  active,
  tabbed,
  commentCount,
  onClick,
}: {
  file: FileEntry;
  active: boolean;
  tabbed: boolean;
  commentCount: number;
  onClick: () => void;
}) {
  const color = SECTION_COLORS[file.section];
  return (
    <div
      className={`sidebar-file ${active ? "active" : ""}`}
      onClick={onClick}
      style={active ? { borderLeftColor: color } : undefined}
    >
      <div className="sidebar-file-name" title={file.path}>
        {file.name}
        {tabbed && <span className="sidebar-file-tab-dot" style={{ background: color }} />}
      </div>
      <div className="sidebar-file-path">{file.path !== file.name ? file.path : ""}</div>
      <div className="sidebar-file-stats">
        {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
        {file.deletions > 0 && <span className="stat-del">−{file.deletions}</span>}
        {commentCount > 0 && <span className="stat-comments">💬 {commentCount}</span>}
      </div>
    </div>
  );
}

function SidebarSection({
  section,
  files,
  activeId,
  openTabIds,
  commentCounts,
  onFileClick,
}: {
  section: "staged" | "unstaged" | "untracked";
  files: FileEntry[];
  activeId: string | null;
  openTabIds: Set<string>;
  commentCounts: Map<string, number>;
  onFileClick: (file: FileEntry) => void;
}) {
  if (files.length === 0) return null;
  const color = SECTION_COLORS[section];
  const label = SECTION_LABELS[section];

  return (
    <div className="sidebar-section">
      <div className="sidebar-section-header">
        <span className="sidebar-section-dot" style={{ background: color }} />
        <span className="sidebar-section-label">{label}</span>
        <span className="sidebar-section-count">{files.length}</span>
      </div>
      {files.map((f) => (
        <SidebarFile
          key={f.id}
          file={f}
          active={f.id === activeId}
          tabbed={openTabIds.has(f.id)}
          commentCount={commentCounts.get(f.path) || 0}
          onClick={() => onFileClick(f)}
        />
      ))}
    </div>
  );
}

// ─── Commit List ───

function CommitList({
  data,
  selectedCommitId,
  workingFileCount,
  onSelect,
}: {
  data: DiffData;
  selectedCommitId: string;
  workingFileCount: number;
  onSelect: (id: string) => void;
}) {
  const dirty = hasWorkingChanges(data);

  return (
    <div className="commit-list">
      <div className="sidebar-section-header">
        <span className="sidebar-section-label">Commits</span>
      </div>

      {dirty && (
        <div
          className={`commit-entry commit-entry-working ${selectedCommitId === "working" ? "active" : ""}`}
          onClick={() => onSelect("working")}
          style={selectedCommitId === "working" ? { borderLeftColor: "#E5C07B" } : undefined}
        >
          <div className="commit-entry-label">
            <span className="commit-dot" style={{ background: "#E5C07B" }} />
            Working Changes
            <span className="commit-count">{workingFileCount}</span>
          </div>
        </div>
      )}

      {data.commits.map((commit) => {
        const isActive = selectedCommitId === commit.hash;
        return (
          <div
            key={commit.hash}
            className={`commit-entry ${isActive ? "active" : ""}`}
            onClick={() => onSelect(commit.hash)}
            style={isActive ? { borderLeftColor: "rgba(255,255,255,0.3)" } : undefined}
          >
            <div className="commit-info">
              <span className="commit-hash">{commit.hash.slice(0, 7)}</span>
              <span className="commit-message">{commit.message}</span>
              <span className="commit-time">{commit.time}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Tabs ───

function TabBar({
  tabs,
  activeId,
  filesMap,
  commentCounts,
  onSelect,
  onClose,
}: {
  tabs: string[];
  activeId: string | null;
  filesMap: Map<string, FileEntry>;
  commentCounts: Map<string, number>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map((id) => {
        const file = filesMap.get(id);
        if (!file) return null;
        const color = SECTION_COLORS[file.section];
        const isActive = id === activeId;
        const count = commentCounts.get(file.path) || 0;

        return (
          <div
            key={id}
            className={`tab ${isActive ? "tab-active" : ""}`}
            onClick={() => onSelect(id)}
          >
            <span className="tab-dot" style={{ background: color }} />
            <span className="tab-name">{file.name}</span>
            {count > 0 && <span className="tab-comment-count">{count}</span>}
            <span
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(id);
              }}
            >
              ×
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Diff Content with Comments ───

function DiffView({
  file,
  comments,
  pendingComment,
  onAddComment,
  onDeleteComment,
  onEditComment,
  onStartComment,
  onCancelComment,
  splitView,
}: {
  file: FileEntry;
  comments: Comment[];
  pendingComment: { lineNumber: number; side: "additions" | "deletions" } | null;
  onAddComment: (lineNumber: number, side: "additions" | "deletions", text: string) => void;
  onDeleteComment: (id: string) => void;
  onEditComment: (id: string, text: string) => void;
  onStartComment: (lineNumber: number, side: "additions" | "deletions") => void;
  onCancelComment: () => void;
  splitView: boolean;
}) {
  // Build line annotations from existing comments + pending comment form
  const lineAnnotations: DiffLineAnnotation<string>[] = useMemo(() => {
    const annos: DiffLineAnnotation<string>[] = [];

    // Group comments by line+side
    const grouped = new Map<string, Comment[]>();
    for (const c of comments) {
      const key = `${c.side}:${c.lineNumber}`;
      const arr = grouped.get(key) || [];
      arr.push(c);
      grouped.set(key, arr);
    }

    for (const [key, group] of grouped) {
      const [side, lineStr] = key.split(":");
      annos.push({
        side: side as "additions" | "deletions",
        lineNumber: parseInt(lineStr),
        metadata: `comments:${JSON.stringify(group.map((c) => c.id))}`,
      });
    }

    // Add pending comment annotation
    if (pendingComment) {
      const existingKey = `${pendingComment.side}:${pendingComment.lineNumber}`;
      // Only add a separate annotation if there's no existing comments annotation at this line
      if (!grouped.has(existingKey)) {
        annos.push({
          side: pendingComment.side,
          lineNumber: pendingComment.lineNumber,
          metadata: "pending",
        });
      }
    }

    return annos;
  }, [comments, pendingComment]);

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<string>) => {
      const meta = annotation.metadata || "";
      const lineComments = comments.filter(
        (c) =>
          c.lineNumber === annotation.lineNumber && c.side === annotation.side
      );
      const isPendingLine =
        pendingComment &&
        pendingComment.lineNumber === annotation.lineNumber &&
        pendingComment.side === annotation.side;

      return (
        <div className="annotation-container">
          {lineComments.map((c) => (
            <CommentBubble
              key={c.id}
              comment={c}
              onDelete={onDeleteComment}
              onEdit={onEditComment}
            />
          ))}
          {isPendingLine && (
            <InlineCommentForm
              onSubmit={(text) =>
                onAddComment(annotation.lineNumber, annotation.side, text)
              }
              onCancel={onCancelComment}
            />
          )}
          {!isPendingLine && lineComments.length > 0 && (
            <button
              className="comment-reply-btn"
              onClick={() =>
                onStartComment(annotation.lineNumber, annotation.side)
              }
            >
              Reply
            </button>
          )}
        </div>
      );
    },
    [comments, pendingComment, onAddComment, onDeleteComment, onEditComment, onStartComment, onCancelComment]
  );

  const renderGutterUtility = useCallback(
    (getHoveredLine: () => { lineNumber: number; side: "additions" | "deletions" } | undefined) => (
      <GutterPlusButton getHoveredLine={getHoveredLine} onClickAdd={onStartComment} />
    ),
    [onStartComment]
  );

  const opts: FileDiffOptions<string> = useMemo(
    () => ({
      ...diffOptions,
      diffStyle: splitView ? "split" as const : "unified" as const,
      enableGutterUtility: true,
    }),
    [splitView]
  );

  if (file.section === "untracked") {
    return (
      <div className="diff-content">
        <MultiFileDiff
          oldFile={{ name: file.path, contents: "" }}
          newFile={{ name: file.path, contents: file.content || "" }}
          options={opts}
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          renderGutterUtility={renderGutterUtility}
        />
      </div>
    );
  }

  return (
    <div className="diff-content">
      <PatchDiff
        patch={file.patch || ""}
        options={opts}
        lineAnnotations={lineAnnotations}
        renderAnnotation={renderAnnotation}
        renderGutterUtility={renderGutterUtility}
      />
    </div>
  );
}

// ─── Comment Summary Panel ───

function CommentSummary({
  comments,
  onDeleteComment,
}: {
  comments: Comment[];
  onDeleteComment: (id: string) => void;
}) {
  if (comments.length === 0) return null;

  const grouped = new Map<string, Comment[]>();
  for (const c of comments) {
    const arr = grouped.get(c.filePath) || [];
    arr.push(c);
    grouped.set(c.filePath, arr);
  }

  return (
    <div className="comment-summary">
      <div className="comment-summary-header">
        <span className="comment-summary-icon">💬</span>
        <span className="comment-summary-count">
          {comments.length} comment{comments.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="comment-summary-list">
        {Array.from(grouped.entries()).map(([filePath, fileComments]) => (
          <div key={filePath} className="comment-summary-file">
            <div className="comment-summary-file-name">{filePath}</div>
            {fileComments.map((c) => (
              <div key={c.id} className="comment-summary-item">
                <span className="comment-summary-line">L{c.lineNumber}</span>
                <span className="comment-summary-text">{c.text}</span>
                <button
                  className="comment-bubble-btn comment-bubble-btn-delete"
                  onClick={() => onDeleteComment(c.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ───

function App({ data }: { data: DiffData }) {
  const dirty = hasWorkingChanges(data);
  const defaultCommitId = dirty ? "working" : (data.commits[0]?.hash ?? "working");

  const [selectedCommitId, setSelectedCommitId] = useState<string>(defaultCommitId);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [pendingComment, setPendingComment] = useState<{
    fileId: string;
    lineNumber: number;
    side: "additions" | "deletions";
  } | null>(null);
  const [splitView, setSplitView] = useState(false);

  // Toggle split/unified with 's' key (when not typing in a textarea)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      if (e.key === "s" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setSplitView((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Validate selectedCommitId when data changes
  useEffect(() => {
    if (selectedCommitId === "working") return;
    const stillExists = data.commits.some((c) => c.hash === selectedCommitId);
    if (!stillExists) {
      const newDefault = hasWorkingChanges(data) ? "working" : (data.commits[0]?.hash ?? "working");
      setSelectedCommitId(newDefault);
    }
  }, [data]);

  // Files for current selection
  const files = useMemo(() => {
    if (selectedCommitId === "working") return buildWorkingEntries(data);
    const commit = data.commits.find((c) => c.hash === selectedCommitId);
    return commit ? buildCommitEntries(commit) : [];
  }, [selectedCommitId, data]);

  const filesMap = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const workingFileCount = useMemo(() => buildWorkingEntries(data).length, [data]);

  // Comment counts per file path
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of comments) {
      counts.set(c.filePath, (counts.get(c.filePath) || 0) + 1);
    }
    return counts;
  }, [comments]);

  // When commit selection changes, reset tabs and auto-select first file
  useEffect(() => {
    if (files.length > 0) {
      const first = files[0];
      setOpenTabs([first.id]);
      setActiveId(first.id);
    } else {
      setOpenTabs([]);
      setActiveId(null);
    }
    setPendingComment(null);
  }, [selectedCommitId, files]);

  // When data updates (same commit), clean up tabs that no longer exist
  useEffect(() => {
    const validIds = new Set(files.map((f) => f.id));
    setOpenTabs((prev) => prev.filter((id) => validIds.has(id)));
    setActiveId((prev) => {
      if (prev && validIds.has(prev)) return prev;
      return files[0]?.id || null;
    });
  }, [files]);

  const handleFileClick = useCallback((file: FileEntry) => {
    setOpenTabs((prev) => (prev.includes(file.id) ? prev : [...prev, file.id]));
    setActiveId(file.id);
    setPendingComment(null);
  }, []);

  const handleTabSelect = useCallback((id: string) => {
    setActiveId(id);
    setPendingComment(null);
  }, []);

  const handleTabClose = useCallback(
    (id: string) => {
      setOpenTabs((prev) => {
        const next = prev.filter((t) => t !== id);
        if (activeId === id) {
          const idx = prev.indexOf(id);
          const newActive = next[Math.min(idx, next.length - 1)] || null;
          setTimeout(() => setActiveId(newActive), 0);
        }
        return next;
      });
    },
    [activeId]
  );

  // Comment handlers
  const handleStartComment = useCallback(
    (lineNumber: number, side: "additions" | "deletions") => {
      if (!activeId) return;
      setPendingComment({ fileId: activeId, lineNumber, side });
    },
    [activeId]
  );

  const handleAddComment = useCallback(
    (lineNumber: number, side: "additions" | "deletions", text: string) => {
      if (!activeId) return;
      const file = filesMap.get(activeId);
      if (!file) return;

      const comment: Comment = {
        id: nextCommentId(),
        filePath: file.path,
        lineNumber,
        side,
        text,
      };

      setComments((prev) => [...prev, comment]);
      setPendingComment(null);

      // Send to extension
      sendToExtension({ type: "comment-added", comment });
    },
    [activeId, filesMap]
  );

  const handleDeleteComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
    sendToExtension({ type: "comment-deleted", commentId: id });
  }, []);

  const handleEditComment = useCallback((id: string, text: string) => {
    setComments((prev) =>
      prev.map((c) => (c.id === id ? { ...c, text } : c))
    );
    sendToExtension({ type: "comment-edited", commentId: id, text });
  }, []);

  const handleCancelComment = useCallback(() => {
    setPendingComment(null);
  }, []);

  const grouped = useMemo(() => {
    const staged = files.filter((f) => f.section === "staged");
    const unstaged = files.filter((f) => f.section === "unstaged");
    const untracked = files.filter((f) => f.section === "untracked");
    return { staged, unstaged, untracked };
  }, [files]);

  const openTabSet = useMemo(() => new Set(openTabs), [openTabs]);
  const activeFile = activeId ? filesMap.get(activeId) : null;
  const totalFiles = files.length;

  const handleCommitSelect = useCallback((id: string) => {
    setSelectedCommitId(id);
  }, []);

  if (!dirty && data.commits.length === 0) {
    return <div className="empty-state">No changes</div>;
  }

  return (
    <div className="layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          {data.branch && (
            <span className="sidebar-branch">{data.branch}</span>
          )}
          <span className="sidebar-count">{totalFiles} file{totalFiles !== 1 ? "s" : ""}</span>
        </div>

        <CommitList
          data={data}
          selectedCommitId={selectedCommitId}
          workingFileCount={workingFileCount}
          onSelect={handleCommitSelect}
        />

        <div className="sidebar-files">
          {selectedCommitId === "working" ? (
            (["staged", "unstaged", "untracked"] as const).map((s) => (
              <SidebarSection
                key={s}
                section={s}
                files={grouped[s]}
                activeId={activeId}
                openTabIds={openTabSet}
                commentCounts={commentCounts}
                onFileClick={handleFileClick}
              />
            ))
          ) : (
            files.map((f) => (
              <SidebarFile
                key={f.id}
                file={f}
                active={f.id === activeId}
                tabbed={openTabSet.has(f.id)}
                commentCount={commentCounts.get(f.path) || 0}
                onClick={() => handleFileClick(f)}
              />
            ))
          )}
        </div>

        <CommentSummary
          comments={comments}
          onDeleteComment={handleDeleteComment}
        />
      </div>

      {/* Main panel */}
      <div className="main">
        {selectedCommitId !== "working" && (() => {
          const commit = data.commits.find((c) => c.hash === selectedCommitId);
          if (!commit) return null;
          return (
            <div className="commit-banner">
              <span className="commit-banner-hash">{commit.hash.slice(0, 7)}</span>
              <span className="commit-banner-message">{commit.message}</span>
              <span className="commit-banner-time">{commit.time}</span>
            </div>
          );
        })()}
        <TabBar
          tabs={openTabs}
          activeId={activeId}
          filesMap={filesMap}
          commentCounts={commentCounts}
          onSelect={handleTabSelect}
          onClose={handleTabClose}
        />
        <div className="main-content">
          {openTabs.map((id) => {
            const file = filesMap.get(id);
            if (!file) return null;
            const fileComments = comments.filter((c) => c.filePath === file.path);
            const pending =
              pendingComment && pendingComment.fileId === id
                ? { lineNumber: pendingComment.lineNumber, side: pendingComment.side }
                : null;

            return (
              <div
                key={id}
                className="tab-panel"
                style={{ display: id === activeId ? "block" : "none" }}
              >
                <DiffView
                  file={file}
                  comments={fileComments}
                  pendingComment={pending}
                  onAddComment={handleAddComment}
                  onDeleteComment={handleDeleteComment}
                  onEditComment={handleEditComment}
                  onStartComment={handleStartComment}
                  onCancelComment={handleCancelComment}
                  splitView={splitView}
                />
              </div>
            );
          })}
          {openTabs.length === 0 && (
            <div className="empty-state">Select a file from the sidebar</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Error boundary
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: "#ff6b6b", fontFamily: "monospace", fontSize: 13 }}>
          <h3 style={{ marginBottom: 10 }}>Render Error</h3>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {this.state.error.message}
            {"\n\n"}
            {this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = createRoot(document.getElementById("app")!);

window.updateCrit = (data: DiffData) => {
  const loading = document.getElementById("loading");
  if (loading) loading.style.display = "none";
  document.getElementById("app")!.style.display = "block";
  root.render(
    <ErrorBoundary>
      <App data={data} />
    </ErrorBoundary>
  );
};

// Signal to Glimpse that the viewer bundle is loaded and ready
try {
  (window as any).webkit.messageHandlers.glimpse.postMessage(
    JSON.stringify({ type: "viewer-ready" })
  );
} catch {}
