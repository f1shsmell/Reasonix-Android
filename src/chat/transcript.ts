/**
 * Folds an event stream into the rows a phone renders.
 *
 * The kernel streams deltas; a person reads turns. The fold answers three
 * questions the wire does not: when a run of `text` becomes one bubble, when a
 * tool call belongs to the turn above it, and what a turn that never finished
 * leaves behind.
 *
 * Rows are appended and mutated in place, and the array is copied on every
 * change, so a renderer can compare by reference and key on row id.
 */

import type { EventPayload, WireAsk, WireApproval, WireTool } from "../wire/events";

export interface ToolRow {
  kind: "tool";
  id: string;
  name: string;
  args?: string;
  output?: string;
  err?: string;
  refusalCode?: string;
  outputDiff: boolean;
  readOnly: boolean;
  /** A dispatch with no result yet: the call is still running. */
  running: boolean;
}

export interface AssistantRow {
  kind: "assistant";
  id: string;
  text: string;
  reasoning: string;
  thoughtMs?: number;
  streaming: boolean;
}

export interface UserRow {
  kind: "user";
  id: string;
  text: string;
}

export interface NoticeRow {
  kind: "notice";
  id: string;
  text: string;
  detail?: string;
  level: string;
}

export interface AskRow {
  kind: "ask";
  id: string;
  ask: WireAsk;
  /** Cleared once answered; the row stays as the record of what was asked. */
  pending: boolean;
  /**
   * What the person picked, by question id. Kept so a row answered on another
   * device — which therefore never saw its own reply — still reads as answered
   * rather than as a prompt nobody got to.
   */
  selected?: Record<string, string[]>;
}

export interface ApprovalRow {
  kind: "approval";
  id: string;
  approval: WireApproval;
  pending: boolean;
  /** How it was settled, once something said so. */
  outcome?: string;
}

export type Row =
  | UserRow
  | AssistantRow
  | ToolRow
  | NoticeRow
  | AskRow
  | ApprovalRow;

export interface Transcript {
  rows: Row[];
  /** True between `turn_started` and `turn_done`. */
  running: boolean;
  /** Set when the last turn ended in failure or cancellation. */
  ended?: { cancelled: boolean; error?: string; outcome?: string };
  /** The model the last turn named, for the composer to show. */
  modelRef?: string;
}

export const emptyTranscript: Transcript = { rows: [], running: false };

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/** Reset the id counter. Tests only: ids must stay stable within a session. */
export function resetIds(): void {
  counter = 0;
}

/**
 * The kernel keeps operator notices ("no API key set") out of the end-user
 * conversation, and so does the phone: that audience is about the machine.
 */
function isOperatorNotice(event: EventPayload): boolean {
  return event.audience === "operator";
}

function openAssistant(): AssistantRow {
  return {
    kind: "assistant",
    id: nextId("assistant"),
    text: "",
    reasoning: "",
    streaming: true,
  };
}

function isOpenAssistant(row: Row): row is AssistantRow {
  return row.kind === "assistant" && row.streaming;
}

/**
 * Append, or extend the last row when it is the one this event continues.
 *
 * Neither branch mutates: a renderer holds the previous transcript, and a fold
 * that edits rows in place would rewrite a snapshot already on screen.
 */
function appendOrExtend<T extends Row>(
  rows: Row[],
  extendsLast: (row: Row) => boolean,
  make: () => T,
  extend: (row: T) => T,
): Row[] {
  const last = rows[rows.length - 1];
  if (last !== undefined && extendsLast(last)) {
    return [...rows.slice(0, -1), extend(last as T)];
  }
  return [...rows, make()];
}

function closeStreaming(rows: Row[]): Row[] {
  return rows.map((row) => {
    if (row.kind === "assistant" && row.streaming) return { ...row, streaming: false };
    if (row.kind === "tool" && row.running) return { ...row, running: false };
    return row;
  });
}

/**
 * Close the prompt with this id, and only that one.
 *
 * Returns the array it was given when nothing matched, so a receipt for a
 * prompt this transcript never drew costs no re-render.
 */
function closePrompt(rows: Row[], id: string, outcome: string): Row[] {
  let changed = false;
  const next = rows.map((row) => {
    if (row.kind === "ask" && row.pending && row.id === id) {
      changed = true;
      return { ...row, pending: false };
    }
    if (row.kind === "approval" && row.pending && row.id === id) {
      changed = true;
      return { ...row, pending: false, outcome };
    }
    return row;
  });
  return changed ? next : rows;
}

