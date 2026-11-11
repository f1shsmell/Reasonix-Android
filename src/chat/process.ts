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
 * running run and keeps thinking folded rather than dropped; full never
 * groups. Pure and transport-free.
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
    }
  | {
      /** An intermediate assistant message, kept in the timeline behind a summary. */
      kind: "text";
      id: string;
      text: string;
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
      /** Compact mode's Qoder-style "已处理 N 个操作" summary. */
      compact?: boolean;
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
 * happening; compact summarises it with thinking folded along; full never
 * groups.
 */
export function buildDisplay(
  rows: Row[],
  running: boolean,
  fold: FoldMode = "standard",
): DisplayRow[] {
  if (fold === "compact") return buildCompact(rows, running);
  const out: DisplayRow[] = [];
  let steps: ProcessStep[] = [];

  const flush = (trailing: boolean) => {
    if (steps.length === 0) return;
    const live = fold === "full" ? true : trailing || steps.length === 1;
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

/**
 * Compact mode: one collapsed run and the words that ended it.
 *
 * A turn's early steps — tools, thinking, and the narration between them —
 * are process, not answer. They fold into one "已处理 N 个操作" row; only the
 * last assistant message of each stretch between interactions is drawn as a
 * bubble. Interactions (ask, approval, notice) stay in place, so a turn that
 * pauses for a decision still reads in order.
 */
function buildCompact(rows: Row[], running: boolean): DisplayRow[] {
  const out: DisplayRow[] = [];
  let segment: Row[] = [];

  const stepsOf = (slice: Row[]): ProcessStep[] => {
    const steps: ProcessStep[] = [];
    for (const row of slice) {
      if (row.kind === "tool") {
        // A call's thinking belongs before the call it led to, as elsewhere.
        if (row.reasoning?.trim()) steps.push(stepOfReasoning(row.id, row.reasoning));
        steps.push({ kind: "tool", id: row.id, row });
      } else if (row.kind === "assistant") {
        // Thinking is process, not answer: it rides in the folded record so
        // the compact sheet and the thought window can still reach it.
        if (row.reasoning.trim()) steps.push(stepOfReasoning(row.id, row.reasoning, row.thoughtMs));
        if (row.text.trim()) steps.push({ kind: "text", id: row.id, text: row.text });
      }
    }
    return steps;
  };

  const pushSteps = (steps: ProcessStep[], trailing: boolean): void => {
    if (steps.length === 0) return;
    out.push({
      kind: "steps",
      id: `steps:${steps[0]?.id ?? out.length}`,
      steps,
      live: false,
      running: trailing,
      compact: true,
    });
  };

  const flush = (trailing: boolean): void => {
    if (segment.length === 0) return;
    let final = -1;
    for (let index = segment.length - 1; index >= 0; index -= 1) {
      const row = segment[index];
      if (row?.kind === "assistant" && row.text.trim()) {
        final = index;
        break;
      }
    }
    // A running turn whose last row is an empty assistant is still waiting
    // for its answer; promoting an earlier narration would draw a bubble that
    // disappears as soon as the first delta lands.
    const tail = segment[segment.length - 1];
    if (trailing && tail?.kind === "assistant" && !tail.text.trim()) final = -1;
    if (final < 0) {
      pushSteps(stepsOf(segment), trailing);
    } else {
      pushSteps(stepsOf(segment.slice(0, final)), false);
      const answer = segment[final];
      if (answer?.kind === "assistant") {
        out.push({ kind: "assistant", id: answer.id, row: answer });
      }
      pushSteps(stepsOf(segment.slice(final + 1)), trailing);
    }
    segment = [];
  };

  for (const row of rows) {
    if (row.kind === "assistant" || row.kind === "tool") {
      segment.push(row);
      continue;
    }
    flush(false);
    out.push({ kind: row.kind, id: row.id, row } as DisplayRow);
  }
  flush(running);
  return out;
}

/**
 * A run's thinking as one window's worth: the thoughts in order, and the
 * seconds they measured together. Null when the run never thought — a fold
 * with nothing behind it is not drawn.
 */
export function thoughtOf(steps: ProcessStep[]): { text: string; thoughtMs?: number } | null {
  const thoughts = steps.filter((step) => step.kind === "reasoning");
  const text = thoughts
    .map((step) => (step.kind === "reasoning" ? step.text : ""))
    .filter((part) => part.trim())
    .join("\n\n");
  if (!text) return null;
  const measured = thoughts.filter(
    (step) => step.kind === "reasoning" && step.thoughtMs !== undefined,
  );
  if (measured.length === 0) return { text };
  const ms = measured.reduce((sum, step) => sum + (step.kind === "reasoning" ? (step.thoughtMs ?? 0) : 0), 0);
  return { text, thoughtMs: ms };
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
  if (ranked.length === 0) {
    return steps.some((step) => step.kind === "text") ? "过程" : "深度思考";
  }
  const labels = ranked.slice(0, 3).map((entry) => CATEGORY_LABELS[entry.category]);
  return labels.join("、") + (ranked.length > 3 ? "等" : "");
}
