/**
 * The top of the connect screen: which computer, and what the link is doing.
 *
 * A settings card can say "未连接" in a line of grey, but connecting is the one
 * moment this app is doing something the person should be able to watch. The
 * monitor and its halo breathe while the link works, the step list names the
 * stage, and the resting states borrow the tone the home chip uses.
 *
 * The animation is decoration for a state, never the state itself: the words
 * below carry the meaning and the screen reader reads them.
 */

import { isStalePairing, LINK_STEPS, linkSummary, linkTone, stepLabel } from "../net/link";
import type { LinkState } from "../net/link";

export interface ConnectionHeroProps {
  name: string;
  detail: string;
  /** The app's link machine; absent on the boot screen before it starts. */
  link?: LinkState | undefined;
  /** A manual attempt the link machine has not been told about yet. */
  busy?: string;
  /** Offered only for a stale pairing: a fresh scan writes a new credential. */
  onRepair?: () => void;
}

export function ConnectionHero({ name, detail, link, busy = "", onRepair }: ConnectionHeroProps) {
  const working = busy !== "" || link?.phase === "connecting" || link?.phase === "reconnecting";
  const tone = busy !== "" ? "busy" : link ? linkTone(link) : "idle";
  const line = busy !== "" ? `${busy}…` : link ? heroLine(link, detail) : detail;
  const staged =
    busy === "" && link !== undefined && (link.phase === "connecting" || link.phase === "reconnecting");
  // The resting state is one line of fact; only a working link earns the
  // tall animated card. Waiting for a network is resting, not working: there
  // is nothing to animate while the phone has no way out.
  const compact = !working && !staged;

  // A stale credential is not a network failure: no retry of the same address
  // can repair it. Only a fresh scan writes a new one, so offer that one path
  // right where the failure is shown, instead of a sentence telling the
  // person to "reconnect" in settings.
  const repair = Boolean(
    !working && onRepair && link?.phase === "failed" && isStalePairing(link.error?.code),
  );

  return (
    <section
      className="link-hero"
      data-tone={tone}
      data-live={working ? "true" : undefined}
      data-compact={compact && !repair ? "true" : undefined}
      aria-label="连接状态"
    >
      <span className="link-hero-mark" aria-hidden="true">
        <svg
          className="hero-monitor"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </svg>
      </span>
      <p className="link-hero-title">{name}</p>
      <p className="link-hero-sub" role="status">
        {line}
      </p>
      {repair ? (
        <button type="button" className="link-hero-repair" onClick={onRepair}>
          重新扫码配对
        </button>
      ) : null}
      {staged && link ? (
        <ol className="link-steps" aria-label="连接步骤">
          {LINK_STEPS.map((step) => {
            const done = link.completed.includes(step);
            const active = link.step === step;
            return (
              <li key={step} data-state={done ? "done" : active ? "active" : "pending"}>
                {stepLabel(step)}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function heroLine(link: LinkState, detail: string): string {
  if (link.phase === "failed") return link.error?.message ?? "连接失败";
  if (link.phase === "offline") return "手机当前没有网络，恢复后会自动重连";
  if (link.phase === "idle") return detail;
  return linkSummary(link);
}
