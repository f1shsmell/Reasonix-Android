/**
 * One transcript row.
 *
 * A row's job is to say what happened without making a person open something to
 * find out. So a tool call shows its name and whether it is still running while
 * collapsed, and only the detail it exists to hide is inside.
 */

import { useState } from "react";
import type { WireAskQuestion } from "../wire/events";
import type { ApprovalRow, AskRow, AssistantRow, NoticeRow, ToolRow, UserRow } from "./transcript";

export function UserBubble({ row }: { row: UserRow }) {
  return (
    <div className="row user">
      <div className="bubble">{row.text}</div>
    </div>
  );
}

export function AssistantBubble({ row }: { row: AssistantRow }) {
  const showReasoning = row.reasoning.trim().length > 0;
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
        {row.text ? <div className="md">{row.text}</div> : null}
      </div>
    </div>
  );
}

function toolStatus(row: ToolRow): { label: string; tone: string } {
  if (row.running) return { label: "运行中", tone: "running" };
  if (row.err || row.refusalCode) return { label: "失败", tone: "failed" };
  return { label: "完成", tone: "done" };
}

export function ToolCard({ row }: { row: ToolRow }) {
  const status = toolStatus(row);
  return (
    <details className="row tool">
      <summary>
        <span className={`status ${status.tone}`}>{status.label}</span>
        <span className="name">{row.name}</span>
        {row.readOnly ? <span className="status">只读</span> : null}
      </summary>
      {row.args ? <pre>{row.args}</pre> : null}
      {row.err || row.refusalCode ? (
        <div className="refusal">
          {row.refusalCode ? <code>{row.refusalCode}</code> : null}
          {row.err}
        </div>
      ) : null}
      {row.output ? (
        <pre className="out" data-diff={row.outputDiff ? "" : undefined}>
          {row.output}
        </pre>
      ) : null}
    </details>
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
        <div className="choices">
          {question.options.map((option) => {
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

  const ready = questions.every((question) => (chosen[question.id] ?? []).length > 0);

  return (
    <div className="row prompt">
      {questions.map((question) => (
        <AskQuestionBlock
          key={question.id}
          question={question}
          pending={row.pending}
          chosen={chosen[question.id] ?? question.default ?? []}
          onToggle={(label) => toggle(question, label)}
        />
      ))}
      {row.pending ? (
        <button
          type="button"
          className="confirm"
          disabled={!ready}
          onClick={() => handlers.onAnswer(row.ask.id, chosen)}
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