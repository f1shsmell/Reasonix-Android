/**
 * One step of work, and the finished run it belongs to.
 *
 * A step is a row, not a card: icon, what it is, one line of detail, chevron.
 * The detail opens under it. A finished run of several steps collapses into a
 * single "已处理 N 个操作" row whose sheet shows the same steps as a timeline.
 */

import { useState } from "react";
import type { ProcessStep } from "./process";
import { processTitle } from "./process";
import { ToolDetail } from "./Rows";
import { toolLabel, toolSummary } from "./toolMeta";

export { toolLabel, toolSummary } from "./toolMeta";

function stepTitle(step: ProcessStep): string {
  return step.kind === "reasoning" ? "深度思考" : toolLabel(step.row.name);
}

function stepSummary(step: ProcessStep): string {
  if (step.kind === "reasoning") {
    return step.thoughtMs !== undefined ? `思考了 ${Math.round(step.thoughtMs / 1000)} 秒` : "";
  }
  return toolSummary(step.row);
}

/** One step, inline. Long reasoning opens the reading sheet instead. */
export function ActivityRow({
  step,
  onOpenSheet,
}: {
  step: ProcessStep;
  onOpenSheet: (step: ProcessStep) => void;
}) {
  const [open, setOpen] = useState(false);
  const reasoning = step.kind === "reasoning";
  const long = reasoning && step.text.length > 900;
  const failed = !reasoning && Boolean(step.row.err || step.row.refusalCode);
  const running = !reasoning && step.row.running;
  const summary = stepSummary(step);

  const toggle = () => {
    if (long) {
      onOpenSheet(step);
      return;
    }
    setOpen((was) => !was);
  };

  return (
    <div className={`activity${open ? " open" : ""}`}>
      <button
        type="button"
        className="activity-row"
        onClick={toggle}
        aria-expanded={long ? undefined : open}
      >
        <span className={`activity-icon ${reasoning ? "think" : "tool"}`} aria-hidden="true">
          {reasoning ? "✳" : "❯"}
        </span>
        <span className="activity-title">{stepTitle(step)}</span>
        {summary ? <span className="activity-summary">{summary}</span> : null}
        {failed ? <span className="activity-flag bad">失败</span> : null}
        {running ? <span className="activity-flag">运行中</span> : null}
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </button>
      {open ? (
        <div className="activity-detail">
          {reasoning ? (
            <>
              <div className="reasoning-text">{step.text}</div>
              <button type="button" className="linkbtn" onClick={() => onOpenSheet(step)}>
                单页阅读
              </button>
            </>
          ) : (
            <ToolDetail row={step.row} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A finished run: one row that opens the timeline. */
export function ProcessSummary({
  steps,
  onOpen,
}: {
  steps: ProcessStep[];
  onOpen: () => void;
}) {
  const failed = steps.some(
    (step) => step.kind === "tool" && Boolean(step.row.err || step.row.refusalCode),
  );
  const title = processTitle(steps);
  return (
    <button type="button" className="process-row" onClick={onOpen}>
      <span className={`activity-icon ${failed ? "bad" : "done"}`} aria-hidden="true">
        {failed ? "!" : "✓"}
      </span>
      <span className="process-title">{title}</span>
      <span className="process-count">{steps.length} 个操作</span>
      <span className="chev" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

/** The steps of one run, or one long thought, as a readable timeline. */
export function ProcessSheet({
  title,
  steps,
  onClose,
}: {
  title: string;
  steps: ProcessStep[];
  onClose: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet process-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <ol className="timeline">
          {steps.map((step) => {
            const expanded = open === step.id;
            const reasoning = step.kind === "reasoning";
            const failed = !reasoning && Boolean(step.row.err || step.row.refusalCode);
            const summary = stepSummary(step);
            return (
              <li key={step.id} className={`timeline-step${expanded ? " open" : ""}`}>
                <span
                  className={`timeline-mark ${reasoning ? "think" : failed ? "bad" : "done"}`}
                  aria-hidden="true"
                >
                  {reasoning ? "✳" : failed ? "!" : "✓"}
                </span>
                <button
                  type="button"
                  className="timeline-row"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : step.id)}
                >
                  <span className="timeline-title">{stepTitle(step)}</span>
                  {summary ? <span className="timeline-summary">{summary}</span> : null}
                  <span className="chev" aria-hidden="true">
                    ›
                  </span>
                </button>
                {expanded ? (
                  <div className="timeline-detail">
                    {reasoning ? (
                      <div className="reasoning-text">{step.text}</div>
                    ) : (
                      <ToolDetail row={step.row} />
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
