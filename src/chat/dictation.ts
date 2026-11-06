import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { beginSpeechHold } from "../native/speech";
import type { SpeechHold, SpeechSession } from "../native/speech";

/**
 * One press-and-hold dictation, from press to delivered text.
 *
 * The phone's recognizer is a singleton and the screens that use it come and
 * go, so the hold is abandoned on unmount. The consumer only says where the
 * text goes; the cancel gesture and the "still starting" race stay here.
 */
export function useDictation({
  onText,
  onError,
}: {
  onText: (text: string) => void;
  onError: (message: string) => void;
}): {
  session: SpeechSession | null;
  down: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  move: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  up: () => void;
  cancel: () => void;
} {
  const [session, setSession] = useState<SpeechSession | null>(null);
  const hold = useRef<SpeechHold | null>(null);
  const startY = useRef(0);
  /** A press whose hold is still being created; the release may land first. */
  const pending = useRef(false);
  const releaseQueued = useRef(false);
  const cancelled = useRef(false);

  const change = useCallback(
    (next: SpeechSession) => {
      if (cancelled.current) {
        setSession(null);
        return;
      }
      setSession({ ...next });
      if (!next.ended) return;
      hold.current = null;
      const text = next.transcript.trim();
      if (text) onText(text);
      else if (next.error) onError(next.error);
    },
    [onError, onText],
  );

  const down = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (hold.current || pending.current) return;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A WebView without pointer capture drops the move/up once the finger
        // leaves the button; the window listener below ends the hold anyway.
        const end = () => upRef.current();
        window.addEventListener("pointerup", end, { once: true });
        window.addEventListener("pointercancel", end, { once: true });
      }
      startY.current = event.clientY;
      pending.current = true;
      releaseQueued.current = false;
      cancelled.current = false;
      onError("");
      void beginSpeechHold(change)
        .then((result) => {
          pending.current = false;
          if (cancelled.current) {
            result.hold?.abandon();
            return;
          }
          if (!result.hold) {
            onError(
              result.reason === "denied"
                ? "麦克风权限被拒绝，到系统设置里打开后重试"
                : "这个手机没有可用的语音服务",
            );
            return;
          }
          // A buffered final or error can end the hold during creation; the
          // change listener already closed it out, and assigning it here
          // would wedge the button until remount.
          if (result.hold.state.ended) return;
          hold.current = result.hold;
          setSession({ ...result.hold.state });
          if (releaseQueued.current) {
            releaseQueued.current = false;
            result.hold.release();
          }
        })
        .catch(() => {
          // The bridge itself refused; without this the pending flag pins
          // the button forever with no feedback.
          pending.current = false;
          onError("语音输入启动失败，再试一次");
        });
    },
    [change, onError],
  );

  const move = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    hold.current?.move(event.clientY - startY.current);
  }, []);

  const up = useCallback(() => {
    if (pending.current) {
      // The hold does not exist yet; remember the release for when it does.
      releaseQueued.current = true;
      return;
    }
    hold.current?.release();
  }, []);
  const upRef = useRef(up);
  upRef.current = up;

  const cancel = useCallback(() => {
    cancelled.current = true;
    releaseQueued.current = false;
    pending.current = false;
    hold.current?.abandon();
    hold.current = null;
    setSession(null);
  }, []);

  useEffect(
    () => () => {
      hold.current?.abandon();
    },
    [],
  );

  return { session, down, move, up, cancel };
}
