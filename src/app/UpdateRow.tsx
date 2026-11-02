import type { UpdateStatus } from "./update";
import { describeUpdate } from "./update";

export interface UpdateRowProps {
  status: UpdateStatus;
  onAction: () => void;
}

/** One About row: the native updater's whole surface. */
export function UpdateRow({ status, onAction }: UpdateRowProps) {
  const view = describeUpdate(status);
  const busy = status.kind === "checking" || status.kind === "downloading";
  const percent =
    status.kind === "downloading" && status.total > 0
      ? Math.min(100, Math.max(0, Math.round((status.transferred / status.total) * 100)))
      : null;

  return (
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
  );
}
