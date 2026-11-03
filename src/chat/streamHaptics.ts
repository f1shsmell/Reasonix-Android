import { useEffect, useRef } from "react";
import { hapticTick } from "../app/haptics";
import type { Row } from "./transcript";

/**
 * A tick when an answer starts, and one when it ends.
 *
 * Not while it is being written. A delta arrives tens of times a second, so
 * ticking on growth made a long reply buzz continuously — the phone felt like
 * it was doing something it was not, and the feedback carried no information:
 * one more word is not one more event. The two edges do carry information, so
 * those are the two beats.
 *
 * A stream the person cannot see yet (another pane, a locked screen) must stay
 * silent; only the pane that is on screen mounts this. Vibration runs through
 * Capacitor's Haptics plugin, which resolves to a no-op in the browser, so the
 * tests never need to stub a device.
 */

export interface StreamMark {
  readonly id: string;
  readonly textLength: number;
}

/** The answer currently growing, or null when this pane has none. */
export function latestStreamingAssistant(rows: readonly Row[]): StreamMark | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "assistant" && row.streaming) {
      return { id: row.id, textLength: row.text.length };
    }
  }
  return null;
}

/** Which edge, if either, this transition crossed. */
export type StreamEdge = "start" | "end" | null;

/**
 * Whether this transition is one of the two beats.
 *
 * `start` is a stream that was not there before — including a new one
 * replacing the previous, since that is a second answer beginning. `end` is a
 * stream that stopped: it finished, failed, or was replaced by a settled row.
 * Growth of a stream that was already running is deliberately not an edge.
 */
export function streamEdge(input: {
  previous: StreamMark | null;
  latest: StreamMark | null;
}): StreamEdge {
  const { previous, latest } = input;
  if (latest !== null && (previous === null || previous.id !== latest.id)) return "start";
  if (latest === null && previous !== null) return "end";
  return null;
}

/** Mount while the conversation is on screen to tick at each answer's edges. */
export function useStreamHaptics(rows: readonly Row[]): void {
  // The first rows this hook sees only seed the mark: opening a pane
  // mid-stream must not buzz about an answer that started without us.
  const seeded = useRef(false);
  const previous = useRef<StreamMark | null>(null);

  useEffect(() => {
    const latest = latestStreamingAssistant(rows);
    const edge = seeded.current ? streamEdge({ previous: previous.current, latest }) : null;
    seeded.current = true;
    previous.current = latest;
    if (edge === null) return;
    void hapticTick("stream");
  }, [rows]);
}
