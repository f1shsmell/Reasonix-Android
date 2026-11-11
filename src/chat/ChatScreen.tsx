/**
 * The chat screen.
 *
 * It owns three things a row cannot: the scroll position, the composer, and the
 * send state. The transcript itself is a pure fold, so everything below this
 * file is testable without a browser.
 */

import { Fragment, memo, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Connection, ConnectionSnapshot, QueuedEvent } from "../net/connection";
import { cancel, submit } from "../net/submit";
import { loadStatus, setPlanMode } from "../net/status";
import { effortDisplayName } from "../net/models";
import {
  APPROVAL_CHOICES,
  approvalLabel,
  approvalMessage,
  setApprovalMode,
} from "../net/approval";
import type { SendState } from "../net/submit";
import { clearDraft, loadDraft, saveDraft } from "./drafts";
import { cachePercent } from "./cacheRate";
import { MAX_FILE_MB, MAX_IMAGE_MB, isolateImageRefs, uploadFile, uploadImage } from "../net/attachments";
import { answer, approve } from "../net/prompts";
import { inboxMessage, receiptText, sendToInbox } from "../net/inbox";
import { useStreamHaptics } from "./streamHaptics";
import { loadHistory } from "../net/history";
import { loadReading, readingKey, saveReading } from "./reading";
import { useBackCloser } from "../app/backStack";
import { StudioIcon } from "../app/StudioIcon";
import type { StudioOpenResult } from "../app/openStudio";
import { loadEnterPref } from "../app/enterPref";
import type { EnterPref } from "../app/enterPref";
import { compactCount } from "../app/format";
import { loadTodos, todoRevision } from "../net/todos";
import { startTurnNotification } from "../native/turn";
import { speechSupported } from "../native/speech";
import { useDictation } from "./dictation";
import { MicButton, VoiceLive } from "./MicButton";
import type { WireTodo } from "../wire/todos";
import type { EventPayload, WireAskAnswer } from "../wire/events";
import { closeApproval, emptyTranscript, markAnswered, markAnsweredSurface, optimisticUser, reduce, removeLocalUser } from "./transcript";
import type { Row, Transcript, UserRow } from "./transcript";
import { dropCachedRows, loadCachedRows, scheduleSaveRows } from "./transcriptCache";
import { ApprovalCard, AskCard, AssistantBubble, NoticeCard, UserBubble, WorkedLine } from "./Rows";
import type { PromptHandlers, RowActions } from "./Rows";
import { ActivityRow, ProcessSheet, ProcessSummary } from "./Activity";
import { ThoughtStrip } from "./ThoughtStrip";
import { buildDisplay, thoughtOf } from "./process";
import { loadFoldMode } from "./folding";
import type { ProcessStep } from "./process";
import { TodoPanel } from "./TodoPanel";
import type { TodosState } from "./TodoPanel";
import { ModelSheet } from "./ModelSheet";
import { CheckpointsSheet } from "./CheckpointsSheet";
import { EditMessageSheet } from "./EditMessageSheet";
import { QueueSheet } from "./QueueSheet";
import { ContextSheet } from "./ContextSheet";
import { ImageViewer } from "./ImageViewer";
import { loadCheckpoints, prepareRewind, commitRewind, rewindMessage } from "../net/rewind";
import type { Checkpoint } from "../net/rewind";
import { branchAt, branchMessage } from "../net/branch";

