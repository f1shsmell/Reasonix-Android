/**
 * One transcript row.
 *
 * A row's job is to say what happened without making a person open something to
 * find out. So a tool call shows its name and whether it is still running while
 * collapsed, and only the detail it exists to hide is inside.
 */

import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { WireAskQuestion } from "../wire/events";
import type { ApprovalRow, AskRow, AssistantRow, NoticeRow, ToolRow, UserRow } from "./transcript";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { SurfaceCard } from "./SurfaceCard";
import { clockText } from "../app/format";
import { kernelTransport } from "../net/transport";

const IMAGE_REF = /@([^\s@]+\.(?:png|jpe?g|gif|webp|bmp|heic|heif))/gi;

function imageRefs(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IMAGE_REF)) {
    const path = match[1];
    if (path && !found.includes(path)) found.push(path);
  }
  return found;
}

function withoutImageRefs(text: string): string {
  return text
    .replace(IMAGE_REF, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Fetch the stored image through the same transport as the rest of the app. */
function MessageImage({ base, path }: { base: string; path: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    const controller = new AbortController();
    void kernelTransport().fetch(`${base}/workspace/image?path=${encodeURIComponent(path)}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!active || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        // The text reference remains the fallback if the image cannot load.
      });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [base, path]);

  return url ? <img className="message-image" src={url} alt="图片附件" loading="lazy" /> : null;
}

export function UserBubble({ row, base }: { row: UserRow; base?: string }) {
  const refs = base ? imageRefs(row.text) : [];
  const text = refs.length > 0 ? withoutImageRefs(row.text) : row.text;
  return (
    <div className="row user">
      <div className="bubble">
        {text || null}
        {base && refs.length > 0 ? (
          <div className="message-images">
            {refs.map((ref) => (
              <MessageImage key={ref} base={base} path={ref} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function AssistantBubble({ row }: { row: AssistantRow }) {
  // Markdown renders while the answer streams, the way xiaoban does it:
  // useDeferredValue lets React skip re-parsing the growing text when a
  // delta lands mid-input or mid-scroll, so formatting forms progressively
  // without the stutter that forced the raw-text shortcut this replaces.
  // The finished bubble takes the row's own text, never a deferred one.
  const deferredText = useDeferredValue(row.text);
  if (!row.text) return null;
  return (
    <div className={`row assistant${row.streaming ? " streaming" : ""}`}>
      <div className="bubble">
        <Markdown text={row.streaming ? deferredText : row.text} />
        {!row.streaming ? (
          <div className="bubble-actions">
            <CopyButton text={row.text} label="复制回答" />
            {row.finishedAt ? <span className="bubble-at">{clockText(row.finishedAt)}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function diffTone(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (
    /^(diff --git |index |--- |\+\+\+ |new file |deleted file |similarity index |rename |\\ No newline)/.test(
      line,
    )
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

/**
 * Unified diff output: the `+`/`-`/`@@` lines are the whole point of a code
 * tool, and a wall of monospace text hides them. Kept inside the collapsed
 * tool card so the transcript does not grow a second screen of code.
 */
function DiffOutput({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return (
    <pre className="out diff">
      {lines.map((line, index) => {
        const tone = diffTone(line);
        return (
          <span key={index} className={tone ? `line ${tone}` : "line"}>
            {line}
            {index === lines.length - 1 ? "" : "\n"}
          </span>
        );
      })}
    </pre>
  );
}

/**
 * What a tool call actually carried and returned.
 *
 * The step's own row says what ran; this is the detail behind it, drawn inside
 * the activity row or the operation timeline. Thinking is no longer folded in
 * here — it is its own step, so it is not shown twice.
 */
export function ToolDetail({ row }: { row: ToolRow }) {
  return (
    <div className="tool-detail">
      {row.args ? <pre>{row.args}</pre> : null}
      {row.err || row.refusalCode ? (
        <div className="refusal">
          {row.refusalCode ? <code>{row.refusalCode}</code> : null}
          {row.err}
        </div>
      ) : null}
      {row.output ? (
        row.outputDiff ? (
          <DiffOutput text={row.output} />
        ) : (
          <pre className="out">{row.output}</pre>
        )
      ) : null}
    </div>
  );
}

export function NoticeCard({ row }: { row: NoticeRow }) {
  return (
    <div className={`row notice ${row.level}`}>
      <div>{row.text}</div>
      {row.detail ? (
        <details>
          <summary>详情</summary>
          <div>{row.detail}</div>
        </details>
      ) : null}
    </div>
  );
}

export interface PromptHandlers {
  /** Every question in one ask, answered together — the kernel settles them as one. */
  onAnswer: (askId: string, selected: Record<string, string[]>) => void;
  /**
   * A structured question's answer: field values, not labels.
   *
   * The kernel keeps the two apart — a surface answer carries `Value` with
   * `Selected` empty, and a surface ask may hold exactly one question — so
   * this is its own call rather than a shape bolted onto `onAnswer`.
   */
  onAnswerSurface: (askId: string, questionId: string, values: Record<string, unknown>) => void;
  /**
   * `session` grants the rest of this conversation, `persist` writes a rule
   * that outlives it. They are separate because the kernel honours them
   * separately, and a phone that conflated them would silently over-grant.
   */
  onApprove: (approvalId: string, allow: boolean, session: boolean, persist: boolean) => void;
}

/** The kernel's own "write it yourself" option, spelled either way. */
function isOtherOption(label: string): boolean {
  return /^\s*(?:其他|其它|other)(?:\s|[（(—\-:：]|$)/i.test(label);
}

/**
 * One question, and the options it offers.
 *
 * An ask is not a multiple-choice exam. The card always ends with an "other"
 * option that takes free text — a question with no options at all is answerable
 * because of it — and a single-choice pick keeps an optional note box, so an
 * option that asks for more ("paste the output") has somewhere to take it.
 * Desktop AskCard behaves the same way, and the kernel treats both the other
 * text and the note as ordinary selected strings.
 */
function AskQuestionBlock({
  question,
  pending,
  chosen,
  otherOn,
  other,
  note,
  titleFromPrompt = false,
  alwaysOther = false,
  onToggle,
  onToggleOther,
  onOther,
  onNote,
}: {
  question: WireAskQuestion;
  pending: boolean;
  chosen: string[];
  otherOn: boolean;
  other: string;
  note: string;
  /** The tab already names the question, so the prompt itself is the title. */
  titleFromPrompt?: boolean;
  /** Keep the free-answer field visible instead of waiting for "其他". */
  alwaysOther?: boolean;
  onToggle: (label: string) => void;
  onToggleOther: () => void;
  onOther: (text: string) => void;
  onNote: (text: string) => void;
}) {
  const multi = question.multi === true;
  // A newer kernel could omit options for a question type this build does not
  // know. Drawing nothing is correct; crashing the whole transcript is not.
  const offered = Array.isArray(question.options) ? question.options : [];
  const custom = offered.find((option) => isOtherOption(option.label));
  const options = offered.filter((option) => !isOtherOption(option.label));
  const freeOnly = options.length === 0 && custom === undefined;
  const noting = !multi && !otherOn && chosen.length > 0;
  return (
    <div className="question">
      <div className="q">{titleFromPrompt ? question.prompt : question.header ?? question.prompt}</div>
      {!titleFromPrompt && question.header && question.header !== question.prompt ? (
        <div className="why">{question.prompt}</div>
      ) : null}
      {question.reason === "missing_value" ? (
        <div className="why">需要你补一个值，agent 自己找不到。</div>
      ) : null}
      {pending && offered.length > 0 ? (
        <div className="ask-hint">{multi ? "可以选择多项" : "请选择一项"}</div>
      ) : null}
      {pending ? (
        freeOnly ? (
          <input
            className="ask-extra"
            value={other}
            onChange={(event) => onOther(event.target.value)}
            placeholder="输入你的回答"
            aria-label="你的回答"
            autoFocus={alwaysOther}
          />
        ) : (
        <>
          <div className="choices">
            {options.map((option) => {
              const active = chosen.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  className={active ? "chosen" : undefined}
                  aria-pressed={multi ? active : undefined}
                  onClick={() => onToggle(option.label)}
                >
                  <span
                    className={`pick${active ? " on" : ""}${multi ? " box" : ""}`}
                    aria-hidden="true"
                  />
                  <span className="pick-copy">
                    {option.label}
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                </button>
              );
            })}
            <button
              type="button"
              className={`opt-other${otherOn ? " chosen" : ""}`}
              aria-pressed={otherOn}
              onClick={onToggleOther}
            >
              <span className={`pick${otherOn ? " on" : ""}${multi ? " box" : ""}`} aria-hidden="true" />
              <span className="pick-copy">
                {custom?.label ?? "其他 —— 自行填写"}
                {custom?.description ? <small>{custom.description}</small> : null}
              </span>
            </button>
          </div>
          {otherOn || alwaysOther ? (
            <input
              className="ask-extra"
              value={other}
              onChange={(event) => onOther(event.target.value)}
              placeholder="或直接输入你的回答"
              aria-label="其他回答"
              autoFocus={otherOn}
            />
          ) : noting ? (
            <input
              className="ask-extra"
              value={note}
              onChange={(event) => onNote(event.target.value)}
              placeholder="补充说明（可选），会随所选项一起发送"
              aria-label="补充说明"
            />
          ) : null}
        </>
        )
      ) : null}
    </div>
  );
}

export function AskCard({ row, handlers }: { row: AskRow; handlers: PromptHandlers }) {
  // A form with several questions is answered once, so the selection for all
  // of them is held here rather than inside one question block.
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  // Free text is kept apart from picks: an "other" answer left behind by a
  // pick is not a note, and going back to it finds it where it was.
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [step, setStep] = useState(0);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const questions = row.ask.questions;

  const picksOf = (question: WireAskQuestion): string[] =>
    chosen[question.id] ?? question.default ?? [];
  const noting = (question: WireAskQuestion): boolean =>
    question.multi !== true && !otherOn[question.id] && picksOf(question).length > 0;
  const freeOf = (question: WireAskQuestion): string => {
    if (otherOn[question.id]) return (other[question.id] ?? "").trim();
    if (noting(question)) return (note[question.id] ?? "").trim();
    return "";
  };
  /**
   * What this question sends.
   *
   * Both a free-text answer and a pick's note are ordinary selected strings:
   * the kernel joins them into the tool result untouched, and a single-choice
   * question may legitimately carry a label plus its note.
   */
  const valueOf = (question: WireAskQuestion): string[] => {
    const picks = picksOf(question);
    const free = freeOf(question);
    return free ? [...picks, free] : picks;
  };

  const toggle = (question: WireAskQuestion, label: string) => {
    setChosen((current) => {
      const already = current[question.id] ?? [];
      if (question.multi !== true) {
        return { ...current, [question.id]: [label] };
      }
      const next = already.includes(label)
        ? already.filter((entry) => entry !== label)
        : [...already, label];
      return { ...current, [question.id]: next };
    });
    if (question.multi !== true) {
      setOtherOn((current) => ({ ...current, [question.id]: false }));
    }
  };

  const toggleOther = (question: WireAskQuestion) => {
    const on = !otherOn[question.id];
    setOtherOn((current) => ({ ...current, [question.id]: on }));
    if (on && question.multi !== true) {
      setChosen((current) => ({ ...current, [question.id]: [] }));
    }
  };

  const typeOther = (question: WireAskQuestion, text: string) => {
    setOther((current) => ({ ...current, [question.id]: text }));
    if (!text || otherOn[question.id]) return;
    setOtherOn((current) => ({ ...current, [question.id]: true }));
    if (question.multi !== true) {
      setChosen((current) => ({ ...current, [question.id]: [] }));
    }
  };

  const typeNote = (question: WireAskQuestion, text: string) => {
    setNote((current) => ({ ...current, [question.id]: text }));
  };

  const answered = (question: WireAskQuestion): boolean => valueOf(question).length > 0;
  const answeredCount = questions.filter(answered).length;
  const activeIndex = Math.min(step, Math.max(0, questions.length - 1));
  const activeQuestion = questions[activeIndex];

  useEffect(() => {
    const id = activeQuestion?.id;
    if (!id) return;
    tabRefs.current[id]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeQuestion?.id]);

  const ready = questions.every((question) => valueOf(question).length > 0);
  const submit = () => {
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
      answers[question.id] = valueOf(question);
    }
    handlers.onAnswer(row.ask.id, answers);
  };

  // A surface question is a form, not a list of labels. `parseSurface` answers
  // null for a payload this build cannot draw, and falling through to the
  // option path would then show "这个问题没有可选项" — so a question that
  // declares a surface but cannot be parsed is drawn as unanswerable rather
  // than as an option question with nothing to pick.
  const surfaces = questions.filter((question) => question.surface !== undefined);

  // The kernel does not produce a surface inside a multi-question ask, and
  // refuses such an answer. Say so instead of silently dropping the choices.
  if (row.pending && surfaces.length > 0 && questions.length > 1) {
    return (
      <div className="row prompt">
        <div className="prompt-head">无法提交</div>
        <div className="answered">
          这个提问把表单和其他问题混在一起，当前协议不接受这种组合；请让发起方拆成单独的提问。
        </div>
      </div>
    );
  }

  // Several questions arrive in one ask. The phone shows one at a time with
  // the question headers as tabs, so a four-part decision does not become a
  // long wall of controls; every answer still goes back in one call.
  if (row.pending && surfaces.length === 0 && questions.length > 1) {
    const active = Math.min(step, questions.length - 1);
    const question = questions[active];
    if (question) {
      return (
        <div className="row prompt wizard">
          <div className="wizard-head">
            <span className="prompt-head">需要你决定</span>
            <span className="wizard-count">{answeredCount}/{questions.length} 已答</span>
          </div>
          <div className="wizard-tabs" role="tablist" aria-label="问题">
            {questions.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={index === active}
                className={index === active ? "on" : undefined}
                ref={(element) => {
                  tabRefs.current[entry.id] = element;
                }}
                onClick={() => setStep(index)}
              >
                {entry.header ?? `问题 ${index + 1}`}
                {answered(entry) ? <span className="wizard-done" aria-hidden="true">✓</span> : null}
              </button>
            ))}
          </div>
          <div className="wizard-step">
            <AskQuestionBlock
              question={question}
              pending
              titleFromPrompt
              alwaysOther
              chosen={picksOf(question)}
              otherOn={otherOn[question.id] === true}
              other={other[question.id] ?? ""}
              note={note[question.id] ?? ""}
              onToggle={(label) => toggle(question, label)}
              onToggleOther={() => toggleOther(question)}
              onOther={(text) => typeOther(question, text)}
              onNote={(text) => typeNote(question, text)}
            />
          </div>
          <div className="wizard-actions">
            <button
              type="button"
              className="wizard-prev"
              onClick={() => setStep(Math.max(0, active - 1))}
              disabled={active === 0}
            >
              上一题
            </button>
            <span className="wizard-gap" />
            {active < questions.length - 1 ? (
              <button
                type="button"
                className="primary wizard-next"
                onClick={() => setStep(Math.min(questions.length - 1, active + 1))}
              >
                下一题 ({active + 1}/{questions.length})
              </button>
            ) : ready ? (
              <button type="button" className="primary confirm" onClick={submit}>
                提交 {questions.length} 个回答
              </button>
            ) : (
              <button
                type="button"
                className="primary confirm"
                disabled={questions.findIndex((entry) => !answered(entry)) === active}
                onClick={() => {
                  const missing = questions.findIndex((entry) => !answered(entry));
                  if (missing >= 0) setStep(missing);
                }}
              >
                {questions.findIndex((entry) => !answered(entry)) === active
                  ? `还有 ${questions.length - answeredCount} 题未答`
                  : `去补 ${questions.length - answeredCount} 题`}
              </button>
            )}
          </div>
        </div>
      );
    }
  }

  // A surface is never one of several questions: the kernel's answer
  // validation accepts it only as the sole question, and render_surface asks
  // exactly one. A batch therefore mixes choices with free text, not surfaces.
  if (surfaces.length > 0) {
    return (
      <div className="row prompt">
        {surfaces.map((question) => (
          <SurfaceCard
            key={question.id}
            surface={question.surface}
            pending={row.pending}
            onAnswer={(values) => handlers.onAnswerSurface(row.ask.id, question.id, values)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="row prompt">
      <div className="prompt-head">
        <span>问题回答</span>
        {row.pending ? null : <span className="prompt-done" aria-hidden="true">✓</span>}
      </div>
      {questions.map((question) => (
        <AskQuestionBlock
          key={question.id}
          question={question}
          pending={row.pending}
          chosen={picksOf(question)}
          otherOn={otherOn[question.id] === true}
          other={other[question.id] ?? ""}
          note={note[question.id] ?? ""}
          onToggle={(label) => toggle(question, label)}
          onToggleOther={() => toggleOther(question)}
          onOther={(text) => typeOther(question, text)}
          onNote={(text) => typeNote(question, text)}
        />
      ))}
      {row.pending ? (
        <button
          type="button"
          className="confirm"
          disabled={!ready}
          onClick={submit}
        >
          确认
        </button>
      ) : (
        <div className="answered">
          {row.selected
            ? `已回答：${Object.values(row.selected).flat().join("、")}`
            : "已结束，不用再答"}
        </div>
      )}
    </div>
  );
}

export function ApprovalCard({
  row,
  handlers,
}: {
  row: ApprovalRow;
  handlers: PromptHandlers;
}) {
  const approval = row.approval;
  return (
    <div className="row prompt">
      <div className="q">{approval.subject}</div>
      {approval.reason ? <div className="why">{approval.reason}</div> : null}
      {approval.reasonCode ? (
        <div className="why">
          <code>{approval.reasonCode}</code>
        </div>
      ) : null}
      {row.pending ? (
        <div className="choices">
          <button
            type="button"
            onClick={() => handlers.onApprove(approval.id, true, false, false)}
          >
            允许一次
          </button>
          {approval.allowsSession ? (
            <button type="button" onClick={() => handlers.onApprove(approval.id, true, true, false)}>
              本会话都允许
              <small>{approval.tool}</small>
            </button>
          ) : null}
          {approval.allowsPersist ? (
            <button type="button" onClick={() => handlers.onApprove(approval.id, true, true, true)}>
              以后都允许
              <small>写进规则，跨会话生效</small>
            </button>
          ) : null}
          <button type="button" onClick={() => handlers.onApprove(approval.id, false, false, false)}>
            拒绝
          </button>
        </div>
      ) : (
        <div className="answered">{row.outcome === "turn_ended" ? "这一轮已结束" : "已处理"}</div>
      )}
    </div>
  );
}