/**
 * The chat screen.
 *
 * It owns three things a row cannot: the scroll position, the composer, and the
 * send state. The transcript itself is a pure fold, so everything below this
 * file is testable without a browser.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Connection, ConnectionSnapshot } from "../net/connection";
import { cancel, submit } from "../net/submit";
import { loadStatus } from "../net/status";
import type { SendState } from "../net/submit";
import { clearDraft, loadDraft, saveDraft } from "./drafts";
import { MAX_IMAGE_MB, isolateImageRefs, uploadImage } from "../net/attachments";
import { answer, approve } from "../net/prompts";
import { inboxMessage, receiptText, sendToInbox } from "../net/inbox";
import { loadHistory } from "../net/history";
import { loadTodos, todoRevision } from "../net/todos";
import { startTurnNotification, stopTurnNotification } from "../native/turn";
import type { WireTodo } from "../wire/todos";
import type { EventPayload, WireAskAnswer } from "../wire/events";
import { closeApproval, emptyTranscript, markAnswered, markAnsweredSurface, optimisticUser, reduce, removeLocalUser } from "./transcript";
import type { Row, Transcript } from "./transcript";
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
import { ModelSheet } from "./ModelSheet";

export interface ChatScreenProps {
  connection: Connection;
  snapshot: ConnectionSnapshot;
  runtimeId: string;
  /** The conversation's title, when the screen that opened it knew one. */
  title?: string;
  onBack: () => void;
  /** Start a fresh conversation in this chat's project. */
  onNewSession?: () => void;
}

/**
 * A model ref as the chip shows it: `deepseek/deepseek-pro` is a routing
 * identity, and the part a person recognises is the model name. The full ref
 * stays in the sheet, where it is compared.
 */
function shortRef(ref: string): string {
  const at = ref.lastIndexOf("/");
  return at >= 0 ? ref.slice(at + 1) : ref;
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

/** Transport codes are stable, but a person needs a sentence, not a code. */
function sendErrorText(code: string): string {
  switch (code) {
    case "client.timeout":
      return "等电脑回应超时，检查连接后重试。";
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    default:
      return code;
  }
}

/**
 * One row, memoised by its own identity.
 *
 * Every text delta replaces only the streaming row in the transcript array;
 * the rows above keep their object identity. Without this boundary a long
 * conversation re-renders every bubble on every token.
 */
const RowView = memo(function RowView({
  row,
  base,
  handlers,
}: {
  row: Row;
  base: string;
  handlers: PromptHandlers;
}) {
  switch (row.kind) {
    case "user":
      return <UserBubble row={row} base={base} />;
    case "assistant":
      return <AssistantBubble row={row} />;
    case "tool":
      return <ToolCard row={row} />;
    case "notice":
      return <NoticeCard row={row} />;
    case "ask":
      return <AskCard row={row} handlers={handlers} />;
    case "approval":
      return <ApprovalCard row={row} handlers={handlers} />;
  }
});

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
  reload: () => void;
  setTranscript: React.Dispatch<React.SetStateAction<Transcript>>;
} {
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [history, setHistory] = useState<"loading" | "loaded" | "failed">("loading");
  const [reloadToken, setReloadToken] = useState(0);
  const loadedBase = useRef<string | null>(null);
  const lastEvent = snapshot.lastEvent;

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    const switched = loadedBase.current !== base;
    loadedBase.current = base;
    if (switched) {
      setTranscript(emptyTranscript);
      setHistory("loading");
    }
    void loadHistory(base).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setHistory("failed");
        return;
      }
      if (switched) {
        // Prefix the snapshot: a frame that landed while the read was in
        // flight must not be thrown away or moved above its own turn.
        setTranscript((current) => ({ ...current, rows: [...result.rows, ...current.rows] }));
      } else {
        // A gap reload is a replacement, not a prefix. A row still streaming
        // is kept because its remaining deltas have no earlier half; a pending
        // prompt or an unconfirmed send is kept because the kernel still knows
        // about it even though history does not.
        setTranscript((current) => ({
          ...current,
          rows: [
            ...result.rows,
            ...current.rows.filter(
              (row) =>
                (row.kind === "assistant" && row.streaming) ||
                (row.kind === "ask" && row.pending) ||
                (row.kind === "approval" && row.pending) ||
                (row.kind === "user" && row.local === true),
            ),
          ],
          gap: false,
        }));
      }
      setHistory("loaded");
    });
    return () => {
      cancelled = true;
    };
  }, [base, runtimeId, reloadToken]);

  useEffect(() => {
    if (!lastEvent) return;
    setTranscript((current) => reduce(current, lastEvent));
  }, [lastEvent]);

  return { transcript, history, reload, setTranscript };
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

