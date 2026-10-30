/**
 * One transcript row.
 *
 * A row's job is to say what happened without making a person open something to
 * find out. So a tool call shows its name and whether it is still running while
 * collapsed, and only the detail it exists to hide is inside.
 */

import { useEffect, useState } from "react";
import type { WireAskQuestion } from "../wire/events";
import type { ApprovalRow, AskRow, AssistantRow, NoticeRow, ToolRow, UserRow } from "./transcript";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { SurfaceCard } from "./SurfaceCard";

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
    void fetch(`${base}/workspace/image?path=${encodeURIComponent(path)}`, {
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
  const showReasoning = row.reasoning.trim().length > 0;
  if (!showReasoning && !row.text) return null;
  return (
    <div className={`row assistant${row.streaming ? " streaming" : ""}`}>
      <div className="bubble">
        {showReasoning ? (
          <details className="reasoning">
            <summary>
              {row.thoughtMs !== undefined
                ? `思考了 ${Math.round(row.thoughtMs / 1000)} 秒`
                : "思考过程"}
            </summary>
            <div className="body">{row.reasoning}</div>
          </details>
        ) : null}
        {row.text ? (
          row.streaming ? (
            // Markdown is parsed once the answer is finished: re-parsing the
            // whole growing text on every delta makes a long answer stutter.
            <div className="md streaming-text">{row.text}</div>
          ) : (
            <Markdown text={row.text} />
          )
        ) : null}
        {!row.streaming && row.text ? (
          <div className="bubble-actions">
            <CopyButton text={row.text} label="复制回答" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function toolStatus(row: ToolRow): { label: string; tone: string } {
  if (row.running) return { label: "运行中", tone: "running" };
  if (row.err || row.refusalCode) return { label: "失败", tone: "failed" };
  return { label: "完成", tone: "done" };
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

export function ToolCard({ row }: { row: ToolRow }) {
  const status = toolStatus(row);
  return (
    <div className="row">
      <details className="tool">
        <summary>
          <span className={`status ${status.tone}`}>{status.label}</span>
          <span className="name">{row.name}</span>
          {row.readOnly ? <span className="status">只读</span> : null}
          {row.reasoning ? <span className="status thought">想过</span> : null}
        </summary>
        {/* The thought that led to this call. Folded into the card so a step is
            one record: what it thought, what it ran, what came back. */}
        {row.reasoning ? (
          <details className="reasoning">
            <summary>思考过程</summary>
            <div className="body">{row.reasoning}</div>
          </details>
        ) : null}
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
      </details>
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

/**
 * One question, and the options it offers.
 *
 * Multi-select questions exist (`multi: true`), and a phone that rendered them
 * as single-select would send one answer where the person picked two. So the
 * selection is local state and is only sent when it is complete.
 */
function AskQuestionBlock({
  question,
  pending,
  chosen,
  onToggle,
}: {
  question: WireAskQuestion;
  pending: boolean;
  chosen: string[];
  onToggle: (label: string) => void;
}) {
  const multi = question.multi === true;
  // A newer kernel could omit options for a question type this build does not
  // know. Drawing nothing is correct; crashing the whole transcript is not.
  const options = Array.isArray(question.options) ? question.options : [];
  return (
    <div className="question">
      <div className="q">{question.header ?? question.prompt}</div>
      {question.header && question.header !== question.prompt ? (
        <div className="why">{question.prompt}</div>
      ) : null}
      {question.reason === "missing_value" ? (
        <div className="why">需要你补一个值，agent 自己找不到。</div>
      ) : null}
      {pending ? (
        options.length === 0 ? (
          <div className="why">这个问题没有可选项。</div>
        ) : (
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
                  {option.label}
                  {option.description ? <small>{option.description}</small> : null}
                </button>
              );
            })}
          </div>
        )
      ) : null}
    </div>
  );
}

export function AskCard({ row, handlers }: { row: AskRow; handlers: PromptHandlers }) {
  // A form with several questions is answered once, so the selection for all
  // of them is held here rather than inside one question block.
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const questions = row.ask.questions;

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
  };

  const valueOf = (question: WireAskQuestion): string[] =>
    chosen[question.id] ?? question.default ?? [];
  const ready = questions.every((question) => valueOf(question).length > 0);
  const submit = () => {
    const answers: Record<string, string[]> = {};
    for (const question of questions) {
      const value = valueOf(question);
      if (value.length > 0) answers[question.id] = value;
    }
    handlers.onAnswer(row.ask.id, answers);
  };

  // A surface question is a form, not a list of labels. `parseSurface` answers
  // null for a payload this build cannot draw, and falling through to the
  // option path would then show "这个问题没有可选项" — so a question that
  // declares a surface but cannot be parsed is drawn as unanswerable rather
  // than as an option question with nothing to pick.
  const surfaces = questions.filter((question) => question.surface !== undefined);
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
      {questions.map((question) => (
        <AskQuestionBlock
          key={question.id}
          question={question}
          pending={row.pending}
          chosen={valueOf(question)}
          onToggle={(label) => toggle(question, label)}
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