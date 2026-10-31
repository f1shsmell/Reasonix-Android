/**
 * What a long press on a conversation offers.
 *
 * The sheet is shared by the recent list and a project's conversation list.
 * Both show the same stored transcript, so both must offer the same decisions:
 * open, rename, pin, delete. The writes go to the kernel and the caller
 * re-reads the tree; this sheet only reports the result and closes on success.
 */

import { useState } from "react";
import type { TreeWrite } from "../net/pin";
import { treeWriteMessage } from "../net/pin";
import { useBackCloser } from "./backStack";

export interface SessionSheetProps {
  title: string;
  projectName: string;
  /** A relative timestamp, already formatted by the caller. */
  when?: string | undefined;
  pinned: boolean;
  /** The row is opening a pane; opening again would race it. */
  busy?: boolean;
  onClose: () => void;
  onOpen: () => void;
  onTogglePin: () => Promise<TreeWrite>;
  onRename: (title: string) => Promise<TreeWrite>;
  onRemove: () => Promise<TreeWrite>;
}

type Mode = "actions" | "rename" | "delete";

export function SessionSheet({
  title,
  projectName,
  when,
  pinned,
  busy = false,
  onClose,
  onOpen,
  onTogglePin,
  onRename,
  onRemove,
}: SessionSheetProps) {
  const [mode, setMode] = useState<Mode>("actions");
  const [nextTitle, setNextTitle] = useState(title);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  useBackCloser(true, onClose);

  const run = async (action: () => Promise<TreeWrite>) => {
    if (working) return;
    setWorking(true);
    setError("");
    const result = await action();
    setWorking(false);
    if (!result.ok) {
      setError(treeWriteMessage(result.code));
      return;
    }
    onClose();
  };

  const rename = nextTitle.trim();
  const canRename = !working && rename !== "" && rename !== title.trim();

  return (
    <div className="sheet-backdrop" role="presentation" onPointerDown={onClose}>
      <section
        className="sheet session-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="会话操作"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{mode === "rename" ? "重命名会话" : mode === "delete" ? "删除会话" : title}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="meta">
          {[projectName, when].filter(Boolean).join(" · ")}
        </p>

        {error ? <div className="notice error">{error}</div> : null}

        {mode === "actions" ? (
          <ul className="sheet-actions">
            <li>
              <button type="button" onClick={onOpen} disabled={busy || working}>
                打开会话
              </button>
            </li>
            <li>
              <button type="button" onClick={() => setMode("rename")} disabled={working}>
                重命名
              </button>
            </li>
            <li>
              <button
                type="button"
                aria-pressed={pinned}
                disabled={working}
                onClick={() => void run(onTogglePin)}
              >
                {pinned ? "取消置顶" : "置顶会话"}
              </button>
            </li>
            <li>
              <button
                type="button"
                className="danger"
                onClick={() => setMode("delete")}
                disabled={working}
              >
                删除会话
              </button>
            </li>
          </ul>
        ) : null}

        {mode === "rename" ? (
          <>
            <label className="sheet-field">
              <span className="group-label">标题</span>
              <input
                className="sheet-input"
                value={nextTitle}
                onChange={(event) => setNextTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canRename) void run(() => onRename(rename));
                }}
                maxLength={120}
                autoFocus
              />
            </label>
            <div className="sheet-foot">
              <button type="button" onClick={() => setMode("actions")} disabled={working}>
                取消
              </button>
              <button
                type="button"
                className="primary"
                disabled={!canRename}
                onClick={() => void run(() => onRename(rename))}
              >
                {working ? "正在保存…" : "保存"}
              </button>
            </div>
          </>
        ) : null}

        {mode === "delete" ? (
          <>
            <p className="sheet-warning">
              删除后这个会话的转录会从电脑上移除，不能撤销。正在运行的会话不能删除。
            </p>
            <div className="sheet-foot">
              <button type="button" onClick={() => setMode("actions")} disabled={working}>
                取消
              </button>
              <button
                type="button"
                className="danger solid"
                disabled={working}
                onClick={() => void run(onRemove)}
              >
                {working ? "正在删除…" : "删除会话"}
              </button>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
