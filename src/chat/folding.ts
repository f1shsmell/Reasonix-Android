/**
 * How much of a conversation is drawn by default.
 *
 * The desktop calls this 会话折叠 and offers the same three answers. On a phone
 * the fold is coarser than a per-part setting: a step is either shown, or
 * folded into the run it belongs to. The choice belongs to this phone, not to
 * the conversation — the same transcript is a record on the desktop and a
 * glance here.
 */

export type FoldMode = "compact" | "standard" | "full";

export const FOLD_CHOICES: ReadonlyArray<{ value: FoldMode; label: string }> = [
  { value: "compact", label: "精简" },
  { value: "standard", label: "标准" },
  { value: "full", label: "详尽" },
];

export const FOLD_NOTE =
  "精简只留结论和一行操作摘要；详尽把每一步都摊开。只影响这台手机。";

const KEY = "reasonix.folding.v1";
const DEFAULT: FoldMode = "standard";

function isFoldMode(value: unknown): value is FoldMode {
  return value === "compact" || value === "standard" || value === "full";
}

export function loadFoldMode(): FoldMode {
  try {
    const stored = localStorage.getItem(KEY);
    return isFoldMode(stored) ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export function saveFoldMode(mode: FoldMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // A blocked storage API means the next session starts at the default;
    // the current one still reads the chosen mode from component state.
  }
}
