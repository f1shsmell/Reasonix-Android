import { useEffect, useRef } from "react";
import { hapticTick } from "../app/haptics";
import type { Row } from "./transcript";

/**
 * A tick of haptic feedback while an answer streams.
 *
 * A stream the person cannot see yet (another pane, a locked screen) must
 * stay silent; only the pane that is on screen mounts this. Vibration runs
 * through Capacitor's Haptics plugin, which resolves to a no-op in the
 * browser, so the tests never need to stub a device.
 */

export interface StreamMark {
  readonly id: string;
  readonly textLength: number;
}

/** A fast stream reads as texture, not a buzz. */
export const STREAM_HAPTIC_THROTTLE_MS = 320;

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

/**
 * Whether this transition deserves a tick.
 *
 * A new stream always ticks — the answer started. Growth of the same stream
 * ticks at most once per throttle window. A stream that stopped, finished,
 * or merely shed rows (a rebuild, a cache merge) never ticks.
 */
export function shouldTickStreamHaptic(input: {
  previous: StreamMark | null;
  latest: StreamMark | null;
  lastTickAt: number;
  now: number;
}): boolean {
  const { previous, latest } = input;
  if (latest === null) return false;
  if (previous?.id !== latest.id) return true;
  if (latest.textLength <= previous.textLength) return false;
  return input.now - input.lastTickAt >= STREAM_HAPTIC_THROTTLE_MS;
}

/** Mount while the conversation is on screen to tick as its answer streams. */
export function useStreamHaptics(rows: readonly Row[]): void {
  // The first rows this hook sees only seed the mark: opening a pane
  // mid-stream must not buzz about an answer that started without us.
  const seeded = useRef(false);
  const previous = useRef<StreamMark | null>(null);
  const lastTickAt = useRef(0);

  useEffect(() => {
    const latest = latestStreamingAssistant(rows);
    const now = Date.now();
    const tick = seeded.current && shouldTickStreamHaptic({
      previous: previous.current,
      latest,
      lastTickAt: lastTickAt.current,
      now,
    });
    seeded.current = true;
    previous.current = latest;
    if (!tick) return;
    lastTickAt.current = now;
    void hapticTick();
  }, [rows]);
}
