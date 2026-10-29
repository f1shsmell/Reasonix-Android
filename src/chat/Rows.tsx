/**
 * One transcript row.
 *
 * A row's job is to say what happened without making a person open something to
 * find out. So a tool call shows its name and whether it is still running while
 * collapsed, and only the detail it exists to hide is inside.
 */

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
  onAnswer: (askId: string, labels: string[]) => void;
  onApprove: (approvalId: string, allow: boolean, remember: boolean) => void;
}

export function AskCard({ row, handlers }: { row: AskRow; handlers: PromptHandlers }) {
  return (
    <div className="row prompt">
      <div className="q">{row.ask.header ?? row.ask.prompt}</div>
      {row.ask.header && row.ask.prompt !== row.ask.header ? (
        <div className="why">{row.ask.prompt}</div>
      ) : null}
      {row.ask.reason ? <div className="why">{row.ask.reason}</div> : null}
      {row.pending ? (
        <div className="choices">
          {row.ask.options.map((option) => (
            <button
              key={option.label}
              type="button"
              onClick={() => handlers.onAnswer(row.ask.id, [option.label])}
            >
              {option.label}
              {option.description ? <small>{option.description}</small> : null}
            </button>
          ))}
        </div>
      ) : (
        <div className="answered">已回答</div>
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
      {approval.reasonCode ? <div className="why"><code>{approval.reasonCode}</code></div> : null}
      {row.pending ? (
        <div className="choices">
          <button
            type="button"
            onClick={() => handlers.onApprove(approval.id, true, approval.allowsSession === true)}
          >
            允许一次
          </button>
          {approval.allowsSession ? (
            <button type="button" onClick={() => handlers.onApprove(approval.id, true, true)}>
              本会话都允许
              <small>{approval.tool}</small>
            </button>
          ) : null}
          <button type="button" onClick={() => handlers.onApprove(approval.id, false, false)}>
            拒绝
          </button>
        </div>
      ) : (
        <div className="answered">已处理</div>
      )}
    </div>
  );
}
