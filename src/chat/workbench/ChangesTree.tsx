import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ChangeDiff } from "../../wire/changes";
import { stagedState } from "./gittree";
import type { ChangeNode } from "./gittree";
import { WorkbenchDiff } from "./WorkbenchDiff";

/** One open diff slot, owned by the shell so a re-fetch can find it again. */
export interface DiffSlot {
  state: "loading" | "ready" | "error";
  diff?: ChangeDiff;
  code?: string;
}

/** The status letter's ink: added and untracked green, deleted red, the rest warn. */
function statusTone(status: string): string {
  if (status.includes("A") || status === "??") return "ok";
  if (status.includes("D")) return "err";
  return "warn";
}

/** How a file's counts draw: only when git counted them — a binary file prints
 *  nothing rather than "+0 −0", which would read as "changed by nothing".
 *  The props are nullable rather than optional: a folder's sums always exist
 *  (zero when nothing under it was counted), a file's may be absent. */
function Counts({
  insertions,
  deletions,
}: {
  insertions: number | undefined;
  deletions: number | undefined;
}) {
  if (insertions === undefined && deletions === undefined) return null;
  return (
    <span className="wb-counts">
      {insertions !== undefined && insertions !== 0 && <i data-io="up">{`+${insertions}`}</i>}
      {deletions !== undefined && deletions !== 0 && <i data-io="down">{`−${deletions}`}</i>}
    </span>
  );
}

function StageBox({
  state,
  disabled,
  onToggle,
  label,
}: {
  state: boolean | "mixed";
  disabled: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state}
      aria-label={label}
      className="wb-stage"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {state === true ? "✓" : state === "mixed" ? "–" : ""}
    </button>
  );
}

interface Walk {
  budget: { left: number };
  busy: boolean;
  readOnly: boolean;
  openPath: string | null;
  slots: Map<string, DiffSlot>;
  folded: Set<string>;
  onToggleFile: (path: string, current: boolean | "mixed") => void;
  onToggleFolder: (paths: string[], current: boolean | "mixed") => void;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
  onToggleFold: (path: string) => void;
}

/** Rows of one node and, for a folder, its children — folders first, each in
 *  name order, the draw budget counting every row drawn. */
function walk(node: ChangeNode, depth: number, walkState: Walk): ReactNode[] {
  const drawn: ReactNode[] = [];
  if (walkState.budget.left <= 0) return drawn;
  walkState.budget.left -= 1;
  if (node.kind === "folder") {
    const files = node.files;
    const state = stagedState(files);
    const paths = files.map((file) => file.path);
    const folded = walkState.folded.has(node.path);
    drawn.push(
      <div key={`d:${node.path}`} className="wb-row" data-node="folder" style={{ paddingLeft: depth * 14 }}>
        {!walkState.readOnly && (
          <StageBox
            state={state}
            disabled={walkState.busy}
            label={`暂存 ${node.name} 下的变更`}
            onToggle={() => walkState.onToggleFolder(paths, state)}
          />
        )}
        <button
          type="button"
          className="wb-row-main"
          aria-expanded={!folded}
          onClick={() => walkState.onToggleFold(node.path)}
        >
          <span className="wb-row-name">{node.name}</span>
          <span className="wb-row-meta">
            {`${files.length} 个文件`}
            <Counts insertions={node.insertions} deletions={node.deletions} />
          </span>
        </button>
      </div>,
    );
    if (!folded) {
      for (const child of node.children) {
        drawn.push(...walk(child, depth + 1, walkState));
        if (walkState.budget.left <= 0) return drawn;
      }
    }
    return drawn;
  }
  const entry = node.change;
  const open = walkState.openPath === node.path;
  const slot = open ? walkState.slots.get(node.path) : undefined;
  drawn.push(
    <div
      key={`f:${node.path}:${entry.status}:${entry.staged ? 1 : 0}`}
      className="wb-row"
      data-node="file"
      style={{ paddingLeft: depth * 14 }}
    >
      {!walkState.readOnly && (
        <StageBox
          state={stagedState([entry])}
          disabled={walkState.busy}
          label={`暂存 ${node.name}`}
          onToggle={() => walkState.onToggleFile(node.path, stagedState([entry]))}
        />
      )}
      <button
        type="button"
        className="wb-row-main"
        aria-current={open ? "page" : undefined}
        onClick={() => walkState.onOpenDiff(node.path)}
      >
        <span className="wb-row-name">
          <em data-status={statusTone(entry.status)}>{entry.status}</em>
          {node.name}
          {entry.oldPath && <span className="wb-oldpath">{` ← ${entry.oldPath}`}</span>}
        </span>
        <span className="wb-row-meta">
          <Counts insertions={entry.insertions} deletions={entry.deletions} />
        </span>
      </button>
      {open && (
        <div className="wb-row-diff">
          {slot === undefined && <p className="wb-wait">读取中…</p>}
          {slot?.state === "loading" && <p className="wb-wait">读取中…</p>}
          {slot?.state === "error" && <p className="wb-wait">{`没读出来：${slot.code ?? ""}`}</p>}
          {slot?.state === "ready" && slot.diff && (
            <WorkbenchDiff
              diff={slot.diff.diff}
              truncated={slot.diff.truncated === true}
              label={node.path}
              onOpenFile={() => walkState.onOpenFile(node.path)}
            />
          )}
        </div>
      )}
    </div>,
  );
  return drawn;
}