export function ChatScreen({ connection, snapshot, runtimeId, title, onBack, onNewSession }: ChatScreenProps) {
  const runtime = snapshot.runtimes.find((candidate) => candidate.id === runtimeId);
  const { transcript, history, reload, setTranscript } = useTranscript(
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
  const [attachments, setAttachments] = useState<
    { ref: string; name: string; url: string }[]
  >([]);
  const [attachError, setAttachError] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  /** The model the catalog last confirmed, shown until the transcript reports one. */
  const [pickedModel, setPickedModel] = useState("");
  const [modelSheet, setModelSheet] = useState(false);
  /** What the kernel said about the last message sent into a running turn. */
  const [inboxNote, setInboxNote] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const imageRef = useRef<HTMLInputElement | null>(null);
  const lastRetry = useRef<string>("");
  /** The composer's live value, readable after an await without stale state. */
  const draftRef = useRef(draft);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Attaching is the screen's job, not the caller's: a screen that is mounted
  // and not subscribed shows a still frame that looks like a hang.
  useEffect(() => {
    connection.attach(runtimeId);
    return () => connection.detach();
  }, [connection, runtimeId]);

  // The stream carries what happens from now on, so a turn that was already
  // running when the screen opened has no `turn_started` to flip the composer
  // into its stop state. The kernel's own status is the only place that says
  // so, and without this read the phone offers no way to stop work it can see
  // is happening.
  useEffect(() => {
    const base = runtime?.base;
    if (!base) return;
    let cancelled = false;
    void loadStatus(base).then((result) => {
      if (cancelled || !result.ok || !result.status.running) return;
      setTranscript((current) => (current.running ? current : { ...current, running: true }));
    });
    return () => {
      cancelled = true;
    };
  }, [runtime?.base, setTranscript]);

  // A running turn is exactly the window where the phone may be locked. The
  // native service keeps the process alive and tells the person when it ends.
  const turnFinished =
    transcript.ended !== undefined && !transcript.ended.cancelled && !transcript.ended.error;
  useEffect(() => {
    if (transcript.running) startTurnNotification(runtime?.name);
    else stopTurnNotification(turnFinished);
  }, [transcript.running, turnFinished, runtime?.name]);

  // Leaving the screen means this client is no longer watching the turn; a
  // notification left behind would be a promise nobody keeps.
  useEffect(() => () => stopTurnNotification(false), []);

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

  // Rotation changes the textarea's width, so its wrapped height must be
  // measured again. Without this a long draft is clipped after a turn.
  useEffect(() => {
    const onResize = () => grow();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [grow]);

  // The preview URL is ours to release. This runs on unmount only: rerunning
  // per change would revoke the images that are still in the composer.
  useEffect(() => {
    const urls = attachments.map((entry) => entry.url);
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Editing a reference out of the draft is also removing that attachment;
  // otherwise the chip would stay but the turn would not mention the image.
  // Compared one by one so deleting one ref keeps the others.
  useEffect(() => {
    setAttachments((current) => {
      const kept = current.filter((entry) => draft.includes(entry.ref));
      if (kept.length === current.length) return current;
      for (const entry of current) {
        if (!kept.includes(entry)) URL.revokeObjectURL(entry.url);
      }
      return kept;
    });
  }, [draft]);

  const pickImage = useCallback(() => {
    imageRef.current?.click();
  }, []);

  /**
   * Upload every chosen image, then append their references in one edit.
   *
   * The picker accepts several at once, and choosing again appends rather than
   * replaces: a phone screenshot flow is "one more thing to show", and making
   * the person re-pick the first image would be worse than the single-image
   * limit it replaces. Each upload is independent, so one failure names that
   * file and the others still land.
   */
  const onImage = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      if (files.length === 0 || !runtime) return;
      setAttachError("");
      setAttaching(true);

      const uploaded: { ref: string; name: string; url: string }[] = [];
      const failures: string[] = [];
      for (const file of files) {
        const preview = URL.createObjectURL(file);
        const result = await uploadImage(runtime.base, file);
        if (!result.ok) {
          URL.revokeObjectURL(preview);
          failures.push(`${file.name || "图片"}：${imageMessage(result.code)}`);
          continue;
        }
        uploaded.push({ ref: result.attachment.ref, name: file.name || "图片", url: preview });
      }

      setAttaching(false);
      if (uploaded.length > 0) {
        setAttachments((current) => [...current, ...uploaded]);
        // The trailing newline is load-bearing: the caret goes to the end, so
        // anything typed next starts on its own line instead of becoming part
        // of the reference token.
        setDraft((current) => {
          const base = current.replace(/\s+$/, "");
          const refs = uploaded.map((entry) => entry.ref).join("\n");
          return base ? `${base}\n${refs}\n` : `${refs}\n`;
        });
        window.setTimeout(grow, 0);
      }
      if (failures.length > 0) setAttachError(failures.join("\n"));
    },
    [runtime, grow],
  );

  const removeAttachment = useCallback((ref: string) => {
    setDraft((current) => current.replace(ref, "").replace(/[ \t]+\n/g, "\n").trimEnd());
    setAttachments((current) => {
      const removed = current.find((entry) => entry.ref === ref);
      if (removed) URL.revokeObjectURL(removed.url);
      return current.filter((entry) => entry.ref !== ref);
    });
    setAttachError("");
  }, []);

  const doSend = useCallback(
    async (text: string) => {
      if (!runtime) return;
      const outgoing = isolateImageRefs(text).trim();
      if (!outgoing) return;
      // The kernel takes a round trip to confirm a turn. Draw the person's own
      // words now; `turn_started` later confirms this row by matching its text
      // instead of appending a second copy.
      const local = optimisticUser(outgoing);
      // A snapshot, so a send clears exactly the images it carried and leaves
      // anything picked while the POST was in flight.
      const sentAttachments = attachments;
      setTranscript((current) => ({ ...current, rows: [...current.rows, local] }));
      setSend({ kind: "sending" });
      const result = await submit(runtime.base, outgoing);
      if (result.ok) {
        setSend({ kind: "sent" });
        // Only clear what was actually sent. Text typed while the request was
        // in flight is the next thought, not part of this one.
        if (isolateImageRefs(draftRef.current).trim() === outgoing) {
          clearDraft(runtimeId);
          setDraft("");
        }
        setAttachments((current) => {
          const kept = current.filter((entry) => !sentAttachments.includes(entry));
          for (const entry of current) {
            if (!kept.includes(entry)) URL.revokeObjectURL(entry.url);
          }
          return kept;
        });
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
    [runtime, scrollToBottom, attachments],
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

  /**
   * Send into a turn that is still running.
   *
   * Two buttons, because they are two promises. 排队 waits for the turn to end
   * and changes nothing about it; 插话 is delivered into the running turn, so
   * the model can act on it before its next step — and can be refused if the
   * turn already moved past the point where that is possible.
   */
  const sendWhileRunning = useCallback(
    async (intent: "followup" | "steer") => {
      if (!runtime) return;
      const text = isolateImageRefs(draft).trim();
      if (!text) return;
      setInboxNote(intent === "steer" ? "正在插话…" : "正在排队…");
      setPromptError("");
      const result = await sendToInbox(runtime.base, text, intent);
      if (!result.ok) {
        setInboxNote("");
        setPromptError(inboxMessage(result.code));
        return;
      }
      setInboxNote(receiptText(result.receipt));
      // The kernel holds this message now, so the composer is free for the
      // next thought — the same rule a normal send follows.
      if (isolateImageRefs(draftRef.current).trim() === text) {
        clearDraft(runtimeId);
        setDraft("");
        setAttachments((current) => {
          for (const entry of current) URL.revokeObjectURL(entry.url);
          return [];
        });
      }
    },
    [runtime, draft, runtimeId],
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
      onAnswerSurface: (askId, questionId, values) => {
        if (!runtime) return;
        // A structured answer is one entry carrying `Value`, with `Selected`
        // empty: the kernel's own validation rejects anything else for a
        // surface question (`Selected` must be empty, and the ask holds
        // exactly one question).
        const entry: WireAskAnswer = { QuestionID: questionId, Selected: [], Value: values };
        void answer(runtime.base, askId, [entry]).then((result) => {
          if (!result.ok) {
            setPromptError(`没答上：${result.code ?? "unknown"}`);
            return;
          }
          setPromptError("");
          setTranscript((current) => markAnsweredSurface(current, askId));
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
          <strong>{title ?? runtime.name}</strong>
          <span>
            {runtime.readOnly ? "只读 · " : ""}
            {runtime.name} · {runtime.root}
          </span>
        </div>
        {runtime.readOnly ? null : (
          <button
            type="button"
            className="modelchip"
            onClick={() => setModelSheet(true)}
            aria-label="切换模型"
            title="切换模型"
          >
            {shortRef(pickedModel || transcript.modelRef || "") || "模型"}
          </button>
        )}
        {onNewSession ? (
          <button type="button" className="iconbtn" onClick={onNewSession} aria-label="在当前项目新建会话">
            ＋
          </button>
        ) : null}
        <span
          className={`dot ${snapshot.stream.kind === "open" ? "ok" : "warn"}`}
          role="img"
          aria-label={snapshot.stream.kind === "open" ? "事件流已连接" : "事件流未连接"}
          title={snapshot.stream.kind === "open" ? "事件流已连接" : "事件流未连接"}
        />
      </div>

      <TodoPanel todos={todos} state={todosState} />

      {transcript.gap ? (
        <div className="notice warn" role="status">
          <div>连接中断过，中间的消息可能不完整。</div>
          <button type="button" onClick={reload}>
            重新加载历史
          </button>
        </div>
      ) : null}

      <div className="transcript" ref={listRef} onScroll={onScroll} role="log" aria-label="对话记录">
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
          transcript.rows.map((row) => (
            <RowView key={row.id} row={row} base={runtime.base} handlers={handlers} />
          ))
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
        <div className="sendfail" role="alert">
          <span>{promptError}</span>
          <button type="button" onClick={() => setPromptError("")}>
            知道了
          </button>
        </div>
      ) : null}

      {send.kind === "failed" ? (
        <div className="sendfail" role="alert">
          <span>没发出去：{sendErrorText(send.detail)}</span>
          {send.retryable && lastRetry.current ? (
            <button type="button" onClick={() => void doSend(lastRetry.current)}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="attachments">
          {attachments.map((entry) => (
            <div className="attachment" key={entry.ref}>
              <img src={entry.url} alt="已选择的图片" />
              <span className="attachment-name">{entry.name}</span>
              <button
                type="button"
                aria-label={`移除图片 ${entry.name}`}
                onClick={() => removeAttachment(entry.ref)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {attachError ? (
        <div className="sendfail" role="alert">
          <span>{attachError}</span>
          <button type="button" onClick={() => setAttachError("")}>
            知道了
          </button>
        </div>
      ) : null}

      {inboxNote ? (
        <div className="inbox-note" role="status">
          <span>{inboxNote}</span>
          <button type="button" onClick={() => setInboxNote("")} aria-label="关闭提示">
            ×
          </button>
        </div>
      ) : null}

      <div className="composer">
        <input
          ref={imageRef}
          className="file-input"
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => void onImage(event)}
        />
        <button
          type="button"
          className="attach"
          aria-label="添加图片"
          onClick={pickImage}
          disabled={runtime.readOnly === true || attaching}
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
            onClick={() => {
              void cancel(runtime.base).then((result) => {
                if (!result.ok) setPromptError(`没停下来：${sendErrorText(result.code ?? "unknown")}`);
              });
            }}
          >
            停止
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

      {/* While a turn runs, the composer's send button is the stop control, so
          a message typed now needs its own way out. Two buttons rather than
          one: queuing leaves the turn alone, steering joins it. */}
      {streaming && draft.trim() && runtime.readOnly !== true ? (
        <div className="interject" role="group" aria-label="发送到运行中的回合">
          <button type="button" className="chip" onClick={() => void sendWhileRunning("followup")}>
            排队
          </button>
          <button type="button" className="chip accent" onClick={() => void sendWhileRunning("steer")}>
            插话
          </button>
        </div>
      ) : null}

      {modelSheet ? (
        <ModelSheet
          base={runtime.base}
          {...(transcript.modelRef ? { fallback: transcript.modelRef } : {})}
          onClose={() => setModelSheet(false)}
          onSwitched={(ref) => {
            setPickedModel(ref);
            setModelSheet(false);
          }}
        />
      ) : null}
    </div>
  );
}
