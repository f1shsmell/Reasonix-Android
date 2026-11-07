/**
 * How full this conversation's window is, and folding it.
 *
 * This belongs to a conversation, not to a computer: every pane has its own
 * window, and a phone can hold several at once. The settings screen used to show
 * this card from whichever runtime happened to be first in the list, so the
 * number was somebody else's.
 *
 * Read on open. A turn that just finished changes `used`, and a cached copy
 * would answer a question the person opened the sheet to ask.
 */

import { useCallback, useEffect, useState } from "react";
import { useBackCloser } from "../app/backStack";
import { compactContext, loadContext } from "../net/context";
import type { ContextSnapshot } from "../net/context";
import { compactCount } from "../app/format";

export interface ContextSheetProps {
  /** The runtime's request prefix, e.g. `/rt/r1`. */
  base: string;
  /** The caller re-reads history once a fold lands; it rewrites the transcript. */
  onCompacted: () => void;
  onClose: () => void;
}

function percent(used: number, window: number): number {
  if (window <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((used / window) * 100)));
}

/**
 * Why a read failed.
 *
 * Kept apart from the fold's wording below: the same 500 means two different
 * things on the two routes, and a read that timed out has nothing to do with
 * archiving anything.
 */
function readFailure(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "等电脑回应超时，检查连接后重试。";
    case "runtime.gone":
      return "这个会话已经关掉了，回列表里重新打开。";
    default:
      return `读不到上下文用量：${code}`;
  }
}

/** Why a fold was refused, in words the person can act on. */
function foldFailure(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "等电脑回应超时。归档要写这台电脑的磁盘，稍后重试一次。";
    case "http.409":
      // The kernel answers 409 when the fold was declined — there is nothing
      // worth folding in this transcript. It is not a busy signal: that one
      // is a 500 (see below).
      return "这次没有可压缩的内容。";
    case "http.500":
      // A running turn is reported here too, and the kernel words it as a
      // plain-text body rather than a code. Both cases ask for the same thing,
      // so the sentence covers both without parsing that text.
      return "压缩没完成。如果这一轮还在跑，等它停下来再试。";
    default:
      return `压缩不了：${code}`;
  }
}

/**
 * The classes the kernel reports, in the order a person would fix them.
 *
 * "output" is what a tool returned and is usually the biggest — the kernel's own
 * comment says opening that class to the message that made it heavy is the half
 * a user can act on. The labels stay short because they sit in a value column.
 */
type CountedClass = "output" | "tools" | "system" | "user" | "reply";

const CLASSES: ReadonlyArray<{ key: CountedClass; label: string }> = [
  { key: "output", label: "命令输出" },
  { key: "tools", label: "工具说明" },
  { key: "system", label: "系统提示" },
  { key: "user", label: "你的消息" },
  { key: "reply", label: "回答" },
];

export function ContextSheet({ base, onCompacted, onClose }: ContextSheetProps) {
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** What a fold did, when it did not simply succeed. */
  const [note, setNote] = useState("");
  useBackCloser(true, onClose);

  const reload = useCallback(() => {
    setError("");
    void loadContext(base).then((result) => {
      if (!result.ok) {
        setError(readFailure(result.code));
        return;
      }
      setContext(result.context);
    });
  }, [base]);

  useEffect(reload, [reload]);

  const fold = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNote("");
    const result = await compactContext(base);
    setBusy(false);
    if (!result.ok) {
      setError(foldFailure(result.code));
      return;
    }
    if (!result.compacted) {
      // A declined fold is an answer about this transcript, not a fault.
      setNote(result.detail || "这次没有可压缩的内容。");
      return;
    }
    onCompacted();
    // Re-read rather than guess the new size: the fold's saving depends on what
    // it archived, and only the kernel knows that.
    reload();
  }, [base, busy, onCompacted, reload]);

  const used = context ? percent(context.used, context.window) : 0;
  const warn = context !== null && used >= 80;
  const rows = context
    ? CLASSES.map((entry) => ({
        label: entry.label,
        tokens: context[entry.key] as number,
      })).filter((row) => row.tokens > 0)
    : [];

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="上下文"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>上下文</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        {error ? <div className="notice error">{error}</div> : null}
        {note ? <div className="notice">{note}</div> : null}

        {context === null && !error ? <div className="meta">正在读取上下文用量…</div> : null}

        {context !== null ? (
          <>
            <p className="sheet-label">这一轮对话</p>
            <div className="context-figure">
              <span className="context-total">
                {compactCount(context.used)} / {compactCount(context.window)}
              </span>
              <span className={`context-percent${warn ? " warn" : ""}`}>{used}%</span>
            </div>
            <span className={`context-bar${warn ? " warn" : ""}`} aria-hidden="true">
              <i style={{ width: `${used}%` }} />
            </span>
            <p className="meta sheet-note">
              {context.compactAt > 0
                ? `到 ${compactCount(context.compactAt)} 自动压缩（窗口的 ${percent(
                    context.compactAt,
                    context.window,
                  )}%）`
                : "这个会话不自动压缩"}
            </p>

            {rows.length > 0 ? (
              <>
                <p className="sheet-label">占用明细</p>
                <ul className="context-rows">
                  {rows.map((row) => (
                    <li key={row.label}>
                      <span>{row.label}</span>
                      <span>{compactCount(row.tokens)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <button
              type="button"
              className="context-compact"
              onClick={() => void fold()}
              disabled={busy}
            >
              {busy ? "正在归档…" : "压缩现在"}
            </button>
            <p className="meta sheet-note">
              压缩会把这一轮之前的内容归档到这台电脑，对话里只留一条简短的指针；
              原文不会删除。只影响这个会话。
            </p>
          </>
        ) : null}
      </section>
    </div>
  );
}
