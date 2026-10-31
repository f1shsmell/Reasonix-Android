/**
 * The desktop's outline icon set, drawn from the same geometry.
 *
 * The phone header used text glyphs (`⚙`, `＋`, `⟳`), which rendered at
 * different weights and, for settings, did not read as settings at all. These
 * paths are copied from Studio's `StudioIcon` so the two clients share one
 * visual language; only the names the phone uses are carried here.
 */

import type { SVGProps } from "react";

const PATHS = {
  settings: "M4 7h16M4 17h16M9 4v6M16 14v6",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 7a9 9 0 1 0 1 8M20 3v5h-5",
  arrow: "M12 20V4m-6 6 6-6 6 6",
  down: "m6 9 6 6 6-6",
} as const;

export type StudioIconName = keyof typeof PATHS;

export function StudioIcon({
  name,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { name: StudioIconName }) {
  return (
    <svg
      className={["studio-icon", className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
