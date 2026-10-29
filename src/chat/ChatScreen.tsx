/**
 * The chat screen.
 *
 * It owns three things a row cannot: the scroll position, the composer, and the
 * send state. The transcript itself is a pure fold, so everything below this
 * file is testable without a browser.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Connection, ConnectionSnapshot } from "../net/connection";
import { cancel, submit } from "../net/submit";
import type { SendState } from "../net/submit";
import { clearDraft, loadDraft, saveDraft } from "./drafts";
import { MAX_IMAGE_MB, isolateImageRefs, uploadImage } from "../net/attachments";
import { answer, approve } from "../net/prompts";
import { loadHistory } from "../net/history";
import { loadTodos, todoRevision } from "../net/todos";
import type { WireTodo } from "../wire/todos";
import type { EventPayload } from "../wire/events";
import { closeApproval, emptyTranscript, markAnswered, optimisticUser, reduce, removeLocalUser } from "./transcript";
import type { Transcript } from "./transcript";
import {
  ApprovalCard,
  AskCard,
  AssistantBubble,
  NoticeCard,
  ToolCard,
  UserBubble,
} from "./Rows";
import type { PromptHandlers } from "./Rows";
import { TodoPanel } from "./TodoPanel";
import type { TodosState } from "./TodoPanel";

export interface ChatScreenProps {
  connection: Connection;
  snapshot: ConnectionSnapshot;
  runtimeId: string;
  onBack: () => void;
  /** Open the session/project sheet. */
  onNewSession?: () => void;
}

function imageMessage(code: string): string {
  switch (code) {
    case "attachment.too_large":
      return `图片太大，上限 ${MAX_IMAGE_MB} MB。`;
    case "attachment.unsupported_image":
      return "这个图片格式不支持。";
    case "attachment.write_failed":
      return "桌面端保存图片失败，检查磁盘空间和写入权限。";
    case "attachment.shape":
      return "桌面端返回了无法识别的图片。";
    case "client.offline":
      return "上传失败：连不上电脑。";
    default:
      return `上传失败：${code}`;
  }
}

/**
 * The transcript on screen: the stored conversation, then the live stream.
 *
 * Both are needed and neither stands alone. The kernel answers a first
 * connection with initial notices only — it does not replay the session — so
 * without the history read a session that has been running for days opens
 * empty. And the history read is a snapshot taken at one instant, so anything
 * that happens after it arrives as events.
 *
 * History is folded in as a prefix rather than replacing what is there: a frame
 * that landed while the read was in flight must not be thrown away, and it must
 * not end up above the messages it follows.
 */
function useTranscript(
  snapshot: ConnectionSnapshot,
  runtimeId: string,
  base: string | undefined,
): {
  transcript: Transcript;
  history: "loading" | "loaded" | "failed";
  setTranscript: React.Dispatch<React.SetStateAction<Transcript>>;
} {
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [history, setHistory] = useState<"loading" | "loaded" | "failed">("loading");
  const lastEvent = snapshot.lastEvent;

  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    setTranscript(emptyTranscript);
    setHistory("loading");
    void loadHistory(base).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        // A kernel that cannot answer is not a reason to fail the screen: the
        // stream still works, and an empty transcript with a live composer
        // beats no screen at all.
        setHistory("failed");
        return;
      }
      setTranscript((current) => ({ ...current, rows: [...result.rows, ...current.rows] }));
      setHistory("loaded");
    });
    return () => {
      cancelled = true;
    };
  }, [base, runtimeId]);

  useEffect(() => {
    if (!lastEvent) return;
    setTranscript((current) => reduce(current, lastEvent));
  }, [lastEvent]);

  return { transcript, history, setTranscript };
}

/**
 * The task list, read from the kernel rather than folded out of the transcript.
 *
 * Two facts make this a separate read. `complete_step` advances the list
 * without writing a `todo_write`, so the conversation is missing updates; and
 * a refused `todo_write` is still in the conversation, so folding it would
 * draw work the kernel never accepted. The frame is only a notification —
 * counters and three revision clocks — so the list itself always comes from
 * `GET /todos`.
 *
 * The three clocks are also the coalescing rule: frames whose clocks did not
 * move cannot have changed the answer, and a turn that emits one per step
 * must not become one request per step.
 */
interface TodoList {
  base: string;
  todos: WireTodo[];
  state: TodosState;
}

