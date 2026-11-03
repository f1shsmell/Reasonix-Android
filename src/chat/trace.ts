/**
 * TEMPORARY: transcript event trace for the ghost-message investigation.
 *
 * Records only structure — timestamp, kind, seq, lengths, hashes and the row
 * count after folding. Never the text itself: the diagnostics copy ships this
 * and `diagnostics.ts` promises it carries no chat content.
 *
 * Delete this file, the call in ChatScreen.tsx and the append in
 * diagnostics.ts once the cause is known.
 */

const MAX = 240;

/** Frames worth tracing: the ones that decide row ownership. */
const TRACED = new Set([
  "text",
  "message",
  "reasoning",
  "tool_dispatch",
  "tool_result",
  "turn_started",
  "turn_done",
  "stream_gap",
]);

interface Frame {
  kind: string;
  text?: unknown;
  reasoning?: unknown;
  seq?: unknown;
}

let ring: string[] = [];
let key: string | null = null;

/**
 * FNV-1a over the text, 8 hex digits. Recomputed only where a duplicate could
 * hide: a `message` frame, or a `text` whose length jumped — not on every
 * streaming delta, which would make this O(n^2) over one answer.
 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Rows this conversation has traced so far, to spot a rewritten history. */
let lastLen: { text: number; reasoning: number } = { text: 0, reasoning: 0 };

/**
 * One frame, before and after it folds.
 *
 * `rows` is the row count after `reduce`, and `open` the id of the row it
 * extended — a frame that should have extended and instead opened a new row
 * shows up as `rows+1` beside a `-` open.
 */
export function traceEvent(
  conversation: string | undefined,
  frame: Frame,
  rows: number,
  open: string | null,
): void {
  const conversationKey = conversation ?? "";
  if (conversationKey !== key) {
    key = conversationKey;
    ring = [];
    lastLen = { text: 0, reasoning: 0 };
  }
  if (!TRACED.has(frame.kind)) return;

  const text = typeof frame.text === "string" ? frame.text : "";
  const reasoning = typeof frame.reasoning === "string" ? frame.reasoning : "";
  const jumped = Math.abs(text.length - lastLen.text) > 24;
  const worthHash = frame.kind === "message" || jumped;
  lastLen = { text: text.length, reasoning: reasoning.length };

  ring.push(
    `${new Date().toISOString().slice(11, 23)} ${frame.kind.padEnd(13)}` +
      ` seq=${frame.seq ?? "-"}` +
      ` len=${text.length}/${reasoning.length}` +
      ` h=${worthHash ? `${hash(text)}/${hash(reasoning)}` : "-"}` +
      ` rows=${rows} open=${open ?? "-"}`,
  );
  if (ring.length > MAX) ring.shift();
}

/** The last frames, oldest first, for the diagnostics copy. */
export function traceText(): string {
  if (ring.length === 0) return "";
  const body = ring.map((line) => `  ${line}`).join("\n");
  return `Transcript trace (last ${ring.length} frames):\n${body}`;
}

/** Tests only. */
export function resetTrace(): void {
  ring = [];
  key = null;
  lastLen = { text: 0, reasoning: 0 };
}
