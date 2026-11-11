import { useEffect, useRef, useState } from "react";

/**
 * A turn's thinking as one folded line and, on tap, a bounded scrollable
 * window instead of the whole wall. Studio keeps a live thought to a six-line
 * tail window and a settled one behind a details fold; the phone gives both
 * the same height budget and lets the finger scroll it, following the tail
 * while the thought streams unless the reader scrolled away.
 */
export function ThoughtStrip({
  text,
  thoughtMs,
  running = false,
}: {
  text: string;
  thoughtMs?: number;
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const chars = [...text.trim()].length;

  useEffect(() => {
    const el = body.current;
    if (!open || !running || !follow.current || el === null) return;
    el.scrollTop = el.scrollHeight;
  }, [text, open, running]);

  if (!text.trim()) return null;
  const secs = thoughtMs !== undefined ? Math.round(thoughtMs / 1000) : undefined;
  const meta =
    secs !== undefined && !running ? `思考了 ${secs} 秒 · ${chars} 字` : `${chars} 字`;

  return (
    <div className={`thought${open ? " open" : ""}`}>
      <button
        type="button"
        className="thought-row"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={`activity-icon think${running ? " running" : ""}`} aria-hidden="true">
          ✳
        </span>
        <span className="thought-label">{running ? "思考中" : "深度思考"}</span>
        <span className="thought-meta">{meta}</span>
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </button>
      {open ? (
        <div
          className="thought-body"
          ref={body}
          onScroll={() => {
            const el = body.current;
            if (el === null) return;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
        >
          {text}
          {running ? <span className="thought-caret" aria-hidden="true" /> : null}
        </div>
      ) : null}
    </div>
  );
}