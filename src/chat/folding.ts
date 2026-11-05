/**
 * How much of a conversation is drawn by default.
 *
 * The desktop calls this 会话折叠 and offers the same three answers. On a phone
 * the fold is coarser than a per-part setting: a step is either shown, or
 * folded into the run it belongs to. The choice belongs to this phone, not to
 * the conversation — the same transcript is a record on the desktop and a
 * glance here.
 */

import { readChoice, writeChoice, SETTINGS_KEYS } from "../app/settings";

export type FoldMode = "compact" | "standard" | "full";

export const FOLD_CHOICES: ReadonlyArray<{ value: FoldMode; label: string }> = [
  { value: "compact", label: "精简" },
  { value: "standard", label: "标准" },
  { value: "full", label: "详尽" },
];

export const FOLD_NOTE =
  "精简只留结论和一行操作摘要；详尽把每一步都摊开。只影响这台手机。";

const DEFAULT: FoldMode = "standard";


export function loadFoldMode(): FoldMode {
  return readChoice(SETTINGS_KEYS.folding, ["compact", "standard", "full"], DEFAULT);
}

export function saveFoldMode(mode: FoldMode): void {
  writeChoice(SETTINGS_KEYS.folding, mode, DEFAULT);
}
