import { diffLines } from "./diffLines";

/**
 * One file's diff as the workbench draws it: each line numbered before and
 * after, the `@@` header kept, a click on a number asking for the file itself.
 * A port of the desktop's `UnifiedDiff`; the line-number buttons stay
 * non-focusable exactly as there — the affordance is visual, the row is not.
 */
export function WorkbenchDiff({
  diff,
  label,
  truncated = false,
  onOpenFile,
}: {
  diff: string;
  label: string;
  truncated?: boolean;
  onOpenFile?: () => void;
}) {
  const lines = diffLines(diff);
  if (lines.length === 0) return <p className="wb-wait">没有变更。</p>;
  return (
    <div className="wb-diff" role="table" aria-label={label}>
      {lines.map((line, index) => (
        <div key={index} className="wb-diff-line" data-mark={line.mark} role="row">
          <button
            type="button"
            className="wb-diff-n"
            tabIndex={-1}
            aria-hidden="true"
            onClick={onOpenFile}
          >
            {line.old ?? ""}
          </button>
          <button
            type="button"
            className="wb-diff-n"
            tabIndex={-1}
            aria-hidden="true"
            onClick={onOpenFile}
          >
            {line.now ?? ""}
          </button>
          <span className="wb-diff-mark">{line.mark === "@" ? "" : line.mark.trim()}</span>
          <span className="wb-diff-text">{line.text}</span>
        </div>
      ))}
      {truncated && <p className="wb-wait">diff 很长，只显示了开头的一部分。</p>}
    </div>
  );
}
