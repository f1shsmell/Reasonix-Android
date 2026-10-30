/**
 * The top of the connect screen: which computer, and what the link is doing.
 *
 * A settings card can say "未连接" in a line of grey, but connecting is the one
 * moment this app is doing something the person should be able to watch. The
 * mark traces while the link works, the step list names the stage, and the
 * resting states borrow the same three tones the home chip uses.
 *
 * The animation is the desktop Studio's: three strokes, one dash cycle, each
 * path offset by a third. It is decoration for a state, never the state
 * itself — the words below it carry the meaning and the screen reader reads
 * them.
 */

import { LINK_STEPS, linkSummary, linkTone, stepLabel } from "../net/link";
import type { LinkState } from "../net/link";
import { RMark } from "./RMark";

export interface ConnectionHeroProps {
  name: string;
  detail: string;
  /** The app's link machine; absent on the boot screen before it starts. */
  link?: LinkState | undefined;
  /** A manual attempt the link machine has not been told about yet. */
  busy?: string;
}

export function ConnectionHero({ name, detail, link, busy = "" }: ConnectionHeroProps) {
  const working = busy !== "" || link?.phase === "connecting" || link?.phase === "reconnecting";
  const tone = busy !== "" ? "busy" : link ? linkTone(link) : "idle";
  const line = busy !== "" ? `${busy}…` : link ? heroLine(link, detail) : detail;
  const staged =
    busy === "" && link !== undefined && (link.phase === "connecting" || link.phase === "reconnecting");

  return (
    <section
      className="link-hero"
      data-tone={tone}
      data-live={working ? "true" : undefined}
      aria-label="连接状态"
    >
      <span className="link-hero-mark" aria-hidden="true">
        <RMark />
      </span>
      <p className="link-hero-title">{name}</p>
      <p className="link-hero-sub" role="status">
        {line}
      </p>
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
  if (link.phase === "idle") return detail;
  return linkSummary(link);
}