/**
 * Close every prompt still waiting.
 *
 * A turn that ended cannot be waiting on a question: the ask broker settles
 * anything it was blocked on when the turn goes away. So a prompt left pending
 * past `turn_done` is one whose receipt was lost, and leaving it pending would
 * show a question that can never be answered.
 */
function closePending(rows: Row[]): Row[] {
  let changed = false;
  const next = rows.map((row) => {
    if (row.kind === "ask" && row.pending) {
      changed = true;
      return { ...row, pending: false };
    }
    if (row.kind === "approval" && row.pending) {
      changed = true;
      return { ...row, pending: false, outcome: "turn_ended" };
    }
    return row;
  });
  return changed ? next : rows;
}

/**
 * Close an approval this screen settled itself.
 *
 * The kernel also sends a receipt for it, but that is a separate round trip
 * through the stream: without this the card keeps its buttons until the
 * receipt arrives, and a person who taps twice sends two answers.
 */
export function closeApproval(
  transcript: Transcript,
  approvalId: string,
  outcome: string,
): Transcript {
  const rows = closePrompt(transcript.rows, approvalId, outcome);
  return rows === transcript.rows ? transcript : { ...transcript, rows };
}

/** Record what was picked, so the row can say it after the fact. */
export function markAnswered(
  transcript: Transcript,
  askId: string,
  selected: Record<string, string[]>,
): Transcript {
  let changed = false;
  const rows = transcript.rows.map((row) => {
    if (row.kind !== "ask" || row.id !== askId) return row;
    changed = true;
    return { ...row, pending: false, selected: { ...row.selected, ...selected } };
  });
  return changed ? { ...transcript, rows } : transcript;
}

function toolRow(tool: WireTool, fallbackId: string, running: boolean): ToolRow {
  const base: ToolRow = {
    kind: "tool",
    // The kernel's own id when it has one: a result pairs against it.
    id: tool.id !== undefined && tool.id !== "" ? tool.id : fallbackId,
    name: tool.name,
    outputDiff: tool.outputDiff === true,
    readOnly: tool.readOnly === true,
    running,
  };
  if (tool.args) base.args = tool.args;
  if (tool.output) base.output = tool.output;
  if (tool.err) base.err = tool.err;
  if (tool.refusalCode) base.refusalCode = tool.refusalCode;
  return base;
}

/**
 * Apply one event.
 *
 * Returns the same object when nothing changed, so a renderer can skip frames
 * that only carry transport metadata.
 */
