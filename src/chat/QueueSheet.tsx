/**
 * The messages waiting for the running turn to finish.
 *
 * A queued line is held by the kernel, not by this screen: the phone shows a
 * receipt ("已排队，第 3 位") and then has nothing to point at. The list is
 * what makes that receipt checkable — what is in the queue, in what order, and
 * what each entry actually says.
 *
 * Two steps, like the checkpoints sheet: the list carries the kernel's own
 * 120-character preview, and the full body is a second request. A preview cut
 * mid-sentence is not something a person can judge, so the detail is where the
 * text is read, the frozen references are named, and the reason an entry is
 * blocked is spelled out.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useBackCloser } from "../app/backStack";
import { inboxMessage, loadInbox, loadInboxItem } from "../net/inbox";
import type { InboxDetail, InboxItem, InboxSnapshot } from "../net/inbox";

/** What the kernel's lifecycle name means in a row. */
export function stateLabel(state: string): string {
  switch (state) {
    case "queued":
      return "等待";
    case "steer_accepted":
      return "已插入";
    case "steer_consumed":
      return "已用";
    case "running":
      return "运行中";
    case "blocked":
      return "受阻";
    case "uncertain":
      return "待确认";
    default:
      return state || "未知";
  }
}

/** A blocked entry's reason, in the words the person can act on. */
export function blockText(code: string | undefined, reason: string | undefined): string {
  switch (code) {
    case "steer_unapplied":
      return "这一轮已经走过了可以插话的位置，等它结束再发。";
    case "reference_blocked":
      return "这条引用的文件变了，发出去会读到别的内容。";
    case "foreign_run":
      return "这条属于另一轮，不能在这个会话里发。";
    default:
      return reason || "";
  }
}

/** `queued · 3 分钟前`, or as much of it as the kernel supplied. */
export function whenText(createdAt: string | undefined, now: number): string {
  if (!createdAt) return "";
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function sizeText(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One reference, as the item froze it: a path when it has one, a kind when not. */
function refText(ref: { kind: string; path?: string; displayPath?: string }): string {
  return ref.displayPath || ref.path || ref.kind;
}

export function QueueSheet({
  base,
  onClose,
}: {
  base: string;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<InboxSnapshot | null>(null);
  const [error, setError] = useState("");
  /** The item whose body is being read, and what came back. */
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<InboxDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  useBackCloser(true, onClose);

  /** A slower read of one item must not land on a newer one. */
  const request = useRef(0);
  /** A fixed clock per render: every row's "3 分钟前" agrees with its neighbours. */
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    void loadInbox(base).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(inboxMessage(result.code));
        return;
      }
      setSnapshot(result.snapshot);
      if (result.snapshot.unrecovered) setError(inboxMessage("inbox.unrecovered"));
    });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const toggle = useCallback(
    (entry: InboxItem) => {
      if (open === entry.id) {
        setOpen(null);
        setDetail(null);
        setDetailError("");
        return;
      }
      setOpen(entry.id);
      setDetail(null);
      setDetailError("");
      const at = ++request.current;
      setDetailBusy(true);
      void loadInboxItem(base, entry.id).then((result) => {
        if (at !== request.current) return;
        setDetailBusy(false);
        if (!result.ok) {
          setDetailError(inboxMessage(result.code));
          return;
        }
        setDetail(result.detail);
      });
    },
    [base, open],
  );

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet queue-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="排队列表"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>排队</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="sheet-note">
          这一轮结束后按顺序发出。点一行看完整内容；桌面端也能在这里暂停、改顺序或删掉一条。
        </p>

        {snapshot === null && !error ? <p className="sheet-note">正在读取队列…</p> : null}
        {snapshot !== null && snapshot.items.length === 0 && !error ? (
          <p className="sheet-note">队列是空的。</p>
        ) : null}
        {snapshot?.paused ? (
          <p className="sheet-note warn">队列已暂停，恢复前不会往下发。</p>
        ) : null}

        {snapshot !== null && snapshot.items.length > 0 ? (
          <ol className="queue-list">
            {snapshot.items.map((entry, index) => {
              const expanded = open === entry.id;
              const blocked = entry.state === "blocked";
              const when = whenText(entry.createdAt, now);
              const size = sizeText(entry.byteSize);
              return (
                <li key={entry.id} className={`queue-item${expanded ? " open" : ""}`}>
                  <button
                    type="button"
                    className="queue-row"
                    aria-expanded={expanded}
                    onClick={() => toggle(entry)}
                  >
                    <span className="queue-index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="queue-main">
                      <span className="queue-preview">
                        {entry.preview || "（没有文字）"}
                      </span>
                      <span className="queue-meta">
                        {entry.intent === "steer" ? "插话" : "排队"}
                        {entry.images ? " · 图片" : ""}
                        {size ? ` · ${size}` : ""}
                        {when ? ` · ${when}` : ""}
                      </span>
                    </span>
                    <span className={`queue-flag${blocked ? " bad" : ""}`}>
                      {stateLabel(entry.state)}
                    </span>
                    <span className="chev" aria-hidden="true">
                      ›
                    </span>
                  </button>

                  {expanded ? (
                    <div className="queue-detail">
                      {detailBusy ? <p className="sheet-note">正在读取…</p> : null}
                      {detailError ? <p className="sheet-note bad">{detailError}</p> : null}
                      {blocked && (entry.blockReason || entry.blockCode) ? (
                        <p className="queue-block">
                          {blockText(entry.blockCode, entry.blockReason)}
                        </p>
                      ) : null}
                      {detail ? (
                        <>
                          <div className="queue-body">{detail.displayText}</div>
                          {detail.submitText !== detail.displayText ? (
                            <details className="queue-actual">
                              <summary>实际发给模型的文本</summary>
                              <div className="queue-body">{detail.submitText}</div>
                            </details>
                          ) : null}
                          {detail.refs && detail.refs.length > 0 ? (
                            <>
                              <p className="sheet-label">引用</p>
                              <ul className="queue-refs">
                                {detail.refs.map((ref, at) => (
                                  <li key={`${ref.kind}:${ref.path ?? at}`}>{refText(ref)}</li>
                                ))}
                              </ul>
                            </>
                          ) : null}
                          {detail.images && detail.images.length > 0 ? (
                            <div className="message-images">
                              {detail.images.map((url, at) => (
                                <img
                                  key={at}
                                  className="message-image"
                                  src={url}
                                  alt={`附件 ${at + 1}`}
                                  loading="lazy"
                                />
                              ))}
                            </div>
                          ) : null}
                          {detail.referenceErrors && detail.referenceErrors.length > 0 ? (
                            <p className="sheet-note warn">
                              引用有问题：{detail.referenceErrors.join("；")}
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : null}

        {error ? <div className="notice error">{error}</div> : null}
      </section>
    </div>
  );
}
