/**
 * The stored conversation, folded into the same rows the live stream produces.
 *
 * The stream only carries what happens while a client is attached: the kernel
 * answers a first connection with initial notices, not with a replay of the
 * session so far. Without this read, opening a session that has been running
 * for days shows an empty transcript — which is what it did.
 *
 * Folding history is not the same job as folding events. History is already
 * settled: there are no deltas to join, no turn to close, and a tool result
 * arrives as its own message carrying the id of the call it belongs to. So the
 * two folds share the row types and nothing else.
 */

import type { HistoryMessage, HistoryToolCall } from "../wire/history";
import { fetchWithTimeout } from "./http";
import type { Row, ToolRow } from "../chat/transcript";

/** Control sequences are not text; a transcript that shows them is broken. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(text: string): string {
  return text.replace(CONTROL, "");
}

/**
 * Ids for rebuilt rows.
 *
 * Prefixed rather than numbered so a history row can never collide with a row
 * the live fold numbered: both lists are drawn by the same renderer and keyed
 * by id, and a collision silently drops a row.
 */
function historyId(msgIndex: number, part: number, suffix = ""): string {
  return `h:${msgIndex}:${part}${suffix}`;
}

function toolRow(call: HistoryToolCall, id: string): ToolRow {
  const row: ToolRow = {
    kind: "tool",
    id,
    name: call.resolvedName ?? call.name,
    outputDiff: false,
    readOnly: false,
    running: false,
  };
  if (call.arguments) row.args = call.arguments;
  return row;
}

/**
 * Fold one stored conversation.
 *
 * Two rules are taken from the desktop, because both were bugs there:
 *
 * - A `hostAuthored` user message is the host's words, not the person's.
 *   Drawing it puts words in their mouth, so it is dropped.
 * - A tool result is joined to its call by id, not by position. A call whose
 *   result is missing keeps its card; a result whose call is missing gets one
 *   of its own rather than being lost.
 */
export function foldHistory(messages: HistoryMessage[]): Row[] {
  const rows: Row[] = [];
  // Where each call's card landed, so its result can fill it in.
  const calls = new Map<string, number>();

  for (const message of messages) {
    const index = message.msgIndex;

    if (message.role === "system") continue;

    if (message.role === "user") {
      if (message.hostAuthored) continue;
      const text = clean(message.content);
      if (!text) continue;
      rows.push({ kind: "user", id: historyId(index, 0), text });
      continue;
    }

    if (message.role === "assistant") {
      const text = clean(message.content);
      const reasoning = clean(message.reasoning ?? "");
      const toolCalls = message.toolCalls ?? [];
      // A tool step's reasoning is useful while it runs, but in a stored
      // conversation the tool card is the record. Drawing a bubble per step
      // gives the phone a wall of empty "思考了" cards; only a thought that
      // never went on to call a tool stands on its own.
      if ((text || reasoning) && (text !== "" || toolCalls.length === 0)) {
        rows.push({
          kind: "assistant",
          id: historyId(index, 0),
          text,
          reasoning,
          ...(message.thoughtMs !== undefined ? { thoughtMs: message.thoughtMs } : {}),
          // Nothing is streaming in a stored turn; a bubble that says it is
          // would show a caret blinking at the end of an old answer.
          streaming: false,
        });
      }
      for (const [ordinal, call] of toolCalls.entries()) {
        const id = historyId(index, ordinal + 1);
        if (call.id) calls.set(call.id, rows.length);
        rows.push(toolRow(call, id));
      }
      continue;
    }

    if (message.role === "tool") {
      const at = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
      const existing = at === undefined ? undefined : rows[at];
      if (existing !== undefined && existing.kind === "tool") {
        const filled: ToolRow = {
          ...existing,
          output: clean(message.content),
          outputDiff: message.outputDiff === true,
        };
        if (message.toolFailed) filled.err = clean(message.content);
        if (message.toolRefusalCode) filled.refusalCode = message.toolRefusalCode;
        rows[at as number] = filled;
        continue;
      }
      // No call to join to: keep the output rather than drop the host's own
      // account of what ran.
      const orphan: ToolRow = {
        kind: "tool",
        id: historyId(index, 0),
        name: message.toolName ?? "tool",
        output: clean(message.content),
        outputDiff: message.outputDiff === true,
        readOnly: false,
        running: false,
      };
      if (message.toolFailed) orphan.err = clean(message.content);
      if (message.toolRefusalCode) orphan.refusalCode = message.toolRefusalCode;
      rows.push(orphan);
    }
  }

  return rows;
}

/**
 * Read the stored conversation for one runtime.
 *
 * `base` is the runtime's request prefix. A kernel that cannot answer is not a
 * reason to fail the screen: the live stream still works, and an empty
 * transcript with a working composer is better than no screen at all. The
 * caller is told which happened.
 */
export async function loadHistory(
  base: string,
): Promise<{ ok: true; rows: Row[] } | { ok: false; code: string }> {
  try {
    const response = await fetchWithTimeout(`${base}/history`, { credentials: "same-origin" }, 15_000);
    if (!response.ok) return { ok: false, code: `http.${response.status}` };
    const messages = (await response.json()) as HistoryMessage[];
    if (!Array.isArray(messages)) return { ok: false, code: "history.shape" };
    return { ok: true, rows: foldHistory(messages) };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}