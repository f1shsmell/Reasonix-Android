import { useState } from "react";
import type { UpdateStatus } from "./update";
import { describeUpdate } from "./update";
import { ReleaseNotesSheet } from "./ReleaseNotesSheet";

export interface UpdateRowProps {
  status: UpdateStatus;
  onAction: () => void;
}

/**
 * One About row: the native updater's whole surface.
 *
 * A settings row fits one sentence, and a release note is longer than that —
 * its first line is also cut mid-clause where the markdown happens to wrap.
 * So a release that has notes gets a second row that opens the whole thing.
 * The two are siblings rather than nested: a button cannot hold a button, and
 * the group's hairline falls between any two children regardless.
 */
export function UpdateRow({ status, onAction }: UpdateRowProps) {
  const [notesOpen, setNotesOpen] = useState(false);
  const view = describeUpdate(status);
  const busy = status.kind === "checking" || status.kind === "downloading";
  const percent =
    status.kind === "downloading" && status.total > 0
      ? Math.min(100, Math.max(0, Math.round((status.transferred / status.total) * 100)))
      : null;
  const notes = status.kind === "available" ? status.notes.trim() : "";

  return (
    <>
      <button
        type="button"
        className={view.error ? "setting update-setting error" : "setting update-setting"}
        onClick={onAction}
        disabled={busy}
      >
        <span className="setting-main">
          <span className="setting-title">{view.title}</span>
          <span className="setting-sub">{view.sub}</span>
          {percent === null ? null : (
            <span className="update-meter" aria-hidden="true">
              <span style={{ width: `${percent}%` }} />
            </span>
          )}
        </span>
        {view.action ? (
          <>
            <span className="setting-value">{view.action}</span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </>
        ) : null}
      </button>
      {notes ? (
        <button
          type="button"
          className="setting update-notes-setting"
          onClick={() => setNotesOpen(true)}
        >
          <span className="setting-main">
            <span className="setting-title">查看完整更新说明</span>
          </span>
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </button>
      ) : null}
      {notesOpen && notes ? (
        <ReleaseNotesSheet
          version={status.kind === "available" ? status.version : ""}
          notes={notes}
          onClose={() => setNotesOpen(false)}
        />
      ) : null}
    </>
  );
}
