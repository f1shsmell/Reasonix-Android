/**
 * Letting a surface leave before it is unmounted.
 *
 * Every sheet in the app used to vanish on the frame its state flipped, so a
 * dismissal read as a cut while the same sheet arriving had a slide. A close
 * now reports a `closing` state first and calls the real `onClose` once the
 * exit has played, which is what lets the exit animation exist at all — a CSS
 * animation cannot run on an element that is already gone.
 *
 * The wait is skipped whenever motion is off for the person: a reduced-motion
 * request, and any environment with no `matchMedia` at all (a test renderer),
 * closes at once. That keeps the timing out of tests while the phone keeps it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Matches `--dur-2` in tokens.css, the exit animation's length.
 *
 * The two must agree: unmounting earlier cuts the last frames, later leaves a
 * dead surface over the screen that swallows the next tap.
 */
export const EXIT_MS = 200;

/** Whether this environment asks for motion at all. */
export function motionReduced(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // No media-query support: nothing is animating, so nothing to wait for.
    return true;
  }
}

export interface SheetExit {
  /** Draw the exit animation: spread onto the surface that is leaving. */
  closing: boolean;
  /**
   * Ask the surface to close. Safe to call twice: the second press during the
   * exit is ignored, the way a second tap on a closing dialog should be.
   */
  close: () => void;
}

export function useSheetExit(onClose: () => void): SheetExit {
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | null>(null);
  /** Read the latest callback without restarting the timer on a re-render. */
  const latest = useRef(onClose);
  latest.current = onClose;

  const close = useCallback(() => {
    if (timer.current !== null) return;
    if (motionReduced()) {
      latest.current();
      return;
    }
    setClosing(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      latest.current();
    }, EXIT_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  return { closing, close };
}