function countRows(nodes: ChangeNode[]): number {
  return nodes.reduce(
    (n, node) => n + (node.kind === "file" ? 1 : 1 + countRows(node.children)),
    0,
  );
}

interface TreeProps {
  nodes: ChangeNode[];
  busy: boolean;
  readOnly: boolean;
  openPath: string | null;
  slots: Map<string, DiffSlot>;
  /** Rows drawn before a "show more" line ends the list. */
  budget?: number;
  onToggleFile: (path: string, current: boolean | "mixed") => void;
  onToggleFolder: (paths: string[], current: boolean | "mixed") => void;
  onOpenDiff: (path: string) => void;
  onOpenFile: (path: string) => void;
}

/** The changes tree: folders first, each file with its own tri-state stage
 *  box, an open diff folded beneath its row, and an honest count of what a
 *  long list has not drawn. */
export function ChangesTree(props: TreeProps): React.JSX.Element {
  const [extra, setExtra] = useState(0);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // A new tree (a refresh, a repo switch) reads from the first page again.
  useEffect(() => {
    setExtra(0);
  }, [props.nodes]);
  const budget = { left: (props.budget ?? 500) + extra };
  const total = countRows(props.nodes);
  const walkState: Walk = {
    budget,
    busy: props.busy,
    readOnly: props.readOnly,
    openPath: props.openPath,
    slots: props.slots,
    folded,
    onToggleFile: props.onToggleFile,
    onToggleFolder: props.onToggleFolder,
    onOpenDiff: props.onOpenDiff,
    onOpenFile: props.onOpenFile,
    onToggleFold: (path) => {
      setFolded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
  };
  const drawn: ReactNode[] = [];
  for (const node of props.nodes) drawn.push(...walk(node, 0, walkState));
  // Rows actually drawn: the budget the walk consumed. The unspent remainder
  // is what the "show more" line counts — a fresh budget object per render
  // keeps the walk's mutation from leaking between renders.
  const drawnCount = (props.budget ?? 500) + extra - Math.max(budget.left, 0);
  return (
    <div className="wb-tree">
      {drawn}
      {budget.left <= 0 && drawnCount < total && (
        <button type="button" className="wb-more" onClick={() => setExtra((value) => value + 500)}>
          {`还有 ${total - drawnCount} 行未显示，显示更多`}
        </button>
      )}
    </div>
  );
}
