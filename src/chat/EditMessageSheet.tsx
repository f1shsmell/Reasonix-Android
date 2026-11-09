/**
 * Rewriting a message and sending it in place of the original.
 *
 * The kernel answers this the way Studio's rewrite does: the conversation goes
 * back to the checkpoint before that turn and the edited words start it again.
 * Nothing is written here until send is tapped — backing out leaves the
 * conversation as it was.
 */

import { useEffect, useRef, useState } from "react";
import { useBackCloser } from "../app/backStack";

export function EditMessageSheet({
  text,
  busy,
  error,
  onCancel,
  onSend,
}: {
  text: string;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  const box = useRef<HTMLTextAreaElement>(null);
  useBackCloser(true, onCancel);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="sheet edit-message"
        role="dialog"
        aria-modal="true"
        aria-label="编辑消息"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>编辑消息</h2>
          <button type="button" className="iconbtn" onClick={onCancel} aria-label="关闭">
            ×
          </button>
        </div>
        <textarea
          ref={box}
          className="edit-message-text"
          value={draft}
          rows={4}
          aria-label="消息内容"
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="edit-message-note">这一轮之后的内容会被去掉，再用这条消息重新开始。</p>
        {error ? <div className="notice error">{error}</div> : null}
        <div className="edit-message-acts">
          <button type="button" className="btn" disabled={busy || !draft.trim()} onClick={() => onSend(draft.trim())}>
            {busy ? "正在重发…" : "发送"}
          </button>
          <button type="button" className="dismiss" onClick={onCancel}>
            取消
          </button>
        </div>
      </section>
    </div>
  );
}
