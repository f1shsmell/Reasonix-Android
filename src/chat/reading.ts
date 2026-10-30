/**
 * Where each conversation was left.
 *
 * A phone switches away mid-answer all the time. Reopening a long conversation
 * at the newest row loses the place the person was reading; the draft store
 * already keeps the words, so this keeps the window. The session path is the
 * identity: a runtime id is per pane and changes when the same transcript is
 * opened again, which is exactly when this matters.
 */

export interface ReadingPosition {
  /** Scroll offset from the top of the transcript. */
  top: number;
  /** The person was following the newest row. */
  atBottom: boolean;
}

const PREFIX = "reasonix.reading.";

/** The session path when there is one, otherwise the pane id. */
export function readingKey(sessionPath: string | undefined, runtimeId: string): string {
  const path = sessionPath?.trim();
  if (path) return path;
  return runtimeId.trim();
}

export function loadReading(key: string): ReadingPosition | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const row = parsed as Record<string, unknown>;
    if (typeof row.top !== "number" || !Number.isFinite(row.top) || row.top < 0) return null;
    if (typeof row.atBottom !== "boolean") return null;
    return { top: row.top, atBottom: row.atBottom };
  } catch {
    return null;
  }
}

export function saveReading(key: string, position: ReadingPosition): void {
  if (!key) return;
  try {
    localStorage.setItem(
      PREFIX + key,
      JSON.stringify({
        top: Math.max(0, Math.round(position.top)),
        atBottom: position.atBottom,
      }),
    );
  } catch {
    // A blocked storage API costs one scroll position, not the screen.
  }
}

export function clearReading(key: string): void {
  if (!key) return;
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Already unreachable.
  }
}