export interface ChatScreenProps {
  connection: Connection;
  snapshot: ConnectionSnapshot;
  runtimeId: string;
  /** The conversation's title, when the screen that opened it knew one. */
  title?: string;
  onBack: () => void;
  /** Start a fresh conversation in this chat's project. */
  onNewSession?: () => void;
  /** How the kernel is reached, named in the ongoing notification. */
  mode?: "lan" | "cloud" | undefined;
  /** A decision notification asked the screen to land on the waiting prompt. */
  focusAsk?: boolean;
  onFocusConsumed?: () => void;
  /** Open the paired computer's Studio page; absent where there is no native shell. */
  onOpenStudio?: () => Promise<StudioOpenResult>;
  /** Open a conversation the kernel just forked; false when the open failed. */
  onOpenBranch?: (path: string, name: string) => Promise<boolean>;
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

/**
 * The workbench rides its own chunk: tree, diff parser, file browser and
 * highlight are only worth their bytes once a person actually opens 工作台,
 * and the chat's first paint should not pay for them.
 */
const Workbench = lazy(() =>
  import("./workbench/Workbench").then((m) => ({ default: m.Workbench })),
);

/**
 * Why the history read failed, in the terms that decide what to do next.
 *
 * The distinction that matters is whether retrying can help: a deadline on a
 * long conversation will pass on a second try once the kernel has it parsed,
 * while a 404 will not. The raw code is appended so a bug report can name it.
 */
function historyHint(code: string): string {
  switch (code) {
    case "client.timeout":
      return "（读取超时：会话很长，再试一次通常能读到。client.timeout）";
    case "client.offline":
      return "（连不上电脑。client.offline）";
    case "history.shape":
      return "（电脑返回了无法识别的记录。history.shape）";
    default:
      return `（${code}）`;
  }
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

function fileMessage(code: string): string {
  switch (code) {
    case "attachment.too_large":
      return `文件太大，上限 ${MAX_FILE_MB} MB。`;
    case "attachment.empty_name":
      return "这个文件没有名字。";
    case "attachment.write_failed":
      return "桌面端保存文件失败，检查磁盘空间和写入权限。";
    case "attachment.shape":
      return "桌面端返回了无法识别的文件。";
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

/** A reply held above the box instead of pasted into it. */
interface QuotedReply {
  id: string;
  text: string;
  turn?: number;
}

/** A file or picture waiting above the box, carried by the next send. */
interface Attachment {
  ref: string;
  name: string;
  url?: string;
  image?: boolean;
}

function quoteLineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/**
 * How a quote reaches the model, worded like Studio's: the turn it came from
 * is the identity the agent can act on, and the lines follow as a block quote.
 */
function quoteBlock(entry: QuotedReply): string {
  const head =
    entry.turn !== undefined
      ? `[Quoting the assistant reply from turn ${entry.turn}.]`
      : "[Quoting an earlier assistant reply in this conversation.]";
  return [head, ...entry.text.split("\n").map((line) => `> ${line}`)].join("\n");
}

/** Quotes lead the message, then the attachments' references, then the words. */
function composeMessage(quotes: QuotedReply[], refs: string[], text: string): string {
  return [...quotes.map(quoteBlock), [...refs, text.trim()].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * What the + opens: camera, images, files, and plan mode.
 *
 * Plan mode is not a message; it is a runtime setting, so it is toggled here
 * and read back from `/status`, exactly as the desktop does it.
 */
function AttachSheet({
  plan,
  busy,
  onClose,
  onCamera,
  onImage,
  onFile,
  onPlan,
}: {
  plan: boolean | undefined;
  busy: boolean;
  onClose: () => void;
  onCamera: () => void;
  onImage: () => void;
  onFile: () => void;
  onPlan: () => void;
}) {
  const planHint =
    plan === undefined ? "读不到当前模式" : plan ? "已开启，点此关闭" : "先整理步骤，不写入文件";
  useBackCloser(true, onClose);
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet attach-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="添加"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>添加</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <ul className="sheet-actions attach-actions">
          <li>
            <button type="button" onClick={onCamera}>
              <span className="attach-glyph" aria-hidden="true">
                ◉
              </span>
              <span>相机</span>
              <small>拍一张</small>
            </button>
          </li>
          <li>
            <button type="button" onClick={onImage}>
              <span className="attach-glyph" aria-hidden="true">
                ▧
              </span>
              <span>图片</span>
              <small>从相册选择</small>
            </button>
          </li>
          <li>
            <button type="button" onClick={onFile}>
              <span className="attach-glyph" aria-hidden="true">
                ▤
              </span>
              <span>文件</span>
              <small>日志、PDF 等，最多 {MAX_FILE_MB} MB</small>
            </button>
          </li>
          <li>
            <button
              type="button"
              onClick={onPlan}
              disabled={plan === undefined || busy}
              aria-pressed={plan === true}
            >
              <span className="attach-glyph" aria-hidden="true">
                ☰
              </span>
              <span>计划</span>
              <small>{busy ? "正在切换…" : planHint}</small>
            </button>
          </li>
        </ul>
      </section>
    </div>
  );
}

/** The header's "…": the two things that do not fit in the bar. */
function HeadMenu({
  model,
  approval,
  cache,
  onClose,
  onReload,
  onModel,
  onApproval,
  onCheckpoints,
  onQueue,
  onContext,
  onWorkbench,
}: {
  model: string;
  approval: string;
  cache: { hit: number; miss: number; unknown: number } | null;
  onClose: () => void;
  onReload: () => void;
  onModel: () => void;
  onApproval: () => void;
  onCheckpoints: () => void;
  onQueue: () => void;
  onContext: () => void;
  onWorkbench: () => void;
}) {
  useBackCloser(true, onClose);
  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet head-menu"
        role="dialog"
        aria-modal="true"
        aria-label="会话操作"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>会话</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <ul className="sheet-actions">
          <li>
            <button type="button" onClick={onReload}>
              <span>重新加载历史</span>
              <small>连接中断或内容不对时</small>
            </button>
          </li>
          <li>
            <button type="button" onClick={onModel}>
              <span>选择模型</span>
              <small>{model || "未命名模型"}</small>
            </button>
          </li>
          <li>
            <button type="button" onClick={onApproval}>
              <span>工具批准</span>
              <small>{approvalLabel(approval) || "读不到当前模式"}</small>
            </button>
          </li>
          <li>
            <button type="button" onClick={onQueue}>
              <span>排队</span>
              <small>这一轮结束后要发的消息</small>
            </button>
          </li>
          <li>
            <button type="button" onClick={onCheckpoints}>
              <span>检查点</span>
              <small>回到之前的一轮</small>
            </button>
          </li>
          <li>
            <button type="button" onClick={onContext}>
              <span>上下文</span>
              <small>用量、明细与压缩</small>
            </button>
          </li>
          <li>
            <div className="head-menu-note">
              <span>缓存命中率</span>
              <small>{cacheNote(cache)}</small>
            </div>
          </li>
          <li>
            <button type="button" onClick={onWorkbench}>
              <span>工作台</span>
              <small>变更、diff 与提交</small>
            </button>
          </li>
        </ul>
      </section>
    </div>
  );
}

/**
 * The cache split as one line: the rate first, then the counts it came from.
 * Unsplit prompt is left out of the rate by `cachePercent`, so the counts are
 * the ledger's own and need no adjustment.
 */
function cacheNote(cache: { hit: number; miss: number; unknown: number } | null): string {
  if (!cache) return "还没有可统计的请求";
  const percent = cachePercent(cache.hit, cache.miss, cache.unknown);
  if (percent === null) return "还没有可统计的请求";
  return `${percent}% · 命中 ${compactCount(cache.hit)} · 未命中 ${compactCount(cache.miss)}`;
}

/**
 * The tool posture for this conversation.
 *
 * It is a runtime setting, so it lives where the conversation is — not in the
 * global settings page, where it read as a machine-wide switch.
 */
function ApprovalSheet({
  base,
  current,
  onClose,
  onChanged,
}: {
  base: string;
  current: string;
  onClose: () => void;
  onChanged: (mode: string) => void;
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useBackCloser(true, onClose);

  const pick = async (mode: string) => {
    if (busy) return;
    setBusy(mode);
    setError("");
    const result = await setApprovalMode(base, mode);
    setBusy("");
    if (!result.ok) {
      setError(approvalMessage(result.code));
      return;
    }
    onChanged(mode);
  };

  return (
    <div className="sheet-backdrop" role="presentation" onClick={onClose}>
      <section
        className="sheet approval-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="工具批准"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>工具批准</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <p className="sheet-note">只改这个会话；桌面端下次打开的新会话沿用它最近一次的选择。</p>
        <div className="approval-choices" role="group" aria-label="工具批准">
          {APPROVAL_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className={current === choice.value ? "on" : ""}
              aria-pressed={current === choice.value}
              disabled={busy !== ""}
              onClick={() => void pick(choice.value)}
            >
              <span>{choice.label}</span>
              <small>{choice.hint}</small>
            </button>
          ))}
        </div>
        {error ? <div className="notice error">{error}</div> : null}
      </section>
    </div>
  );
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
  actions,
  turn,
  branchTurn,
  question,
  onOpenImage,
  compact,
}: {
  row: Row;
  base: string;
  handlers: PromptHandlers;
  actions: RowActions;
  /** The checkpoint turn this row's turn opened, when there is one. */
  turn?: number;
  /** Where a fork would cut, when this row's turn is closed (it may be running). */
  branchTurn?: number;
  /** The words that asked for this answer, for regenerating the same request. */
  question?: string;
  /** Show one of this row's pictures at full size. */
  onOpenImage?: (src: string) => void;
  /** Compact fold: the answer carries its own thought as a bounded window. */
  compact?: boolean;
}) {
  switch (row.kind) {
    case "user":
      return (
        <UserBubble
          row={row}
          base={base}
          actions={actions}
          {...(turn !== undefined ? { turn } : {})}
          {...(onOpenImage ? { onOpenImage } : {})}
        />
      );
    case "assistant":
      return (
        <AssistantBubble
          row={row}
          actions={actions}
          {...(turn !== undefined ? { turn } : {})}
          {...(branchTurn !== undefined ? { branchTurn } : {})}
          {...(question ? { question } : {})}
          {...(compact !== undefined ? { compact } : {})}
        />
      );
    case "notice":
      return <NoticeCard row={row} />;
    case "ask":
      return <AskCard row={row} handlers={handlers} />;
    case "approval":
      return <ApprovalCard row={row} handlers={handlers} />;
    case "worked":
      return <WorkedLine row={row} />;
    default:
      return null;
  }
});

/**
 * Rows the read cannot reconstruct, kept across any replacement.
 *
 * A row still streaming has no earlier half in history; a pending prompt is
 * connection state the kernel still owes a receipt for; an unconfirmed send
 * may still confirm. The same set serves the gap reload and the cache
 * hydration: both put kernel rows under whatever this screen holds that the
 * kernel does not know the screen has seen.
 */
function keepUnconfirmed(row: Row): boolean {
  return (
    (row.kind === "assistant" && row.streaming) ||
    (row.kind === "ask" && row.pending) ||
    (row.kind === "approval" && row.pending) ||
    (row.kind === "user" && row.local === true)
  );
}

/**
 * Cached rows history has already superseded, by id.
 *
 * A bubble that was still streaming when the pane was last closed is the
 * ghost: the cache flushed it mid-turn, the kernel has since finished the
 * turn, and the history read now carries the finished message. Keeping the
 * streaming copy as "unconfirmed" draws the same answer twice — seen on a
 * device once history loaded reliably enough for the replace path to run.
 *
 * A turn that is genuinely still running has no finished copy in history
 * (`/history` carries settled messages only), so a prefix match is what
 * separates the ghost from a turn to be continued: streamed deltas only ever
 * append, so the streamed text is a prefix of the finished one. At most one
 * turn streams at a time, so the scan is one pass for a single candidate.
 */
function ghostedByHistory(current: Row[], history: Row[]): Set<string> {
  const ghosts = new Set<string>();
  for (const row of current) {
    if (row.kind !== "assistant" || !row.streaming) continue;
    const streamed = row.text;
    if (history.some((h) => h.kind === "assistant" && h.text.startsWith(streamed))) {
      ghosts.add(row.id);
    }
  }
  return ghosts;
}

/**
 * Cached optimistic sends history has already settled.
 *
 * A pane closed before `turn_started` arrives caches its local user row; the
 * kernel's history then carries the same message under its own id. Keeping
 * both draws the send twice, so match one history copy to each local row.
 * Oldest first leaves the newest unmatched row in place for a send that is
 * genuinely still in flight.
 */
function ghostedLocalUsers(current: Row[], history: Row[]): Set<string> {
  const remaining = new Map<string, number>();
  const indices = new Map<number, number>();
  for (const row of history) {
    if (row.kind !== "user") continue;
    remaining.set(row.text, (remaining.get(row.text) ?? 0) + 1);
    if (row.msgIndex !== undefined) {
      indices.set(row.msgIndex, (indices.get(row.msgIndex) ?? 0) + 1);
    }
  }
  const ghosts = new Set<string>();
  for (const row of current) {
    if (row.kind !== "user") continue;
    // A confirmed optimistic row keeps its local id. Match it by the index
    // the kernel assigned; text alone missed it once the row was no longer
    // marked local, and the history copy then drew the same send twice.
    if (row.msgIndex !== undefined && (indices.get(row.msgIndex) ?? 0) > 0) {
      ghosts.add(row.id);
      indices.set(row.msgIndex, (indices.get(row.msgIndex) ?? 1) - 1);
      const text = remaining.get(row.text) ?? 0;
      if (text > 0) remaining.set(row.text, text - 1);
      continue;
    }
    const appMinted = row.local === true || row.id.startsWith("local-");
    if (!appMinted) continue;
    const count = remaining.get(row.text) ?? 0;
    if (count === 0) continue;
    ghosts.add(row.id);
    remaining.set(row.text, count - 1);
  }
  return ghosts;
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
 * not end up above the messages it follows. The cached copy of the last drawn
 * rows paints first, and the read — still the authority — replaces it when it
 * lands.
 */
/**
 * What the history read left behind.
 *
 * `failed` carries the code from `loadHistory`. A bare "没读到历史" told the
 * person nothing and told us nothing either: a deadline, a 404 and a socket
 * that died all looked alike. The code is how a bug report says which.
 */
type HistoryState =
  | { kind: "loading" }
  | { kind: "loaded" }
  | { kind: "failed"; code: string };

/** After a failed older-page read, wait this long before asking again. */
const OLDER_RETRY_COOLDOWN_MS = 10_000;

function useTranscript(
  connection: Connection,
  snapshot: ConnectionSnapshot,
  runtimeId: string,
  base: string | undefined,
  sessionPath: string | undefined,
  /**
   * The clock the screen owns: set when the phone watches a turn start, null
   * for a turn restored by a reload. The fold loop vouches frames with it —
   * see the `stampClock` option on [reduce].
   */
  clockRef?: React.RefObject<number | null>,
): {
  transcript: Transcript;
  history: HistoryState;
  reload: () => void;
  setTranscript: React.Dispatch<React.SetStateAction<Transcript>>;
  /** Read the page before the oldest rows on screen; guarded against re-entry. */
  loadOlder: () => void;
  /** The newest page's cursor state: whether older messages exist to read. */
  cursor: { hasMoreBefore: boolean; nextCursor?: string };
  /** Bumped by a manual history reload; the checklist reads again with it. */
  reloadToken: number;
} {
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [history, setHistory] = useState<HistoryState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  /**
   * Reading older pages, one at a time. `hasMoreBefore`/`nextCursor` come
   * from the newest page the kernel served; when the window renderer needs
   * more history than that page holds, `loadOlder` walks the cursor back.
   * An in-flight page read is not re-fired by further scroll events, and a
   * conversation with no cursor set reads no older pages at all.
   */
  const [cursor, setCursor] = useState<{ hasMoreBefore: boolean; nextCursor?: string }>({
    hasMoreBefore: false,
  });
  const olderLoading = useRef(false);
  /** The same cursor state, readable inside loadOlder without stale closures. */
  const cursorRef = useRef(cursor);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);
  /**
   * The same history state, readable inside loadOlder. A cursor read may
   * only fire once this conversation's newest page has actually landed: a
   * failed or still-loading read means the cursor on screen is stale or
   * foreign, and walking it would prepend another conversation's messages.
   */
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  const loadedBase = useRef<string | null>(null);
  /**
   * The two cache handshakes. `hydrated` says the cached rows are already on
   * screen for this conversation, so the history read must replace them rather
   * than prefix them (the cache IS the earlier history — prefixing it would
   * draw the conversation twice). `historyDone` says the read has settled, so
   * a cache read that finishes after it is stale and must be dropped.
   */
  const hydrated = useRef(false);
  const historyDone = useRef(false);
  /**
   * Which pane id has already had its hydration attempt, and whether cache
   * rows are already on its screen. Without the first, a `sessionPath`
   * landing after mount re-runs the effect below and prepends the same entry
   * twice — duplicated bubbles until history replaces them. The second is
   * what lets a cold start whose first read missed (the disk entry sits under
   * the session-path key, which is not known yet) look again once the path
   * arrives. "Painted", not "attempted", is the skip condition on purpose:
   * StrictMode's first setup is cancelled before its read resolves, so an
   * attempt-based flag would leave the second setup skipping a paint that
   * never happened.
   */
  const hydratedFor = useRef<string | null>(null);
  const painted = useRef(false);
  /**
   * The last frame seq folded into the transcript.
   *
   * Frames are queued, not overwritten, because one relay poll delivers a
   * whole burst and React commits the burst as a single render. Folding from
   * this watermark is what makes a burst arrive whole: an effect keyed on the
   * newest frame alone ran once per burst and kept only the last delta.
   *
   * Seeded to -1 so the first effect folds whatever is already queued.
   */
  const foldedThrough = useRef(-1);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  // Paint the cached conversation before the history read lands. The read
  // still runs — the cache is the speed, the kernel is the truth — so a stale
  // copy survives at most until the response arrives.
  //
  // This deliberately does not wait for `base`: `base` only arrives with
  // `GET /runtimes`, and on a slow network that request is the slowest thing
  // on the screen. Gating the cache on it made the accelerator sit behind the
  // very wait it exists to hide. `runtimeId` is known the moment the screen
  // mounts, and the session path joins it once the runtime list lands.
  useEffect(() => {
    const first = hydratedFor.current !== runtimeId;
    if (first) {
      hydratedFor.current = runtimeId;
      hydrated.current = false;
      historyDone.current = false;
      painted.current = false;
    }
    // This pane's cache rows are already on screen; a second read would only
    // prepend the same entry twice. A miss leaves the flag unset, so the run
    // that follows a sessionPath landing retries with both keys.
    if (painted.current) return;
    // A retry run deliberately keeps hydrated/historyDone: history may have
    // landed meanwhile, and its rows are already correct.
    let cancelled = false;
    void loadCachedRows([sessionPath, runtimeId]).then((cached) => {
      if (cancelled || !cached || historyDone.current) return;
      painted.current = true;
      hydrated.current = true;
      setTranscript((current) =>
        current.rows.length === 0 ? { ...current, rows: cached } : { ...current, rows: [...cached, ...current.rows] },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [sessionPath, runtimeId]);

  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    const switched = loadedBase.current !== base;
    loadedBase.current = base;
    if (switched) {
      hydrated.current = false;
      historyDone.current = false;
      // The cursor belongs to the previous conversation's newest page. A page
      // read against the old base would prepend the old conversation's
      // messages onto this one, so it dies here before any scroll can fire it.
      // The cooldown dies with it: a fresh conversation deserves a fresh try.
      olderLoading.current = false;
      olderFailedUntil.current = 0;
      setCursor({ hasMoreBefore: false });
      setTranscript(emptyTranscript);
      setHistory({ kind: "loading" });
    }
    void loadHistory(base).then((result) => {
      if (cancelled) return;
      historyDone.current = true;
      if (!result.ok) {
        setHistory({ kind: "failed", code: result.code });
        return;
      }
      const fresh = result.read.rows;
      // The newest page decides whether older ones exist and where they start.
      setCursor({
        hasMoreBefore: result.read.hasMoreBefore,
        ...(result.read.nextCursor ? { nextCursor: result.read.nextCursor } : {}),
      });
      if (switched) {
        if (hydrated.current) {
          // The cache is on screen: the read replaces it, keeping only what
          // the kernel does not know about yet. A prefix merge would stack the
          // same conversation twice, and a cached bubble history has already
          // finished is the ghost the phone drew twice.
          setTranscript((current) => {
            const ghosts = new Set([
              ...ghostedByHistory(current.rows, fresh),
              ...ghostedLocalUsers(current.rows, fresh),
            ]);
            return {
              ...current,
              rows: [
                ...fresh,
                ...current.rows.filter((row) => !ghosts.has(row.id) && keepUnconfirmed(row)),
              ],
            };
          });
        } else {
          // Prefix the snapshot: a frame that landed while the read was in
          // flight must not be thrown away or moved above its own turn. A
          // cached optimistic copy history has settled is not such a frame.
          setTranscript((current) => {
            const ghosts = ghostedLocalUsers(current.rows, fresh);
            return { ...current, rows: [...fresh, ...current.rows.filter((row) => !ghosts.has(row.id))] };
          });
        }
      } else {
        // A gap reload is a replacement, not a prefix. A row still streaming
        // is kept because its remaining deltas have no earlier half; a pending
        // prompt or an unconfirmed send is kept because the kernel still knows
        // about it even though history does not.
        setTranscript((current) => {
          const ghosts = ghostedLocalUsers(current.rows, fresh);
          return {
            ...current,
            rows: [...fresh, ...current.rows.filter((row) => !ghosts.has(row.id) && keepUnconfirmed(row))],
            gap: false,
          };
        });
      }
      setHistory({ kind: "loaded" });
    });
    return () => {
      cancelled = true;
    };
  }, [base, runtimeId, reloadToken]);

  const queued = snapshot.events;
  const queuedSeq = snapshot.eventSeq;
  useEffect(() => {
    if (queued.length === 0) return;
    const unseen = queued.filter((entry) => entry.seq > foldedThrough.current);
    if (unseen.length === 0) return;
    foldedThrough.current = unseen[unseen.length - 1]!.seq;
    // Vouch for frames only while this phone has watched the turn from its
    // start: a backlog batch (a reconnect replay, a restored session's first
    // read) lands after the fact, and its answers must not claim a landing
    // clock the phone never saw.
    const sawStart = unseen.some((entry) => entry.event.kind === "turn_started");
    setTranscript((current) =>
      unseen.reduce(
        (acc, entry) => reduce(acc, entry.event, { stampClock: clockRef?.current !== null }),
        current,
      ),
    );
    // The updater above runs at the next render, and the effect that seeds the
    // clock from `running` only runs after that render's commit — so a turn
    // whose whole run landed in one poll burst would fold with the clock still
    // null and none of its frames stamped. Seeding here, before the updater
    // executes, is what lets the rest of the burst claim a clock the phone did
    // watch land. `??=` keeps a restored turn's missing clock missing. The
    // cost is accepted and bounded: a turn replayed whole by a reconnect also
    // carries a `turn_started`, so its answer draws a clock at the reconnect
    // moment rather than none at all — cosmetic, and the stamp is still later
    // than any frame it labels.
    if (sawStart && clockRef) clockRef.current ??= Date.now();
    // Only the drained frames are acknowledged; anything queued after this
    // render stays for the next one.
    connection.drainEvents(foldedThrough.current);
  }, [queued, queuedSeq, connection]);

  // Keep the copy current. The cache holds what the screen shows, streaming
  // rows included; the history read overwrites them the moment it lands. A
  // gap means the phone missed a stretch — what is on screen is not the
  // conversation, and caching it would redraw the hole tomorrow.
  useEffect(() => {
    if (transcript.gap === true) {
      dropCachedRows([sessionPath, runtimeId]);
      return;
    }
    scheduleSaveRows([sessionPath, runtimeId], transcript.rows);
    // `gap` is in the deps because the fold leaves `rows` untouched when a
    // stream_gap lands — without it a gap that is the last transition of a
    // burst would never evict a cache holding the hole.
  }, [sessionPath, runtimeId, transcript.rows, transcript.gap]);

  /**
   * Read the page before the current oldest one.
   *
   * Fired by the window renderer when the reader's scroll reaches into the
   * spacer and the newest page does not cover the request. Guarded three
   * ways: one read at a time, no cursor means nothing older to ask for, and
   * a read whose rows all land anyway is rare enough not to need a dedupe
   * (the cursor is opaque and moves backward monotonically).
   */
  const olderFailedUntil = useRef(0);
  const loadOlder = useCallback(() => {
    const state = cursorRef.current;
    if (olderLoading.current || !state.hasMoreBefore || !state.nextCursor) return;
    // Only walk a cursor this conversation's newest page produced. A failed
    // or in-flight history read leaves whatever cursor was last on screen —
    // possibly the previous conversation's, if a switch is still settling —
    // and a read against it would prepend foreign messages onto this pane.
    if (historyRef.current.kind !== "loaded") return;
    // A read that just failed stays failed for a while: the trigger effect
    // re-runs on every scroll frame, and a kernel that is timing out would
    // otherwise take a request per frame, silently.
    if (olderFailedUntil.current > Date.now()) return;
    if (!base) return;
    olderLoading.current = true;
    void loadHistory(base, state.nextCursor)
      .then((result) => {
        if (!result.ok) {
          olderFailedUntil.current = Date.now() + OLDER_RETRY_COOLDOWN_MS;
          return;
        }
        const older = result.read.rows;
        setCursor({
          hasMoreBefore: result.read.hasMoreBefore,
          ...(result.read.nextCursor ? { nextCursor: result.read.nextCursor } : {}),
        });
        // Prepend in place: older messages are strictly before everything the
        // pane holds, and the window's own widen keeps the reader's position.
        // Rows already held are dropped rather than drawn twice — a retried
        // cursor or an overlapping page boundary would otherwise put two
        // copies of one message under each other.
        setTranscript((current) => {
          const known = new Set(current.rows.map((row) => row.id));
          const fresh = older.filter((row) => !known.has(row.id));
          return { ...current, rows: [...fresh, ...current.rows] };
        });
      })
      .finally(() => {
        olderLoading.current = false;
      });
  }, [base]);

  return { transcript, history, reload, reloadToken, setTranscript, loadOlder, cursor };
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

/**
 * Studio's rule: a list whose every step is done is spent. The kernel keeps
 * it, and the desktop drops it rather than leaving a finished checklist struck
 * through above the next turn's composer.
 */
function liveTodos(todos: WireTodo[]): WireTodo[] {
  return todos.length > 0 && todos.every((todo) => todo.status === "completed") ? [] : todos;
}

function useTodos(
  base: string | undefined,
  events: readonly QueuedEvent[],
  lastEvent: EventPayload | undefined,
  turnEnd: EventPayload | null,
  reloadToken: number,
): { todos: WireTodo[]; state: TodosState } {
  const [list, setList] = useState<TodoList | null>(null);
  const loadedBase = useRef<string | null>(null);
  const seenRevision = useRef("");
  const failed = useRef(false);
  const request = useRef(0);
  /**
   * The turn-end frame is a second reason to read.
   *
   * A cancel rebuilds the canonical list from the truncated transcript and
   * writes no `todo_progress`; without this read a checklist whose turn was
   * cancelled outlives it on the phone. Identity, not a revision: every
   * `turn_done` is a new payload, and the last one must not cause a read on
   * every render that happens to still be looking at it.
   */
  const seenBoundary = useRef<EventPayload | null>(null);
  const seenReload = useRef(reloadToken);
  /**
   * The newest `todo_progress` in the queue, not in `lastEvent`.
   *
   * Frames arrive in bursts and `lastEvent` keeps only the newest: a progress
   * frame followed by any text delta in the same burst would never be read,
   * and the checklist would lag until the next one. Scanning the queue finds
   * it wherever it sits.
   */
  const progress = (() => {
    for (let at = events.length - 1; at >= 0; at -= 1) {
      const event = events[at]?.event;
      if (event?.kind === "todo_progress") return event.todoProgress;
    }
    return lastEvent?.kind === "todo_progress" ? lastEvent.todoProgress : undefined;
  })();
  const revision = todoRevision(progress);

  useEffect(() => {
    if (!base) return;
    // The turn end is scanned from the whole burst by the caller: a burst keeps
    // only its newest frame in `lastEvent`, which may be anything.
    const boundary = turnEnd;
    const forced =
      (boundary !== null && boundary !== seenBoundary.current) || reloadToken !== seenReload.current;
    const switched = base !== loadedBase.current;
    if (switched) {
      // Another pane's checklist is not this pane's. This records the new
      // base; the render below already hides the old list in the same commit,
      // because an effect runs after paint.
      loadedBase.current = base;
      seenRevision.current = "";
      seenBoundary.current = null;
      seenReload.current = reloadToken;
      failed.current = false;
      setList({ base, todos: [], state: "loading" });
    } else if (!forced && (!progress || (revision === seenRevision.current && !failed.current))) {
      // Not a reason to read: no turn end, no reload, and either no
      // todo_progress frame or a repeat whose clocks have not moved.
      return;
    }
    seenBoundary.current = boundary;
    seenReload.current = reloadToken;
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
      setList({ base, todos: liveTodos(result.items), state: "loaded" });
    });
  }, [base, events, lastEvent, turnEnd, progress, revision, reloadToken]);

  // The first render after a base change still holds the old list — the effect
  // that clears it runs after paint. Hiding a mismatched list here is what
  // keeps one pane's checklist from flashing on another.
  const shown = base !== undefined && list?.base === base ? list : null;
  return { todos: shown?.todos ?? [], state: shown?.state ?? "loading" };
}

export function ChatScreen({
  connection,
  snapshot,
  runtimeId,
  title,
  onBack,
  onNewSession,
  mode,
  focusAsk,
  onFocusConsumed,
  onOpenStudio,
  onOpenBranch,
}: ChatScreenProps) {
  const runtime = snapshot.runtimes.find((candidate) => candidate.id === runtimeId);
  /**
   * The header's Studio entry opens the paired computer's own page, not this
   * conversation's Workbench — the menu already carries that one, and the two
   * must not share a name. An old system WebView is named in settings, where
   * the browser alternative sits beside it; a note here could only be read
   * after the page had already been shown.
   */
  const [studioNote, setStudioNote] = useState("");
  const openStudioFromChat = useCallback(() => {
    if (!onOpenStudio) return;
    setStudioNote("");
    void onOpenStudio()
      .then((result) => {
        if (result.kind === "none") setStudioNote("读不到这台电脑的 Studio 地址。");
        else if (result.kind === "failed") setStudioNote("打不开 Studio。");
      })
      .catch(() => setStudioNote("打不开 Studio。"));
  }, [onOpenStudio]);
  /**
   * When the running turn started being watched; a restored turn has no start.
   * A ref rather than state: the fold loop reads it to vouch for frames.
   */
  const runStartedAtRef = useRef<number | null>(null);
  const { transcript, history, reload, reloadToken, setTranscript, loadOlder, cursor } = useTranscript(
    connection,
    snapshot,
    runtimeId,
    runtime?.base,
    runtime?.sessionPath,
    runStartedAtRef,
  );
  /**
   * The newest turn end in the poll, whichever frame follows it. The checklist
   * and the cache meter both re-read on it, and a burst keeps only its newest
   * payload in `lastEvent`, so the queue is scanned here once.
   */
  const turnEnd = useMemo(() => {
    for (let at = snapshot.events.length - 1; at >= 0; at -= 1) {
      const event = snapshot.events[at]?.event;
      if (event?.kind === "turn_done") return event;
    }
    return snapshot.lastEvent?.kind === "turn_done" ? snapshot.lastEvent : null;
  }, [snapshot.events, snapshot.lastEvent]);
  const { todos, state: todosState } = useTodos(
    runtime?.base,
    snapshot.events,
    snapshot.lastEvent,
    turnEnd,
    reloadToken,
  );
  /** The stored transcript's identity; a pane id is only the fallback. */
  const readingId = readingKey(runtime?.sessionPath, runtimeId);
  // App keys this screen by runtimeId, so this initial value is that pane's
  // draft and no other pane can read it. The save effect below mirrors every
  // keystroke to the same key.
  const [draft, setDraft] = useState(() => loadDraft(readingId));
  /**
   * Where this pane's draft belongs. A pane id changes when the same stored
   * transcript is opened again; the session path does not.
   */
  const draftKey = useRef(readingId);
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [promptError, setPromptError] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** Replies quoted into this message, held as chips above the box. */
  const [quotes, setQuotes] = useState<QuotedReply[]>([]);
  const quoteSeq = useRef(0);
  const [attachError, setAttachError] = useState("");
  /** The picture the viewer is showing, from a sent turn or a pending chip. */
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [atBottom, setAtBottom] = useState(
    () => loadReading(readingId)?.atBottom ?? true,
  );
  /** False once the record sits below its top edge; the up control appears then. */
  const [atTop, setAtTop] = useState(true);
  /** The session's cache split, as the kernel last reported it. */
  const [cache, setCache] = useState<{ hit: number; miss: number; unknown: number } | null>(null);
  /** The model the catalog last confirmed, shown until the transcript reports one. */
  const [pickedModel, setPickedModel] = useState("");
  const [modelSheet, setModelSheet] = useState(false);
  const [approvalSheet, setApprovalSheet] = useState(false);
  const [checkpointsSheet, setCheckpointsSheet] = useState(false);
  /** How full this conversation's window is, and folding it. */
  const [contextSheet, setContextSheet] = useState(false);
  /** This conversation's tool posture, as `/status` reports it. */
  const [approval, setApproval] = useState("");
  /** What the kernel said about the last message sent into a running turn. */
  const [inboxNote, setInboxNote] = useState("");
  /** Whether the queued messages are on screen. */
  const [queueSheet, setQueueSheet] = useState(false);
  /** Plan mode as the kernel reports it; undefined until the first read. */
  const [plan, setPlan] = useState<boolean | undefined>(undefined);
  /** The model `/status` names, until a live turn names one in the transcript. */
  const [statusModel, setStatusModel] = useState("");
  /** The reasoning-effort level `/status` names, empty for the kernel's own choice. */
  const [statusEffort, setStatusEffort] = useState("");
  const [planBusy, setPlanBusy] = useState(false);
  const [attachSheet, setAttachSheet] = useState(false);
  const [headMenu, setHeadMenu] = useState(false);
  /**
   * The workbench takeover: the changes list, its diffs, the commit card, the
   * history and the file browser in the transcript's place. The pane's stream
   * stays attached underneath, so `workspace_changed` frames keep arriving
   * while it is open — that is why the entry lives here and not at the App
   * level, where opening it would tear the stream down.
   */
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  useBackCloser(workbenchOpen, () => setWorkbenchOpen(false));
  /** Finished non-read-only tool calls: every bump hints the tree moved. */
  const wrote = useMemo(
    () =>
      transcript.rows.filter(
        (row) => row.kind === "tool" && !row.running && !row.readOnly,
      ).length,
    [transcript.rows],
  );
  // Read once per mount: the settings screen replaces this one, so returning
  // from it is a fresh mount and must not need an event to notice the change.
  const [fold] = useState(loadFoldMode);
  /** Read once: the composer is remounted per conversation, settings apply next mount. */
  const [enterPref] = useState<EnterPref>(loadEnterPref);
  /** The run whose timeline is open, or one long thought. */
  const [process, setProcess] = useState<{ title: string; steps: ProcessStep[] } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const imageRef = useRef<HTMLInputElement | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const lastRetry = useRef<string>("");
  /** Restored once per mount, after the stored history has been drawn. */
  const restoredReading = useRef(false);
  const readingTimer = useRef<number | null>(null);
  /** The composer's live value, readable after an await without stale state. */
  const draftRef = useRef(draft);
  /** The preview URLs staged right now; the unmount effect reads it, because
      capturing them there would snapshot the empty mount-time list. */
  const stagedUrls = useRef<string[]>([]);
  /** Prompt decisions in flight, by ask/approval id: a second tap on the same
      card while its POST is a round trip away would fire the call twice. */
  const deciding = useRef(new Set<string>());

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  /** Clear both keys a pane may have used, so a stale one cannot come back. */
  const forgetDraft = useCallback(() => {
    clearDraft(draftKey.current);
    if (draftKey.current !== runtimeId) clearDraft(runtimeId);
  }, [runtimeId]);

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
  // is happening. The same read carries the session's cache split, so mount, a
  // turn end and a manual reload are its only moments.
  useEffect(() => {
    const base = runtime?.base;
    if (!base) return;
    let cancelled = false;
    void loadStatus(base).then((result) => {
      if (cancelled || !result.ok) return;
      setPlan(result.status.plan);
      setApproval(result.status.toolApprovalMode ?? "");
      setCache(result.status.cache ?? null);
      if (result.status.modelRef) setStatusModel(result.status.modelRef);
      if (result.status.effort) setStatusEffort(result.status.effort);
      if (!result.status.running) return;
      setTranscript((current) => (current.running ? current : { ...current, running: true }));
    });
    return () => {
      cancelled = true;
    };
  }, [runtime?.base, turnEnd, reloadToken, setTranscript]);

  // The kernel's checkpoints pair a turn with the message index that opened
  // it, which is what lets a row say "this is the turn to go back to". Read on
  // the same moments the status is: mount, a turn end, a manual reload.
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  useEffect(() => {
    const base = runtime?.base;
    if (!base) return;
    let cancelled = false;
    void loadCheckpoints(base).then((next) => {
      if (!cancelled && next) setCheckpoints(next);
    });
    return () => {
      cancelled = true;
    };
  }, [runtime?.base, turnEnd, reloadToken]);

  const turnOf = useCallback(
    (msgIndex: number | undefined) =>
      msgIndex === undefined
        ? undefined
        : checkpoints.find((checkpoint) => checkpoint.msgIndex === msgIndex)?.turn,
    [checkpoints],
  );

  /**
   * Which turn each row belongs to: a user row opens its turn, and the answers
   * and receipts under it belong to the same one.
   */
  const rowTurns = useMemo(() => {
    const byRow = new Map<string, { turn?: number; question?: string }>();
    let turn: number | undefined;
    let question: string | undefined;
    // The newest turn's number lets a fork tell a closed turn from the one
    // still running; a checkpoint list that has not caught up leaves it unset.
    let lastTurn: number | undefined;
    for (const row of transcript.rows) {
      if (row.kind === "user" && row.local !== true) {
        question = row.text;
        turn = turnOf(row.msgIndex);
        lastTurn = turn;
      }
      if (row.kind === "user" || row.kind === "assistant") {
        byRow.set(row.id, {
          ...(turn !== undefined ? { turn } : {}),
          ...(question ? { question } : {}),
        });
      }
    }
    return { byRow, lastTurn };
  }, [transcript.rows, turnOf]);

  // A running turn is exactly the window where the phone may be locked. The
  // The native watcher discovers every open pane; a turn starting here is
  // what makes sure it exists. Leaving the chat does not stop it — another
  // pane may still be running, and the service ends itself when none are.
  useEffect(() => {
    if (!transcript.running || !runtime) return;
    if (mode === "cloud") return;
    const heading = title ?? runtime.name;
    startTurnNotification({
      ...(heading ? { title: heading } : {}),
      base: runtime.base,
      root: runtime.root,
      runtimeId,
    });
  }, [transcript.running, title, runtime?.name, runtime?.base, runtime?.root, runtimeId, mode]);

  const streaming = transcript.running;
  /** Whether there is anything to send: words, a quote, or an attachment. */
  const hasCompose = draft.trim() !== "" || quotes.length > 0 || attachments.length > 0;
  const display = useMemo(
    () => buildDisplay(transcript.rows, transcript.running, fold),
    [transcript.rows, transcript.running, fold],
  );

  // Frames folded while a start is recorded are frames the phone watched land;
  // the fold loop reads this to decide which rows get a clock. A turn restored
  // by a reload has no start here, because the wire carries no wall clock.
  useEffect(() => {
    if (streaming && runStartedAtRef.current === null) runStartedAtRef.current = Date.now();
    if (!streaming && runStartedAtRef.current !== null) runStartedAtRef.current = null;
  }, [streaming]);

  // The pane is on screen; its answer ticking as it grows is the "still
  // working" cue a locked pocket cannot show.
  useStreamHaptics(transcript.rows);

  /**
   * Draw the tail of the conversation, and grow the window as the reader
   * scrolls up.
   *
   * A long session read whole puts thousands of nodes into the DOM at once,
   * and every streaming delta then re-renders all of them — the stutter when
   * flicking through an old pane. The window starts at the newest
   * `INITIAL_TAIL` entries, which is what a pane opens to, and every upward
   * scroll that reaches near the top adds `GROW_BY` more below the spacer.
   * Collapsing back down again on a downward scroll would re-parse rows the
   * reader already paid for and make the top flicker, so the window only
   * ever grows for the life of the pane.
   *
   * Growing prepends entries above the current scroll position, which would
   * otherwise shove the pane's content down. The ref remembers the height
   * before React commits the new entries and the layout effect restores the
   * delta, so the reader's thumb position stays on the same content.
   *
   * The spacer is `min-height` on purpose: when the window already covers
   * everything it must not force a scrollable height of its own.
   */
  const INITIAL_TAIL = 30;
  const GROW_BY = 40;
  const [windowEnd, setWindowEnd] = useState(INITIAL_TAIL);
  const firstVisible = Math.max(0, display.length - windowEnd);
  const visible = display.slice(firstVisible);
  const topSpacer = useRef<HTMLDivElement | null>(null);
  /** scrollHeight captured before a widen commits; the restore adds the delta. */
  const widenFromRef = useRef<number | null>(null);

  useEffect(() => {
    setWindowEnd(INITIAL_TAIL);
  }, [runtimeId]);

  const growWindow = useCallback(() => {
    setWindowEnd((end) => {
      if (end >= display.length) return end;
      const list = listRef.current;
      if (list) widenFromRef.current = list.scrollHeight;
      return Math.min(display.length, end + GROW_BY);
    });
  }, [display.length]);

  // The window can only widen over rows the pane already holds. When the
  // newest page did not carry the whole conversation, growing into the spacer
  // is also the moment to ask the kernel for the page before this one — the
  // load is guarded in useTranscript, so scroll events cannot stack it. The
  // height goes into widenFromRef now: when the older rows commit, the same
  // restore that covers a widen keeps the thumb on the same content.
  const olderTrigger = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    widenFromRef.current = list.scrollHeight;
    loadOlder();
  }, [loadOlder]);

