/**
 * The transcript as a task record.
 *
 * The kernel emits a long sequence of small rows: a thought, a tool call, a
 * thought, another call, and finally an answer. Drawn one card each, a phone
 * scrolls through a wall of steps before reaching the words it came for. This
 * module keeps the steps — they are the record — but groups a finished run
 * into one "已处理 N 个操作" entry.
 *
 * How much is grouped is the transcript's fold preference: standard groups a
 * finished run but draws a running one step by step; compact groups even a
 * running run and drops thinking; full never groups. Pure and transport-free.
 */

import type { FoldMode } from "./folding";
import type {
  ApprovalRow,
  AskRow,
  AssistantRow,
  NoticeRow,
  Row,
  ToolRow,
  UserRow,
} from "./transcript";
import { CATEGORY_LABELS, toolCategory } from "./toolMeta";
import type { ToolCategory } from "./toolMeta";

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
  | {
      kind: "steps";
      id: string;
      steps: ProcessStep[];
      /** Draw each step as its own row instead of one summary. */
      live: boolean;
      /** The run is still in flight, so a summary row must say so. */
      running: boolean;
    }
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
 * `trailing` marks the run the turn is still producing. In standard mode that
 * run stays individual, because watching each step is the point while work is
 * happening; compact summarises it and drops thinking; full never groups.
 */
export function buildDisplay(
  rows: Row[],
  running: boolean,
  fold: FoldMode = "standard",
): DisplayRow[] {
  const out: DisplayRow[] = [];
  let steps: ProcessStep[] = [];

  const flush = (trailing: boolean) => {
    if (steps.length === 0) return;
    const live = fold === "full" ? true : fold === "compact" ? false : trailing || steps.length === 1;
    out.push({
      kind: "steps",
      id: `steps:${steps[0]?.id ?? out.length}`,
      steps,
      live,
      running: trailing,
    });
    steps = [];
  };

  const thinking = (id: string, text: string, thoughtMs?: number) => {
    // Compact is about reaching the answer: a thought is not drawn on its own.
    if (fold === "compact") return;
    steps.push(stepOfReasoning(id, text, thoughtMs));
  };

  for (const row of rows) {
    switch (row.kind) {
      case "assistant": {
        if (row.reasoning.trim()) thinking(row.id, row.reasoning, row.thoughtMs);
        if (row.text.trim()) {
          flush(false);
          out.push({ kind: "assistant", id: row.id, row });
        }
        break;
      }
      case "tool": {
        // A tool step's thinking belongs before the call it led to.
        if (row.reasoning?.trim()) thinking(row.id, row.reasoning);
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

export interface RankedCategory {
  category: ToolCategory;
  count: number;
}

/**
 * What a finished run was made of, biggest family first.
 *
 * A bare "5 个操作" says how much happened, not what. Ranking the tool
 * families gives the collapsed row a title a person can scan ("读取、搜索、
 * 执行命令"), while the timeline still carries every step.
 */
export function processCategories(steps: ProcessStep[]): RankedCategory[] {
  const seen = new Map<ToolCategory, { count: number; first: number }>();
  steps.forEach((step, index) => {
    if (step.kind !== "tool") return;
    const category = toolCategory(step.row.name);
    const current = seen.get(category);
    if (current === undefined) seen.set(category, { count: 1, first: index });
    else current.count += 1;
  });
  return [...seen.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .map(([category, value]) => ({ category, count: value.count }));
}

/** The collapsed row's title: at most three families, then "等". */
export function processTitle(steps: ProcessStep[]): string {
  const ranked = processCategories(steps);
  if (ranked.length === 0) return "深度思考";
  const labels = ranked.slice(0, 3).map((entry) => CATEGORY_LABELS[entry.category]);
  return labels.join("、") + (ranked.length > 3 ? "等" : "");
}
