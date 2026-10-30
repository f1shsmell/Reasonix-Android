/**
 * Which sheet a back gesture closes first.
 *
 * Android's back button reaches one listener in `App`, not the component that
 * drew a sheet. Sheets register their close here while they are open, so back
 * dismisses the top one before navigation moves a level or the app exits.
 */

import { useEffect, useRef } from "react";

const closers: Array<() => void> = [];

/** Close the sheet opened last. False when nothing is open. */
export function closeTopSheet(): boolean {
  const close = closers[closers.length - 1];
  if (close === undefined) return false;
  close();
  return true;
}

/** Register while `open`; the closer always reads the latest callback. */
export function useBackCloser(open: boolean, close: () => void): void {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const entry = () => latest.current();
    closers.push(entry);
    return () => {
      const at = closers.lastIndexOf(entry);
      if (at >= 0) closers.splice(at, 1);
    };
  }, [open]);
}