export function reduce(transcript: Transcript, event: EventPayload): Transcript {
  switch (event.kind) {
    case "turn_started": {
      // A new turn closes whatever bubble the last one left open: a turn that
      // died mid-stream must not keep absorbing the next turn's text.
      const rows = closeStreaming(transcript.rows);
      const next: Transcript = {
        rows,
        running: true,
        ...(typeof event.modelRef === "string" ? { modelRef: event.modelRef } : {}),
      };
      const text = typeof event.text === "string" ? event.text : "";
      if (!text) return next;
      return { ...next, rows: [...rows, { kind: "user", id: nextId("user"), text }] };
    }

    case "steer": {
      const text = typeof event.text === "string" ? event.text : "";
      if (!text) return transcript;
      return {
        ...transcript,
        rows: [...transcript.rows, { kind: "user", id: nextId("steer"), text }],
      };
    }

    case "text": {
      const delta = typeof event.text === "string" ? event.text : "";
      if (!delta) return transcript;
      const rows = appendOrExtend(
        transcript.rows,
        isOpenAssistant,
        () => ({ ...openAssistant(), text: delta }),
        (row) => ({ ...row, text: row.text + delta }),
      );
      return { ...transcript, rows };
    }

    case "reasoning": {
      const delta = typeof event.reasoning === "string" ? event.reasoning : "";
      if (!delta) return transcript;
      const rows = appendOrExtend(
        transcript.rows,
        isOpenAssistant,
        () => ({ ...openAssistant(), reasoning: delta }),
        (row) => ({ ...row, reasoning: row.reasoning + delta }),
      );
      return { ...transcript, rows };
    }

    case "message": {
      // The finished answer, replacing whatever the deltas built up.
      const text = typeof event.text === "string" ? event.text : "";
      const reasoning = typeof event.reasoning === "string" ? event.reasoning : "";
      const thoughtMs = typeof event.thoughtMs === "number" ? event.thoughtMs : undefined;
      const rows = appendOrExtend(
        transcript.rows,
        isOpenAssistant,
        () => ({
          kind: "assistant",
          id: nextId("message"),
          text,
          reasoning,
          ...(thoughtMs !== undefined ? { thoughtMs } : {}),
          streaming: false,
        }),
        (row) => ({
          ...row,
          ...(text ? { text } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(thoughtMs !== undefined ? { thoughtMs } : {}),
          streaming: false,
        }),
      );
      return { ...transcript, rows };
    }

    case "tool_dispatch": {
      const tool = event.tool;
      if (!tool) return transcript;
      return {
        ...transcript,
        rows: [...transcript.rows, toolRow(tool, nextId("tool"), true)],
      };
    }

    case "tool_result": {
      const tool = event.tool;
      if (!tool) return transcript;
      const id = tool.id ?? "";
      // A result closes the dispatch carrying the same id. With no id there is
      // nothing to pair against, so it becomes its own row rather than being
      // dropped silently.
      const index = id
        ? transcript.rows.findIndex(
            (row) => row.kind === "tool" && row.running && row.id === id,
          )
        : -1;
      if (index >= 0) {
        const rows = transcript.rows.slice();
        const existing = rows[index];
        if (existing !== undefined && existing.kind === "tool") {
          const done: ToolRow = {
            ...existing,
            running: false,
            outputDiff: tool.outputDiff === true,
            readOnly: tool.readOnly === true,
          };
          if (tool.output !== undefined) done.output = tool.output;
          if (tool.err !== undefined) done.err = tool.err;
          if (tool.refusalCode !== undefined) done.refusalCode = tool.refusalCode;
          rows[index] = done;
        }
        return { ...transcript, rows };
      }
      return {
        ...transcript,
        rows: [...transcript.rows, toolRow(tool, nextId("tool"), false)],
      };
    }

    case "ask_request": {
      const ask = event.ask;
      if (!ask) return transcript;
      // The kernel sends `questions`, never a single prompt. An ask with none
      // is a shape this client does not know; drawing it would be a prompt
      // with no buttons, so it is left to the contract rule and ignored.
      if (!Array.isArray(ask.questions) || ask.questions.length === 0) return transcript;
      return {
        ...transcript,
        rows: [...transcript.rows, { kind: "ask", id: ask.id, ask, pending: true }],
      };
    }

    case "ask_engaged": {
      // Someone else picked the question up. It is still unanswered, but it is
      // no longer this screen's to answer, and drawing it as waiting on the
      // person here would be a lie.
      const id = typeof event.ask?.id === "string" ? event.ask.id : "";
      if (!id) return transcript;
      return { ...transcript, rows: closePrompt(transcript.rows, id, "engaged") };
    }

    case "approval_request": {
      const approval = event.approval;
      if (!approval) return transcript;
      return {
        ...transcript,
        rows: [
          ...transcript.rows,
          { kind: "approval", id: approval.id, approval, pending: true },
        ],
      };
    }

    case "notice": {
      // A decision receipt rides a notice and is the only frame that says a
      // prompt was settled somewhere — including on another device, which is
      // the normal case for a phone: the desktop asks, the phone answers, or
      // the reverse. Without this a row stays pending forever.
      const receipt = event.decisionReceipt as
        | { id?: string; kind?: string; outcome?: string }
        | undefined;
      if (receipt && typeof receipt.id === "string" && receipt.id !== "") {
        const settled = closePrompt(transcript.rows, receipt.id, receipt.outcome ?? "settled");
        if (settled !== transcript.rows) {
          return { ...transcript, rows: settled };
        }
      }
      if (isOperatorNotice(event)) return transcript;
      const text = typeof event.text === "string" ? event.text : "";
      if (!text) return transcript;
      const row: NoticeRow = {
        kind: "notice",
        id: nextId("notice"),
        text,
        level: typeof event.level === "string" ? event.level : "info",
      };
      if (typeof event.detail === "string" && event.detail) row.detail = event.detail;
      return { ...transcript, rows: [...transcript.rows, row] };
    }

    case "turn_done": {
      const error = typeof event.err === "string" && event.err ? event.err : undefined;
      return {
        ...transcript,
        rows: closePending(closeStreaming(transcript.rows)),
        running: false,
        ended: {
          cancelled: event.cancelled === true,
          ...(error !== undefined ? { error } : {}),
          ...(typeof event.outcome === "string" ? { outcome: event.outcome } : {}),
        },
      };
    }

    // Transport frames, and kinds this client does not render yet. Ignoring an
    // unknown kind is the contract: a newer kernel must not break an older app.
    default:
      return transcript;
  }
}

/** Fold a batch, which is what a replayed backlog arrives as. */
export function reduceAll(transcript: Transcript, events: EventPayload[]): Transcript {
  return events.reduce(reduce, transcript);
}