function useTodos(
  base: string | undefined,
  lastEvent: EventPayload | undefined,
): { todos: WireTodo[]; state: TodosState } {
  const [list, setList] = useState<TodoList | null>(null);
  const loadedBase = useRef<string | null>(null);
  const seenRevision = useRef("");
  const failed = useRef(false);
  const request = useRef(0);
  const progress = lastEvent?.kind === "todo_progress" ? lastEvent.todoProgress : undefined;
  const revision = todoRevision(progress);

  useEffect(() => {
    if (!base) return;
    const switched = base !== loadedBase.current;
    if (switched) {
      // Another pane's checklist is not this pane's. This records the new
      // base; the render below already hides the old list in the same commit,
      // because an effect runs after paint.
      loadedBase.current = base;
      seenRevision.current = "";
      failed.current = false;
      setList({ base, todos: [], state: "loading" });
    } else if (!progress || (revision === seenRevision.current && !failed.current)) {
      // Not a todo_progress frame, or a repeat whose clocks have not moved
      // and whose last read succeeded.
      return;
    }
    if (revision !== "") seenRevision.current = revision;

    // A newer read wins outright. Two can overlap — the screen's first load
    // and a frame that arrived while it was in flight — and an older answer
    // must not land on top of a newer one.
    const at = ++request.current;
    void loadTodos(base).then((result) => {
      if (at !== request.current) return;
      if (!result.ok) {
        // A failed read has not seen this revision. The next frame carrying
        // the same clocks is allowed to try again rather than waiting for a
        // clock to move.
        failed.current = true;
        setList((current) =>
          current?.base === base
            ? { ...current, state: "failed" }
            : { base, todos: [], state: "failed" },
        );
        return;
      }
      failed.current = false;
      setList({ base, todos: result.items, state: "loaded" });
    });
  }, [base, lastEvent, progress, revision]);

  // The first render after a base change still holds the old list — the effect
  // that clears it runs after paint. Hiding a mismatched list here is what
  // keeps one pane's checklist from flashing on another.
  const shown = base !== undefined && list?.base === base ? list : null;
  return { todos: shown?.todos ?? [], state: shown?.state ?? "loading" };
}

