import type { PointerEvent as ReactPointerEvent } from "react";
import type { SpeechSession } from "../native/speech";

export function VoiceLive({
  session,
  onCancel,
}: {
  session: SpeechSession | null;
  onCancel?: () => void;
}) {
  if (!session || session.ended) return null;
  const body = (
    <>
      <span className="voice-wave" aria-hidden="true">
        {session.levels.map((level, index) => (
          <i key={index} style={{ height: `${Math.round(3 + level * 15)}px` }} />
        ))}
      </span>
      <span className="voice-live-text">
        {session.cancelArmed
          ? "松手取消"
          : session.ready
            ? session.transcript || "听着呢…"
            : "启动语音服务…"}
      </span>
    </>
  );
  const className = `voice-live${session.cancelArmed ? " cancel" : ""}`;
  if (!onCancel) {
    return (
      <div className={className} aria-live="polite">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={className}
      aria-live="polite"
      aria-label="点击取消语音输入"
      title="点击取消"
      onClick={onCancel}
    >
      {body}
    </button>
  );
}

export function MicButton({
  session,
  disabled = false,
  down,
  move,
  up,
}: {
  session: SpeechSession | null;
  disabled?: boolean;
  down: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  move: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  up: () => void;
}) {
  const live = session !== null && !session.ended;
  return (
    <button
      type="button"
      className={`iconbtn mic${live ? " live" : ""}${live && session.cancelArmed ? " cancel" : ""}`}
      aria-label={live ? "松开发送，上滑取消" : "按住说话"}
      title="按住说话，上滑取消"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(event) => event.preventDefault()}
      disabled={disabled}
    >
      {live ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z" />
          <path d="M19 11a7 7 0 0 1-14 0M12 18v3" />
        </svg>
      )}
    </button>
  );
}
