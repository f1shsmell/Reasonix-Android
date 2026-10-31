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
import { RequestTimeout, fetchWithTimeout } from "./http";
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
      // A tool step's reasoning belongs to the call it preceded, not to a
      // bubble of its own: drawing one per step gives the phone a wall of empty
      // "思考了" cards. It is attached to the first tool card below instead, so
      // the record still says why the tool ran.
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
        const row = toolRow(call, id);
        // The step's thinking explains the first call of the step. Later calls
        // in the same message share it; repeating it on each would be noise.
        if (ordinal === 0 && reasoning && text === "") row.reasoning = reasoning;
        rows.push(row);
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
/**
 * Reading the stored conversation.
 *
 * The primary path is `GET /history/page` — the kernel serves the newest
 * window (limit 1-500) with `hasMoreBefore`, `nextCursor`, `snapshot` and
 * `total`, reads it off disk per page and never rebuilds the whole message
 * list. Measured against a 7.4 MB session on a v2.56 kernel: 270ms cold /
 * 7ms warm with a 135 KB body, against 2.7 MB for the whole read. On the
 * mesh-VPN link where the whole read times out, the body size — not the
 * server — was always the bottleneck, so the page is what makes long
 * conversations open at all.
 *
 * Two fallbacks keep older kernels and moving sessions working:
 * - 409 `history.snapshot_changed` on a cursor read means the conversation
 *   moved between requests; the newest page is fetched again, which is the
 *   answer the reader wants anyway.
 * - 404 means a kernel without the page route; the whole `/history` read
 *   stays as the fallback with its own long deadline (the body is the whole
 *   transcript, and the proxy gives up at 60s — going past that would only
 *   change which side abandons first).
 */
export const HISTORY_PAGE_SIZE = 200;
export const HISTORY_PAGE_TIMEOUT_MS = 30_000;
export const HISTORY_TIMEOUT_MS = 55_000;

/** What one read of the stored conversation produced. */
export interface HistoryRead {
  rows: Row[];
  /** The kernel's count of messages in the whole conversation. */
  total: number;
  /** True when older messages exist behind `nextCursor`. */
  hasMoreBefore: boolean;
  /** Pass back to `loadHistory` to read the page before this one. */
  nextCursor?: string;
  /** False when a kernel without `/history/page` served the whole transcript. */
  paged: boolean;
}

type HistoryResult = { ok: true; read: HistoryRead } | { ok: false; code: string };

async function readPage(base: string, cursor?: string): Promise<HistoryResult> {
  const query = cursor
    ? `limit=${HISTORY_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
    : `limit=${HISTORY_PAGE_SIZE}`;
  const response = await fetchWithTimeout(
    `${base}/history/page?${query}`,
    { credentials: "same-origin" },
    HISTORY_PAGE_TIMEOUT_MS,
  );
  if (response.status === 409) return { ok: false, code: "history.snapshot_changed" };
  if (!response.ok) return { ok: false, code: `http.${response.status}` };
  const page = (await response.json()) as {
    messages?: HistoryMessage[];
    total?: number;
    hasMoreBefore?: boolean;
    nextCursor?: string;
  };
  if (!page || !Array.isArray(page.messages)) return { ok: false, code: "history.shape" };
  return {
    ok: true,
    read: {
      rows: foldHistory(page.messages),
      total: typeof page.total === "number" ? page.total : page.messages.length,
      hasMoreBefore: page.hasMoreBefore === true,
      ...(typeof page.nextCursor === "string" && page.nextCursor
        ? { nextCursor: page.nextCursor }
        : {}),
      paged: true,
    },
  };
}

/** The whole-transcript read, for kernels that predate `/history/page`. */
async function readWhole(base: string): Promise<HistoryResult> {
  const response = await fetchWithTimeout(
    `${base}/history`,
    { credentials: "same-origin" },
    HISTORY_TIMEOUT_MS,
  );
  if (!response.ok) return { ok: false, code: `http.${response.status}` };
  const messages = (await response.json()) as HistoryMessage[];
  if (!Array.isArray(messages)) return { ok: false, code: "history.shape" };
  return {
    ok: true,
    read: {
      rows: foldHistory(messages),
      total: messages.length,
      hasMoreBefore: false,
      paged: false,
    },
  };
}

export async function loadHistory(base: string, cursor?: string): Promise<HistoryResult> {
  try {
    const first = await readPage(base, cursor);
    if (first.ok || first.code !== "history.snapshot_changed") {
      if (first.ok || first.code !== "http.404") return first;
      return await readWhole(base);
    }
    // The conversation moved while this cursor was in flight. The newest
    // page is what the reader needs; a second 409 cannot happen — only a
    // cursor read checks the snapshot against it.
    return await readPage(base);
  } catch (error) {
    // A deadline and a dead socket both used to read as `client.offline`,
    // which hid the one that this screen can actually do something about.
    if (error instanceof RequestTimeout) return { ok: false, code: "client.timeout" };
    return { ok: false, code: "client.offline" };
  }
}