export function ChatScreen({ connection, snapshot, runtimeId, onBack, onNewSession }: ChatScreenProps) {
  const runtime = snapshot.runtimes.find((candidate) => candidate.id === runtimeId);
  const { transcript, history, setTranscript } = useTranscript(
    snapshot,
    runtimeId,
    runtime?.base,
  );
  const { todos, state: todosState } = useTodos(runtime?.base, snapshot.lastEvent);
  // App keys this screen by runtimeId, so this initial value is that pane's
  // draft and no other pane can read it. The save effect below mirrors every
  // keystroke to the same key.
  const [draft, setDraft] = useState(() => loadDraft(runtimeId));
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [promptError, setPromptError] = useState("");
  const [attachment, setAttachment] = useState<{ ref: string; name: string; url: string } | null>(null);
  const [attachError, setAttachError] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const imageRef = useRef<HTMLInputElement | null>(null);
  const lastRetry = useRef<string>("");

  // Attaching is the screen's job, not the caller's: a screen that is mounted
  // and not subscribed shows a still frame that looks like a hang.
  useEffect(() => {
    connection.attach(runtimeId);
    return () => connection.detach();
  }, [connection, runtimeId]);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Follow the newest row only while the person is already at the bottom.
  // Yanking the view down while they read back is the single worst thing a
  // streaming transcript can do.
  useLayoutEffect(() => {
    if (atBottom) scrollToBottom(false);
  }, [transcript.rows, atBottom, scrollToBottom]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
    setAtBottom(gap < 48);
  }, []);

  const grow = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, []);

  useEffect(() => {
    saveDraft(runtimeId, draft);
  }, [draft, runtimeId]);

  // A restored draft may be several lines; one row would hide most of it.
  useEffect(() => {
    const timer = window.setTimeout(grow, 0);
    return () => window.clearTimeout(timer);
  }, [grow]);

  // The preview URL is ours to release. Rerunning on every attachment change
  // revokes the image that was just replaced.
  useEffect(() => {
    const url = attachment?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment?.url]);

  // Editing the reference out of the draft is also removing the attachment;
  // otherwise the chip would stay but the turn would not mention the image.
  useEffect(() => {
    if (attachment && !draft.includes(attachment.ref)) setAttachment(null);
  }, [attachment, draft]);

  const pickImage = useCallback(() => {
    imageRef.current?.click();
  }, []);

  const onImage = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || !runtime) return;
      setAttachError("");
      setAttaching(true);
      const preview = URL.createObjectURL(file);
      const result = await uploadImage(runtime.base, file);
      if (!result.ok) {
        URL.revokeObjectURL(preview);
        setAttaching(false);
        setAttachError(imageMessage(result.code));
        return;
      }
      setAttaching(false);
      setAttachment({ ref: result.attachment.ref, name: file.name, url: preview });
      // The trailing newline is load-bearing: the caret goes to the end, so
      // anything typed next starts on its own line instead of becoming part
      // of the reference token.
      setDraft((current) => {
        const base = current.replace(/\s+$/, "");
        return base ? `${base}\n${result.attachment.ref}\n` : `${result.attachment.ref}\n`;
      });
      window.setTimeout(grow, 0);
    },
    [runtime, grow],
  );

  const removeAttachment = useCallback(() => {
    if (!attachment) return;
    setDraft((current) => current.replace(attachment.ref, "").replace(/[ \t]+\n/g, "\n").trimEnd());
    setAttachment(null);
    setAttachError("");
  }, [attachment]);

  const doSend = useCallback(
    async (text: string) => {
      if (!runtime) return;
      const outgoing = isolateImageRefs(text).trim();
      if (!outgoing) return;
      // The kernel takes a round trip to confirm a turn. Draw the person's own
      // words now; `turn_started` later confirms this row by matching its text
      // instead of appending a second copy.
      const local = optimisticUser(outgoing);
      setTranscript((current) => ({ ...current, rows: [...current.rows, local] }));
      setSend({ kind: "sending" });
      const result = await submit(runtime.base, outgoing);
      if (result.ok) {
        setSend({ kind: "sent" });
        clearDraft(runtimeId);
        setDraft("");
        setAttachment(null);
        setAttachError("");
        lastRetry.current = "";
        // The turn itself will report through the stream; the composer clears
        // now so the next thought can be typed while the answer arrives.
        requestAnimationFrame(() => {
          if (inputRef.current) inputRef.current.style.height = "auto";
        });
        scrollToBottom(true);
        return;
      }
      setSend({
        kind: "failed",
        detail: result.code ?? "unknown",
        retryable: result.retryable === true,
      });
      setTranscript((current) => removeLocalUser(current, local.id));
      lastRetry.current = outgoing;
    },
    [runtime, scrollToBottom],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends, Shift+Enter breaks the line. On a phone keyboard Enter is
      // the send key people expect; the desktop convention is the fallback.
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (send.kind !== "sending" && draft.trim()) void doSend(draft);
      }
    },
    [draft, doSend, send.kind],
  );

  const handlers = useMemo<PromptHandlers>(
    () => ({
      onAnswer: (askId, selected) => {
        if (!runtime) return;
        const answers = Object.entries(selected).map(([questionId, labels]) => ({
          QuestionID: questionId,
          Selected: labels,
        }));
        // The row is marked answered only once the kernel says so. Optimism
        // here would show a question as settled when the POST was refused —
        // and the kernel's refusal is exactly what the person needs to see.
        void answer(runtime.base, askId, answers).then((result) => {
          if (!result.ok) {
            setPromptError(`没答上：${result.code ?? "unknown"}`);
            return;
          }
          setPromptError("");
          setTranscript((current) => markAnswered(current, askId, selected));
        });
      },
      onApprove: (approvalId, allow, session, persist) => {
        if (!runtime) return;
        void approve(runtime.base, approvalId, allow, session, persist).then((result) => {
          if (!result.ok) {
            setPromptError(`没处理成：${result.code ?? "unknown"}`);
            return;
          }
          setPromptError("");
          setTranscript((current) => closeApproval(current, approvalId, allow ? "allowed" : "denied"));
        });
      },
    }),
    [runtime, setTranscript],
  );

  if (!runtime) {
    return (
      <div className="chat">
        <div className="chat-head">
          <button type="button" className="iconbtn" onClick={onBack} aria-label="返回">
            ←
          </button>
          <div className="title">
            <strong>会话不存在</strong>
          </div>
        </div>
        <div className="centered">
          <div>
            <strong>这个会话已经关掉了</strong>
            它可能被桌面端关闭，或者连接换了。
          </div>
        </div>
      </div>
    );
  }

  const streaming = transcript.running;

  return (
    <div className="chat">
      <div className="chat-head">
        <button type="button" className="iconbtn" onClick={onBack} aria-label="返回">
          ←
        </button>
        <div className="title">
          <strong>{runtime.name}</strong>
          <span>
            {runtime.readOnly ? "只读 · " : ""}
            {transcript.modelRef ?? runtime.root}
          </span>
        </div>
        {onNewSession ? (
          <button type="button" className="iconbtn" onClick={onNewSession} aria-label="新建会话或切换项目">
            ＋
          </button>
        ) : null}
        <span className={`dot ${snapshot.stream.kind === "open" ? "ok" : "warn"}`} />
      </div>

      <TodoPanel todos={todos} state={todosState} />

      <div className="transcript" ref={listRef} onScroll={onScroll}>
        {transcript.rows.length === 0 ? (
          <div className="centered">
            <div>
              {history === "loading" ? (
                <>
                  <strong>正在读这个会话</strong>
                  桌面上跑过的内容会先补上。
                </>
              ) : history === "failed" ? (
                <>
                  <strong>没读到历史</strong>
                  新的消息照常显示，往回翻的内容暂时看不到。
                </>
              ) : (
                <>
                  <strong>还没有消息</strong>
                  问点什么，或者去桌面端看看这个会话。
                </>
              )}
            </div>
          </div>
        ) : (
          transcript.rows.map((row) => {
            switch (row.kind) {
              case "user":
                return <UserBubble key={row.id} row={row} base={runtime.base} />;
              case "assistant":
                return <AssistantBubble key={row.id} row={row} />;
              case "tool":
                return <ToolCard key={row.id} row={row} />;
              case "notice":
                return <NoticeCard key={row.id} row={row} />;
              case "ask":
                return <AskCard key={row.id} row={row} handlers={handlers} />;
              case "approval":
                return <ApprovalCard key={row.id} row={row} handlers={handlers} />;
            }
          })
        )}
        {transcript.ended && !transcript.ended.cancelled && transcript.ended.error ? (
          <div className="notice error">
            <div>这一轮失败了</div>
            <details>
              <summary>详情</summary>
              <div>{transcript.ended.error}</div>
            </details>
          </div>
        ) : null}
      </div>

      {promptError ? (
        <div className="sendfail">
          <span>{promptError}</span>
          <button type="button" onClick={() => setPromptError("")}>
            知道了
          </button>
        </div>
      ) : null}

      {send.kind === "failed" ? (
        <div className="sendfail">
          <span>没发出去：{send.detail}</span>
          {send.retryable && lastRetry.current ? (
            <button type="button" onClick={() => void doSend(lastRetry.current)}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}

      {attachment && draft.includes(attachment.ref) ? (
        <div className="attachment">
          <img src={attachment.url} alt="已选择的图片" />
          <span>{attachment.name}</span>
          <button type="button" aria-label="移除图片" onClick={removeAttachment}>
            ×
          </button>
        </div>
      ) : null}

      {attachError ? (
        <div className="sendfail">
          <span>{attachError}</span>
          <button type="button" onClick={() => setAttachError("")}>
            知道了
          </button>
        </div>
      ) : null}

      <div className="composer">
        <input
          ref={imageRef}
          className="file-input"
          type="file"
          accept="image/*"
          onChange={(event) => void onImage(event)}
        />
        <button
          type="button"
          className="attach"
          aria-label="添加图片"
          onClick={pickImage}
          disabled={runtime.readOnly === true || attaching || attachment !== null}
        >
          {attaching ? "…" : "📎"}
        </button>
        <textarea
          ref={inputRef}
          value={draft}
          placeholder={runtime.readOnly ? "这个会话是只读的" : "说点什么"}
          disabled={runtime.readOnly === true}
          rows={1}
          onChange={(event) => {
            setDraft(event.target.value);
            grow();
          }}
          onKeyDown={onKeyDown}
        />
        {streaming ? (
          <button
            type="button"
            className="send stop"
            aria-label="停止"
            onClick={() => void cancel(runtime.base)}
          >
            ■
          </button>
        ) : (
          <button
            type="button"
            className="send"
            aria-label="发送"
            disabled={!draft.trim() || send.kind === "sending" || attaching}
            onClick={() => void doSend(draft)}
          >
            ↑
          </button>
        )}
      </div>
    </div>
  );
}
