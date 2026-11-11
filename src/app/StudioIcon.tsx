/**
 * The outline icon set the phone header draws.
 *
 * The toolbar used text glyphs (`⚙`, `＋`, `⟳`), which rendered at different
 * weights and, for settings, did not read as settings at all. These paths are
 * the app's own geometry: a gear, a compose mark, a paper plane and a refresh
 * arc, all on the same 24-unit grid and stroke.
 */

import type { SVGProps } from "react";

const PATHS = {
  settings: [
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ],
  send: ["m22 2-7 20-4-9-9-4 20-7z", "M22 2 11 13"],
  compose: [
    "M12 20h9",
    "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
    "M15 5l4 4",
  ],
  refresh: ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"],
  list: ["M4 6h16", "M4 12h16", "M4 18h10"],
  grid: ["M4 5h6v6H4z", "M14 5h6v6h-6z", "M4 15h6v4H4z", "M14 15h6v4h-6z"],
  branch:
    "M6 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 0v12m12-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 0a6 6 0 0 1-6 6H6m0 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  panel: [
    "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    "M9 3v18",
  ],
  down: "m6 9 6 6 6-6",
  copy: "M8 8h13v13H8V8zM16 8V3H3v13h5",
  quote: "M7 7H3v6h6V9m0-2v8a2 2 0 0 1-2 2H5m16-10h-4v6h6V9m0-2v8a2 2 0 0 1-2 2h-2",
  fork: "M3 12h5c2 0 3-1 4-2l8-7m-6 0h6v6M8 12c2 0 3 1 4 2l8 7m-6 0h6v-6",
  edit: "m4 16 12-12 4 4L8 20H4v-4zM13 7l4 4",
  rewind: "M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4",
  check: "m5 12 4 4L19 6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  file: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M14 3v6h6"],
} as const;

export type StudioIconName = keyof typeof PATHS;

export function StudioIcon({
  name,
  className,
  ...props
}: SVGProps<SVGSVGElement> & { name: StudioIconName }) {
  const entry = PATHS[name];
  const paths = typeof entry === "string" ? [entry] : entry;
  return (
    <svg
      className={["studio-icon", className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
