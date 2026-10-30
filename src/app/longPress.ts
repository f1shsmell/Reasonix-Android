/**
 * A long press, as the phone's stand-in for a right click.
 *
 * The row still opens on a tap: this only reports a press the finger held
 * still long enough to mean something else. A press that moves is a scroll,
 * so it disarms; a mouse never needs it, because it can right-click.
 *
 * The click that follows the release must not also open the row, so the
 * handlers carry a one-shot swallow: the release arms it, the row's capture
 * handler consumes it. A new press clears it again, which keeps a release
 * that produced no click from eating the next tap.
 */

import { useEffect, useRef } from "react";
import type * as React from "react";

/** How long a finger rests before the row offers its actions. */
export const LONG_PRESS_MS = 450;

/** How far a finger may drift before the press becomes a scroll. */
const SLOP_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

export function useLongPress(open: () => void): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const armed = useRef(false);
  const swallow = useRef(false);

  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  };

  useEffect(() => clear, []);

  return {
    onPointerDown: (event) => {
      swallow.current = false;
      if (event.pointerType === "mouse") return;
      clear();
      origin.current = { x: event.clientX, y: event.clientY };
      armed.current = false;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        armed.current = true;
        if (typeof navigator.vibrate === "function") navigator.vibrate(10);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      const start = origin.current;
      if (!start || armed.current) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= SLOP_PX) return;
      clear();
    },
    onPointerUp: () => {
      const fired = armed.current;
      armed.current = false;
      clear();
      if (!fired) return;
      swallow.current = true;
      open();
    },
    onPointerLeave: () => {
      if (!armed.current) clear();
    },
    onPointerCancel: () => {
      armed.current = false;
      clear();
    },
    onContextMenu: (event) => {
      event.preventDefault();
      swallow.current = false;
      open();
    },
    onClickCapture: (event) => {
      if (!swallow.current) return;
      swallow.current = false;
      event.stopPropagation();
      event.preventDefault();
    },
  };
}
