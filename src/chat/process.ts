/**
 * The transcript as a task record.
 *
 * The kernel emits a long sequence of small rows: a thought, a tool call, a
 * thought, another call, and finally an answer. Drawn one card each, a phone
 * scrolls through a wall of steps before reaching the words it came for. This
 * module keeps the steps — they are the record — but groups a finished run
 * into one "已处理 N 个操作" entry. A run that is still going stays individual,
 * because that is when watching each step is useful.
 *
 * Pure and transport-free: the caller supplies the folded rows.
 */

import type {
  ApprovalRow,
  AskRow,
  AssistantRow,
  NoticeRow,
  Row,
  ToolRow,
  UserRow,
} from "./transcript";

export type ProcessStep =
  | {
      kind: "reasoning";
      id: string;
      text: string;
      thoughtMs?: number;
    }
  | {
      kind: "tool";
      id: string;
      row: ToolRow;
    };

export type DisplayRow =
  | { kind: "steps"; id: string; steps: ProcessStep[]; live: boolean }
  | { kind: "assistant"; id: string; row: AssistantRow }
  | { kind: "user"; id: string; row: UserRow }
  | { kind: "ask"; id: string; row: AskRow }
  | { kind: "approval"; id: string; row: ApprovalRow }
  | { kind: "notice"; id: string; row: NoticeRow };

function stepOfReasoning(id: string, text: string, thoughtMs?: number): ProcessStep {
  return {
    kind: "reasoning",
    id: `${id}:think`,
    text,
    ...(thoughtMs !== undefined ? { thoughtMs } : {}),
  };
}

/**
 * Fold a transcript into rows the chat can draw.
 *
 * `live` means "draw the steps individually": true for a single step, and for
 * the trailing run while the turn is still in flight. Everything else with
 * more than one step becomes a summary row.
 */
export function buildDisplay(rows: Row[], running: boolean): DisplayRow[] {
  const out: DisplayRow[] = [];
  let steps: ProcessStep[] = [];

  const flush = (live: boolean) => {
    if (steps.length === 0) return;
    out.push({ kind: "steps", id: `steps:${steps[0]?.id ?? out.length}`, steps, live: live || steps.length === 1 });
    steps = [];
  };

  for (const row of rows) {
    switch (row.kind) {
      case "assistant": {
        if (row.reasoning.trim()) {
          steps.push(stepOfReasoning(row.id, row.reasoning, row.thoughtMs));
        }
        if (row.text.trim()) {
          flush(false);
          out.push({ kind: "assistant", id: row.id, row });
        }
        break;
      }
      case "tool": {
        // A tool step's thinking belongs before the call it led to.
        if (row.reasoning?.trim()) {
          steps.push(stepOfReasoning(row.id, row.reasoning));
        }
        steps.push({ kind: "tool", id: row.id, row });
        break;
      }
      default: {
        flush(false);
        out.push({ kind: row.kind, id: row.id, row } as DisplayRow);
        break;
      }
    }
  }
  flush(running);
  return out;
}