  useEffect(() => {
    if (firstVisible > 0 || !cursor.hasMoreBefore) return;
    const list = listRef.current;
    if (!list) return;
    if (list.scrollTop < 400) olderTrigger();
  }, [firstVisible, cursor.hasMoreBefore, olderTrigger]);

  // Older-page rows land above the window, so the window must grow by the
  // same count or the slice would keep showing only the newest rows and the
  // freshly-read page would sit invisible above it. Live rows append below
  // and leave the window alone — they only ever change this when a stale
  // widenFromRef from a failed older read is consumed, which costs one entry.
  const prevDisplayLen = useRef(display.length);
  useLayoutEffect(() => {
    const added = display.length - prevDisplayLen.current;
    prevDisplayLen.current = display.length;
    if (added <= 0 || widenFromRef.current === null) return;
    setWindowEnd((end) => Math.min(display.length, end + added));
  }, [display.length]);

  // A widen prepends entries above the reader's thumb. Restoring the height
  // delta in the same layout pass as the commit keeps the thumb on the same
  // content — no jump, no flicker.
  useLayoutEffect(() => {
    const from = widenFromRef.current;
    widenFromRef.current = null;
    if (from === null) return;
    const list = listRef.current;
    if (!list) return;
    list.scrollTop += list.scrollHeight - from;
  }, [windowEnd]);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  /** Studio's up control goes straight to the start of the conversation. */
  const scrollToTop = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    setAtTop(true);
    list.scrollTop = 0;
  }, []);

  /**
   * The lower chrome floats over the record so its rows can scroll behind it;
   * the transcript ends with that height as padding, which is why it is
   * measured. The dock grows with a checklist, a notice and a long draft, and
   * a fixed guess would leave the last row behind the composer.
   */
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [dockHeight, setDockHeight] = useState(0);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const measure = () => setDockHeight(Math.round(dock.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(dock);
    return () => watch.disconnect();
  }, [runtime?.base, workbenchOpen]);

  /**
   * A dock that changed height moved the end of the record by the same
   * amount. Pin only a reader who was already at the bottom: the true
   * pre-change gap is the measured gap minus that delta, and sliding past it
   * is what a jump glide looks like from here — it must not be cut short into
   * an instant scroll.
   */
  const lastDockHeight = useRef(0);
  useLayoutEffect(() => {
    const list = listRef.current;
    const delta = dockHeight - lastDockHeight.current;
    lastDockHeight.current = dockHeight;
    if (!list || delta === 0) return;
    const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (gap - delta >= 48) return;
    list.scrollTop = list.scrollHeight;
  }, [dockHeight]);

  // Follow the newest row only while the person is already at the bottom.
  // Yanking the view down while they read back is the single worst thing a
  // streaming transcript can do.
  useLayoutEffect(() => {
    if (!atBottom) return;
    scrollToBottom(false);
  }, [transcript.rows, atBottom, scrollToBottom]);

  // Reopening a conversation puts the reader back where they were. The stored
  // history decides the height, so this waits for it; a pane opened for the
  // first time has no position and follows the newest row.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || restoredReading.current || history.kind !== "loaded") return;
    restoredReading.current = true;
    const saved = loadReading(readingId);
    if (saved && !saved.atBottom) {
      list.scrollTop = saved.top;
      setAtBottom(false);
      setAtTop(saved.top < 48);
    } else {
      list.scrollTop = list.scrollHeight;
      setAtBottom(true);
      setAtTop(list.scrollTop < 48);
    }
  }, [history, readingId]);

  // A notification's 去回答 names the waiting prompt: after history has drawn,
  // land on the newest rows instead of restoring an older reading position.
  useEffect(() => {
    if (!focusAsk || history.kind !== "loaded") return;
    scrollToBottom(false);
    setAtBottom(true);
    setAtTop(listRef.current ? listRef.current.scrollTop < 48 : true);
    onFocusConsumed?.();
  }, [focusAsk, history.kind, scrollToBottom, onFocusConsumed]);

  const persistReading = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    if (readingTimer.current !== null) window.clearTimeout(readingTimer.current);
    readingTimer.current = window.setTimeout(() => {
      readingTimer.current = null;
      const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
      saveReading(readingId, { top: list.scrollTop, atBottom: gap < 48 });
    }, 250);
  }, [readingId]);

  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
    setAtBottom(gap < 48);
    setAtTop(list.scrollTop < 48);
    // Near the top with more above the window: widen it. The 400px lead is
    // enough that the widen lands before the reader hits the spacer.
    if (list.scrollTop < 400) growWindow();
    persistReading();
  }, [persistReading, growWindow]);

  // Leaving flushes the last position; a screen that never finished reading
  // history keeps the position it had rather than overwriting it with zero.
  useEffect(
    () => () => {
      if (readingTimer.current !== null) {
        window.clearTimeout(readingTimer.current);
        readingTimer.current = null;
      }
      const list = listRef.current;
      if (!list || !restoredReading.current) return;
      const gap = list.scrollHeight - list.scrollTop - list.clientHeight;
      saveReading(readingId, { top: list.scrollTop, atBottom: gap < 48 });
    },
    [readingId],
  );

  const grow = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, []);

  const voiceText = useCallback((text: string) => {
    setDraft((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text));
    requestAnimationFrame(() => {
      grow();
      inputRef.current?.focus();
    });
  }, [grow]);
  const voiceError = useCallback((message: string) => setPromptError(message), []);
  const {
    session: voice,
    down: voiceDown,
    move: voiceMove,
    up: voiceUp,
    cancel: cancelVoice,
  } = useDictation({
    onText: voiceText,
    onError: voiceError,
  });

  // A cold link may not know the session path on the first render. When it
  // arrives, adopt the draft taken under the pane id instead of abandoning it
  // at the next remount; a draft already stored under the path wins.
  useEffect(() => {
    if (draftKey.current === readingId) return;
    const previous = draftKey.current;
    draftKey.current = readingId;
    const stored = loadDraft(readingId);
    if (stored !== "") {
      setDraft(stored);
    } else if (draftRef.current !== "") {
      saveDraft(readingId, draftRef.current);
      clearDraft(previous);
    }
  }, [readingId]);

  useEffect(() => {
    saveDraft(draftKey.current, draft);
  }, [draft]);

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

  // The preview URL is ours to release. The live list is mirrored into a ref
  // because the revoke runs on unmount only — capturing state in the unmount
  // effect itself would snapshot the empty mount-time list and leak every
  // image staged since. Revoking a URL already released elsewhere (a removed
  // chip, a sent message) is a harmless no-op.
  useEffect(() => {
    stagedUrls.current = attachments.flatMap((entry) => (entry.url ? [entry.url] : []));
  }, [attachments]);

  useEffect(
    () => () => {
      for (const url of stagedUrls.current) URL.revokeObjectURL(url);
    },
    [],
  );

  // Editing a reference out of the draft is also removing that attachment;
  // otherwise the chip would stay but the turn would not mention the image.
  // Compared one by one so deleting one ref keeps the others.
  useEffect(() => {
    setAttachments((current) => {
      const kept = current.filter((entry) => draft.includes(entry.ref));
      if (kept.length === current.length) return current;
      for (const entry of current) {
        if (!kept.includes(entry) && entry.url) URL.revokeObjectURL(entry.url);
      }
      return kept;
    });
  }, [draft]);

  const pickImage = useCallback(() => {
    imageRef.current?.click();
  }, []);

  const pickFile = useCallback(() => {
    fileRef.current?.click();
  }, []);

  const openCamera = useCallback(() => {
    cameraRef.current?.click();
  }, []);

  /** Re-read plan mode when the sheet opens; it is a hub setting and can move. */
  const openAttach = useCallback(() => {
    setAttachSheet(true);
    if (!runtime) return;
    void loadStatus(runtime.base).then((result) => {
      if (result.ok) setPlan(result.status.plan);
    });
  }, [runtime]);

  /**
   * Plan mode is a runtime setting, not a message: the next turn reads it.
   * The sheet closes first so the composer is visible while the write lands.
   */
  const togglePlan = useCallback(async () => {
    if (!runtime || plan === undefined || planBusy) return;
    const next = !plan;
    setAttachSheet(false);
    setPlanBusy(true);
    const result = await setPlanMode(runtime.base, next);
    setPlanBusy(false);
    if (!result.ok) {
      setPromptError(`没切到计划模式：${result.code}`);
      return;
    }
    setPlan(next);
    setPromptError("");
  }, [runtime, plan, planBusy]);

  /**
   * Upload the chosen files and hold them as chips.
   *
   * Their references ride with the send rather than being typed into the box,
   * so a handful of screenshots does not turn the draft into a list of paths.
   * The picker accepts several at once, and choosing again appends rather than
   * replaces: a phone screenshot flow is "one more thing to show", and making
   * the person re-pick the first file would be worse than the single-file
   * limit it replaces. Each upload is independent, so one failure names that
   * file and the others still land.
   */
  const uploadSelected = useCallback(
    async (files: File[], allImages: boolean) => {
      if (files.length === 0 || !runtime) return;
      setAttachError("");
      setAttaching(true);

      const uploaded: { ref: string; name: string; url?: string; image?: boolean }[] = [];
      const failures: string[] = [];
      for (const file of files) {
        const image = allImages || file.type.startsWith("image/");
        const preview = image ? URL.createObjectURL(file) : "";
        const result = image
          ? await uploadImage(runtime.base, file)
          : await uploadFile(runtime.base, file);
        if (!result.ok) {
          if (preview) URL.revokeObjectURL(preview);
          failures.push(
            `${file.name || (image ? "图片" : "文件")}：${
              image ? imageMessage(result.code) : fileMessage(result.code)
            }`,
          );
          continue;
        }
        uploaded.push({
          ref: result.attachment.ref,
          name: file.name || (image ? "图片" : "文件"),
          ...(preview ? { url: preview, image: true } : {}),
        });
      }

      setAttaching(false);
      if (uploaded.length > 0) setAttachments((current) => [...current, ...uploaded]);
      if (failures.length > 0) setAttachError(failures.join("\n"));
    },
    [runtime],
  );

  const onImage = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void uploadSelected(files, true);
    },
    [uploadSelected],
  );

  const onFile = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void uploadSelected(files, false);
    },
    [uploadSelected],
  );

  const removeAttachment = useCallback((ref: string) => {
    setAttachments((current) => {
      const removed = current.find((entry) => entry.ref === ref);
      if (removed?.url) URL.revokeObjectURL(removed.url);
      return current.filter((entry) => entry.ref !== ref);
    });
    setAttachError("");
  }, []);

  const removeQuote = useCallback((id: string) => {
    setQuotes((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const doSend = useCallback(
    async (text: string, carried?: { quotes: QuotedReply[]; attachments: Attachment[] }) => {
      if (!runtime) return;
      // A snapshot, so a send clears exactly what it carried and leaves a chip
      // picked while the POST was in flight for the next thought. A rewrite or
      // a regenerate replays its own message, so it carries nothing: the chips
      // above the box are the next thought, not part of that one.
      const sentQuotes = carried ? carried.quotes : quotes;
      const sentAttachments = carried ? carried.attachments : attachments;
      const outgoing = isolateImageRefs(
        composeMessage(sentQuotes, sentAttachments.map((entry) => entry.ref), text),
      ).trim();
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
        // Only clear what was actually sent. Text typed while the request was
        // in flight is the next thought, not part of this one.
        if (draftRef.current === text) {
          forgetDraft();
          setDraft("");
        }
        setQuotes((current) =>
          current.filter((entry) => !sentQuotes.some((sent) => sent.id === entry.id)),
        );
        setAttachments((current) => {
          const kept = current.filter((entry) => !sentAttachments.includes(entry));
          for (const entry of current) {
            if (!kept.includes(entry) && entry.url) URL.revokeObjectURL(entry.url);
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
        ...(result.unconfirmed ? { unconfirmed: true } : {}),
      });
      setTranscript((current) => removeLocalUser(current, local.id));
      lastRetry.current = outgoing;
    },
    [runtime, scrollToBottom, attachments, quotes, forgetDraft, setTranscript],
  );

  const [editMessage, setEditMessage] = useState<{ row: UserRow; turn: number } | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const [rewindTurn, setRewindTurn] = useState<number | null>(null);

  /**
   * Hold a reply above the box as one chip. The turn it answers travels with
   * it, so the model is told which reply the question is about; the same reply
   * tapped twice is still one chip.
   */
  const quoteIntoComposer = useCallback(
    (text: string, rowId: string) => {
      const body = text.trim();
      if (!body) return;
      const turn = rowTurns.byRow.get(rowId)?.turn;
      setQuotes((current) =>
        current.some((entry) => entry.text === body && entry.turn === turn)
          ? current
          : [
              ...current,
              {
                id: `q${++quoteSeq.current}`,
                text: body,
                ...(turn !== undefined ? { turn } : {}),
              },
            ],
      );
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [rowTurns],
  );

  /**
   * Rewind to this turn and send new words in its place — Studio's rewrite and
   * regenerate are the same act. Conversation only: the files the turn changed
   * stay, so the words run again against the work that was already done.
   */
  const resendTurn = useCallback(
    async (turn: number, text: string, fromSheet: boolean) => {
      const base = runtime?.base;
      if (!base) return;
      const fail = (message: string) => {
        if (fromSheet) setEditError(message);
        else setPromptError(message);
      };
      if (fromSheet) {
        setEditError("");
        setEditBusy(true);
      }
      const prepared = await prepareRewind(base, turn, "conversation");
      if (!prepared.ok) {
        if (fromSheet) setEditBusy(false);
        fail(rewindMessage(prepared.code));
        return;
      }
      if (!prepared.value.canConversation) {
        if (fromSheet) setEditBusy(false);
        fail(prepared.value.disabledReason ?? "这一轮不能重新生成。");
        return;
      }
      const committed = await commitRewind(base, prepared.value.planId);
      if (fromSheet) setEditBusy(false);
      if (!committed.ok) {
        fail(rewindMessage(committed.code));
        return;
      }
      if (committed.value.ok === false) {
        fail(committed.value.error ?? "内核没有完成这次回退。");
        return;
      }
      if (fromSheet) {
        setEditMessage(null);
        setEditError("");
      }
      await reload();
      await doSend(text, { quotes: [], attachments: [] });
    },
    [runtime?.base, reload, doSend, setEditError, setEditBusy, setEditMessage, setPromptError],
  );

  const branchFromTurn = useCallback(
    async (turn: number) => {
      const base = runtime?.base;
      if (!base) return;
      const name = title ? `${title} · 分支` : "";
      const result = await branchAt(base, turn, name);
      if (!result.ok) {
        setPromptError(branchMessage(result.code));
        return;
      }
      if (!onOpenBranch) {
        setPromptError("这个入口打不开新分支，请在电脑上打开它。");
        return;
      }
      // The fork exists on the host even when the pane cannot be opened here;
      // saying so is better than a tap that appears to do nothing.
      if (!(await onOpenBranch(result.path, name))) {
        setPromptError("分支已经建好，但在手机上打不开它；它就在会话列表里。");
      }
    },
    [runtime?.base, title, onOpenBranch, setPromptError],
  );

  const rowActions = useMemo<RowActions>(
    () => ({
      quote: quoteIntoComposer,
      resend: (turn, text) => void resendTurn(turn, text, false),
      branch: (turn) => void branchFromTurn(turn),
      edit: (row, turn) => {
        setEditError("");
        setEditMessage({ row, turn });
      },
      rewind: (turn) => setRewindTurn(turn),
      turnOf,
    }),
    [quoteIntoComposer, resendTurn, branchFromTurn, turnOf, setEditError, setEditMessage, setRewindTurn],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter breaks the line, Ctrl/⌘+Enter sends — the default, and the
      // convention every other editor on the device follows. The send-mode
      // preference inverts it (Enter sends, Shift+Enter breaks the line).
      // A pinyin keyboard uses Enter to accept a candidate, which arrives as
      // composing input (IME keyCode 229); sending then would ship half a word.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key !== "Enter") return;
      if (enterPref === "newline") {
        // The hardware-keyboard convention: Enter breaks the line, the
        // modifier sends. Shift stays a line break either way.
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          if (send.kind !== "sending" && hasCompose) void doSend(draft);
        }
        return;
      }
      if (!event.shiftKey) {
        event.preventDefault();
        if (send.kind !== "sending" && hasCompose) void doSend(draft);
      }
    },
    [draft, doSend, hasCompose, enterPref, send.kind],
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
      const sentQuotes = quotes;
      const sentAttachments = attachments;
      const text = isolateImageRefs(
        composeMessage(sentQuotes, sentAttachments.map((entry) => entry.ref), draft),
      ).trim();
      if (!text) return;
      setInboxNote(intent === "steer" ? "正在插话…" : "正在排队…");
      setPromptError("");
      const result = await sendToInbox(runtime.base, text, intent);
      if (!result.ok) {
        setInboxNote("");
        setPromptError(inboxMessage(result.code));
        return;
      }
      // A 200 can still be a no: a `rejected_*` disposition means the kernel
      // took nothing, so the composer must keep the message it never held.
      if (result.receipt.disposition.startsWith("rejected")) {
        setInboxNote("");
        setPromptError(receiptText(result.receipt));
        return;
      }
      setInboxNote(receiptText(result.receipt));
      // The kernel holds this message now, so the composer is free for the
      // next thought — the same rule a normal send follows.
      if (draftRef.current === draft) {
        forgetDraft();
        setDraft("");
        setQuotes((current) =>
          current.filter((entry) => !sentQuotes.some((sent) => sent.id === entry.id)),
        );
        setAttachments((current) => {
          const kept = current.filter((entry) => !sentAttachments.includes(entry));
          for (const entry of current) {
            if (!kept.includes(entry) && entry.url) URL.revokeObjectURL(entry.url);
          }
          return kept;
        });
      }
    },
    [runtime, draft, quotes, attachments, forgetDraft],
  );

  const handlers = useMemo<PromptHandlers>(
    () => ({
      onAnswer: (askId, selected) => {
        if (!runtime) return;
        // One decision per prompt: a second tap while the POST is in flight
        // would answer the same ask twice. The kernel calls a repeated
        // identical answer safe, but the round trip is still wasted, and a
        // refusal of a differing repeat is noise a person has to read.
        if (deciding.current.has(askId)) return;
        deciding.current.add(askId);
        const answers = Object.entries(selected).map(([questionId, labels]) => ({
          QuestionID: questionId,
          Selected: labels,
        }));
        // The row is marked answered only once the kernel says so. Optimism
        // here would show a question as settled when the POST was refused —
        // and the kernel's refusal is exactly what the person needs to see.
        void answer(runtime.base, askId, answers)
          .then((result) => {
            if (!result.ok) {
              setPromptError(`没答上：${result.code ?? "unknown"}`);
              return;
            }
            setPromptError("");
            setTranscript((current) => markAnswered(current, askId, selected));
          })
          .finally(() => {
            deciding.current.delete(askId);
          });
      },
      onAnswerSurface: (askId, questionId, values) => {
        if (!runtime) return;
        if (deciding.current.has(askId)) return;
        deciding.current.add(askId);
        // A structured answer is one entry carrying `Value`, with `Selected`
        // empty: the kernel's own validation rejects anything else for a
        // surface question (`Selected` must be empty, and the ask holds
        // exactly one question).
        const entry: WireAskAnswer = { QuestionID: questionId, Selected: [], Value: values };
        void answer(runtime.base, askId, [entry])
          .then((result) => {
            if (!result.ok) {
              setPromptError(`没答上：${result.code ?? "unknown"}`);
              return;
            }
            setPromptError("");
            setTranscript((current) => markAnsweredSurface(current, askId));
          })
          .finally(() => {
            deciding.current.delete(askId);
          });
      },
      onApprove: (approvalId, allow, session, persist) => {
        if (!runtime) return;
        if (deciding.current.has(approvalId)) return;
        deciding.current.add(approvalId);
        void approve(runtime.base, approvalId, allow, session, persist)
          .then((result) => {
            if (!result.ok) {
              setPromptError(`没处理成：${result.code ?? "unknown"}`);
              return;
            }
            setPromptError("");
            setTranscript((current) => closeApproval(current, approvalId, allow ? "allowed" : "denied"));
          })
          .finally(() => {
            deciding.current.delete(approvalId);
          });
      },
    }),
    [runtime, setTranscript],
  );

  // `runtimes` is empty until `GET /runtimes` answers, so a missing runtime is
  // two different states: still asking, or the pane really is gone. Reporting
  // the second while in the first is what a slow network showed — "会话不存在"
  // over a conversation that was merely waiting on the list.
  //
  // The cached rows draw here rather than below: they were read from
  // `runtimeId` alone, which is exactly why they exist before the runtime
  // does. This branch must stay before every hook below it, so the row list is
  // rendered without the machinery that needs a `base`.
  if (!runtime) {
    // `unknown` is the state before the first `/runtimes` answer lands, so it
    // is "still asking", not "settled". Only a real answer — ok, refused, or
    // failed — lets us say the pane is gone.
    const settled =
      snapshot.reach.kind === "ok" ||
      snapshot.reach.kind === "unauthorized" ||
      snapshot.reach.kind === "unreachable";
    const cached = transcript.rows.length > 0;
    return (
      <div className="chat">
        <div className="chat-head">
          <button type="button" className="iconbtn" onClick={onBack} aria-label="返回">
            ←
          </button>
          <div className="title">
            <strong>{settled ? "会话不存在" : "正在打开"}</strong>
          </div>
        </div>
        <div className="centered">
          <div>
            {settled ? (
              <>
                <strong>这个会话已经关掉了</strong>
                它可能被桌面端关闭，或者连接换了。
              </>
            ) : cached ? (
              <>
                <strong>正在读取这个会话</strong>
                已缓存 {transcript.rows.length} 条，连接恢复后显示。
              </>
            ) : (
              <>
                <strong>正在读取这个会话</strong>
                网络慢的时候要等一会儿，已经看过的内容会先显示。
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const openProcess = (entry: { steps: ProcessStep[]; compact?: boolean }) => {
    const tools = entry.steps.filter((step) => step.kind === "tool").length;
    setProcess({
      title: entry.compact
        ? tools > 0
          ? `已处理 ${tools} 个操作`
          : "过程记录"
        : `已处理 ${entry.steps.length} 个操作`,
      steps: entry.steps,
    });
  };


  return (
    <div className="chat" style={{ "--chat-dock": `${dockHeight}px` } as CSSProperties}>
      <div className="chat-head">
        <button type="button" className="iconbtn back" onClick={onBack} aria-label="返回">
          ←
        </button>
        <div className="title">
          <strong>{title ?? runtime.name}</strong>
          <span>
            <span
              className={`dot ${snapshot.stream.kind === "open" ? "ok" : "warn"}`}
              role="img"
              aria-label={snapshot.stream.kind === "open" ? "事件流已连接" : "事件流未连接"}
              title={snapshot.stream.kind === "open" ? "事件流已连接" : "事件流未连接"}
            />
            {runtime.readOnly ? "只读 · " : ""}
            {runtime.name}
          </span>
        </div>
        {onNewSession ? (
          <button type="button" className="iconbtn" onClick={onNewSession} aria-label="在当前项目新建会话">
            ＋
          </button>
        ) : null}
        {onOpenStudio ? (
          <button
            type="button"
            className="iconbtn"
            onClick={openStudioFromChat}
            aria-label="打开 Studio"
            title="打开 Studio"
          >
            <StudioIcon name="panel" />
          </button>
        ) : null}
        <button
          type="button"
          className="iconbtn"
          onClick={() => setHeadMenu(true)}
          aria-label="更多"
        >
          ⋯
        </button>
      </div>

      {studioNote ? (
        <div className="notice error" role="status">
          {studioNote}
        </div>
      ) : null}

      {workbenchOpen && runtime ? (
        <Suspense fallback={<p className="wb-wait">读取中…</p>}>
          <Workbench
            base={runtime.base}
            readOnly={runtime.readOnly === true}
            snapshot={snapshot}
            wrote={wrote}
            onClose={() => setWorkbenchOpen(false)}
          />
        </Suspense>
      ) : (
        <>
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
              {history.kind === "loading" ? (
                <>
                  <strong>正在读这个会话</strong>
                  桌面上跑过的内容会先补上。
                </>
              ) : history.kind === "failed" ? (
                <>
                  <strong>没读到历史</strong>
                  新的消息照常显示，往回翻的内容暂时看不到。
                  <span className="hint">{historyHint(history.code)}</span>
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
          <>
            {firstVisible > 0 || cursor.hasMoreBefore ? (
              <div
                ref={topSpacer}
                className="window-gap"
                style={{ minHeight: 80 }}
                aria-hidden="true"
              />
            ) : null}
            {visible.map((entry) => {
              if (entry.kind === "steps") {
                if (entry.live) {
                  return entry.steps.map((step) => (
                    <ActivityRow
                      key={step.id}
                      step={step}
                      onOpenSheet={(one) => setProcess({ title: "深度思考", steps: [one] })}
                    />
                  ));
                }
                // Compact keeps the run to one summary line, with the run's
                // thinking a fold away in a bounded window of its own.
                const thought = entry.compact === true ? thoughtOf(entry.steps) : null;
                return (
                  <Fragment key={entry.id}>
                    <ProcessSummary
                      steps={entry.steps}
                      running={entry.running}
                      compact={entry.compact === true}
                      onOpen={() => openProcess(entry)}
                    />
                    {thought !== null ? (
                      <ThoughtStrip
                        text={thought.text}
                        {...(thought.thoughtMs !== undefined ? { thoughtMs: thought.thoughtMs } : {})}
                        running={entry.running}
                      />
                    ) : null}
                  </Fragment>
                );
              }
              // Rewinding and regenerating are refused while any turn runs, so
              // those actions wait for the end. A fork is not: a turn that has
              // already closed can be branched mid-run, which is the one action
              // the running turn's rows lose and the earlier ones keep.
              const context = rowTurns.byRow.get(entry.row.id);
              const turn = transcript.running ? undefined : context?.turn;
              const branchTurn =
                context?.turn !== undefined &&
                (!transcript.running || context.turn !== rowTurns.lastTurn)
                  ? context.turn
                  : undefined;
              return (
                <RowView
                  key={entry.id}
                  row={entry.row}
                  base={runtime.base}
                  handlers={handlers}
                  actions={rowActions}
                  {...(turn !== undefined ? { turn } : {})}
                  {...(branchTurn !== undefined ? { branchTurn } : {})}
                  {...(context?.question ? { question: context.question } : {})}
                  compact={fold === "compact"}
                  onOpenImage={setViewingImage}
                />
              );
            })}
          </>
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

      {/* The lower chrome rides above the record instead of shortening it, so
          a row scrolled to the edge can pass under it rather than end at it. */}
      <div className="chat-dock" ref={dockRef}>
        {transcript.rows.length > 0 && !atBottom ? (
          <div className="jump-latest-wrap">
            {!atTop ? (
              <button
                type="button"
                className="jump-latest"
                data-value="up"
                aria-label="回到会话顶部"
                title="回到会话顶部"
                onClick={scrollToTop}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path
                    d="M6 9l6 6 6-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              className="jump-latest"
              data-value="down"
              aria-label="跳到最新"
              title="跳到最新"
              onClick={() => scrollToBottom(false)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                  d="M6 9l6 6 6-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        ) : null}
  
        <TodoPanel todos={todos} state={todosState} />
  
        {/* One strip, highest priority first. Four bars stacked over the
            composer is noise; a person can only act on one thing at a time. */}
        {send.kind === "failed" ? (
          <div className="sendfail" role="alert">
            <span>
              {send.unconfirmed
                ? "不确定这一轮有没有发出去。先刷新确认，别直接重发；原文还在输入框里。"
                : `没发出去：${sendErrorText(send.detail)}`}
            </span>
            {send.unconfirmed ? (
              <button
                type="button"
                onClick={() => {
                  setSend({ kind: "idle" });
                  reload();
                }}
              >
                刷新确认
              </button>
            ) : send.retryable && lastRetry.current ? (
              <button type="button" onClick={() => void doSend(lastRetry.current)}>
                重试
              </button>
            ) : (
              <button type="button" onClick={() => setSend({ kind: "idle" })}>
                知道了
              </button>
            )}
          </div>
        ) : promptError ? (
          <div className="sendfail" role="alert">
            <span>{promptError}</span>
            <button type="button" onClick={() => setPromptError("")}>
              知道了
            </button>
          </div>
        ) : attachError ? (
          <div className="sendfail" role="alert">
            <span>{attachError}</span>
            <button type="button" onClick={() => setAttachError("")}>
              知道了
            </button>
          </div>
        ) : inboxNote ? (
          <div className="inbox-note" role="status">
            <button
              type="button"
              className="inbox-note-open"
              onClick={() => setQueueSheet(true)}
              aria-label="查看排队列表"
            >
              {inboxNote}
            </button>
            <button type="button" onClick={() => setInboxNote("")} aria-label="关闭提示">
              ×
            </button>
          </div>
        ) : null}
  
        {/* While a turn runs, the composer's send button is the stop control, so
            a message typed now needs its own way out. Two buttons rather than
            one: queuing leaves the turn alone, steering joins it. */}
        {streaming && hasCompose && runtime.readOnly !== true ? (
          <div className="interject" role="group" aria-label="发送到运行中的回合">
            <button type="button" className="chip" onClick={() => void sendWhileRunning("followup")}>
              排队
            </button>
            <button type="button" className="chip accent" onClick={() => void sendWhileRunning("steer")}>
              插话
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
          <input
            ref={cameraRef}
            className="file-input"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => void onImage(event)}
          />
          <input
            ref={fileRef}
            className="file-input"
            type="file"
            multiple
            onChange={(event) => void onFile(event)}
          />
          {quotes.length > 0 || attachments.length > 0 ? (
            <div className="composer-chips">
              {quotes.map((entry) => (
                <div className="quote-chip" key={entry.id}>
                  <span className="quote-glyph" aria-hidden="true">
                    ❝
                  </span>
                  <span className="quote-meta">
                    <span className="quote-name">
                      {entry.turn !== undefined ? `引用第 ${entry.turn} 轮回复` : "引用回复"}
                    </span>
                    <span className="quote-lines">{quoteLineCount(entry.text)} 行</span>
                  </span>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label="移除引用"
                    onClick={() => removeQuote(entry.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {attachments.map((entry) => (
                <div className="attachment" key={entry.ref}>
                  {entry.url ? (
                    <button
                      type="button"
                      className="attachment-thumb"
                      aria-label={`放大图片 ${entry.name}`}
                      onClick={() => setViewingImage(entry.url ?? null)}
                    >
                      <img src={entry.url} alt="已选择的图片" />
                    </button>
                  ) : (
                    <span className="attachment-file" aria-hidden="true">
                      {entry.name.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE"}
                    </span>
                  )}
                  <span className="attachment-meta">
                    <span className="attachment-name">{entry.name}</span>
                    <span className="attachment-kind">{entry.image ? "图片" : "文件"}</span>
                  </span>
                  <button
                    type="button"
                    className="chip-remove"
                    aria-label={`移除附件 ${entry.name}`}
                    onClick={() => removeAttachment(entry.ref)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <VoiceLive session={voice} onCancel={cancelVoice} />
          <textarea
            ref={inputRef}
            value={draft}
            placeholder={runtime.readOnly ? "这个会话是只读的" : "描述你的任务"}
            disabled={runtime.readOnly === true}
            rows={1}
            // The soft keyboard's return key says what it does. Off "send" it
            // would keep showing a send arrow while Enter inserts a line break.
            enterKeyHint={enterPref === "send" ? "send" : "enter"}
            onChange={(event) => {
              setDraft(event.target.value);
              grow();
            }}
            onKeyDown={onKeyDown}
          />
          <div className="composer-bar">
            <button
              type="button"
              className="iconbtn attach"
              aria-label="添加图片或计划"
              onClick={openAttach}
              disabled={runtime.readOnly === true || attaching}
            >
              {attaching ? "…" : "＋"}
            </button>
            {runtime.readOnly ? (
              <span className="composer-model">只读</span>
            ) : (
              <button
                type="button"
                className="modelchip"
                onClick={() => setModelSheet(true)}
                aria-label="切换模型"
                title="切换模型"
              >
                {`${shortRef(pickedModel || transcript.modelRef || statusModel || "") || "模型"}${
                  statusEffort ? ` · ${effortDisplayName(statusEffort)}` : ""
                }`}
              </button>
            )}
            {speechSupported() ? (
              <MicButton
                session={voice}
                disabled={runtime.readOnly === true}
                down={voiceDown}
                move={voiceMove}
                up={voiceUp}
              />
            ) : null}
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
                disabled={!hasCompose || send.kind === "sending" || attaching}
                onClick={() => void doSend(draft)}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
        </>
      )}

      {modelSheet ? (
        <ModelSheet
          base={runtime.base}
          {...(transcript.modelRef ? { fallback: transcript.modelRef } : {})}
          onClose={() => setModelSheet(false)}
          onSwitched={(ref) => {
            setPickedModel(ref);
            // The old effort claim does not survive a model switch unverified:
            // the chip drops it until a level is picked on the new model.
            setStatusEffort("");
            setModelSheet(false);
          }}
          onEffortChange={setStatusEffort}
        />
      ) : null}

      {attachSheet ? (
        <AttachSheet
          plan={plan}
          busy={planBusy}
          onClose={() => setAttachSheet(false)}
          onCamera={() => {
            setAttachSheet(false);
            openCamera();
          }}
          onImage={() => {
            setAttachSheet(false);
            pickImage();
          }}
          onFile={() => {
            setAttachSheet(false);
            pickFile();
          }}
          onPlan={() => void togglePlan()}
        />
      ) : null}

      {headMenu ? (
        <HeadMenu
          model={shortRef(pickedModel || transcript.modelRef || statusModel || "")}
          approval={approval}
          cache={cache}
          onClose={() => setHeadMenu(false)}
          onReload={() => {
            setHeadMenu(false);
            reload();
          }}
          onModel={() => {
            setHeadMenu(false);
            setModelSheet(true);
          }}
          onApproval={() => {
            setHeadMenu(false);
            setApprovalSheet(true);
          }}
          onCheckpoints={() => {
            setHeadMenu(false);
            setCheckpointsSheet(true);
          }}
          onQueue={() => {
            setHeadMenu(false);
            setQueueSheet(true);
          }}
          onContext={() => {
            setHeadMenu(false);
            setContextSheet(true);
          }}
          onWorkbench={() => {
            setHeadMenu(false);
            // Without a runtime the takeover would render nothing while the
            // back closer still eats a press; the other sheets gate on
            // runtime the same way.
            if (runtime) setWorkbenchOpen(true);
          }}
        />
      ) : null}

      {approvalSheet && runtime ? (
        <ApprovalSheet
          base={runtime.base}
          current={approval}
          onClose={() => setApprovalSheet(false)}
          onChanged={(nextMode) => {
            setApproval(nextMode);
            setApprovalSheet(false);
          }}
        />
      ) : null}

      {checkpointsSheet && runtime ? (
        <CheckpointsSheet
          base={runtime.base}
          onClose={() => setCheckpointsSheet(false)}
          onRewound={() => reload()}
        />
      ) : null}

      {rewindTurn !== null && runtime ? (
        <CheckpointsSheet
          base={runtime.base}
          turn={rewindTurn}
          onClose={() => setRewindTurn(null)}
          onRewound={() => {
            setRewindTurn(null);
            void reload();
          }}
        />
      ) : null}

      {editMessage ? (
        <EditMessageSheet
          text={editMessage.row.text}
          busy={editBusy}
          error={editError}
          onCancel={() => {
            setEditMessage(null);
            setEditError("");
          }}
          onSend={(text) => void resendTurn(editMessage.turn, text, true)}
        />
      ) : null}

      {contextSheet && runtime ? (
        <ContextSheet
          base={runtime.base}
          onCompacted={() => reload()}
          onClose={() => setContextSheet(false)}
        />
      ) : null}

      {queueSheet && runtime ? (
        <QueueSheet base={runtime.base} onClose={() => setQueueSheet(false)} />
      ) : null}

      {process ? (
        <ProcessSheet
          title={process.title}
          steps={process.steps}
          onClose={() => setProcess(null)}
        />
      ) : null}

      {viewingImage ? (
        <ImageViewer src={viewingImage} onClose={() => setViewingImage(null)} />
      ) : null}
    </div>
  );
}
