import {
  readChoice,
  writeChoice,
  SETTINGS_KEYS,
  SETTINGS_DEFAULTS,
  type DispatchAfter,
} from "./settings";

export type { DispatchAfter };

export const DISPATCH_AFTER_CHOICES: { value: DispatchAfter; label: string }[] = [
  { value: "stay", label: "不跳转" },
  { value: "recent", label: "最近" },
  { value: "session", label: "派发的会话" },
];

export function loadDispatchAfter(): DispatchAfter {
  return readChoice(
    SETTINGS_KEYS.dispatchAfter,
    ["stay", "recent", "session"],
    SETTINGS_DEFAULTS.dispatchAfter,
  );
}

export function saveDispatchAfter(value: DispatchAfter): void {
  writeChoice(SETTINGS_KEYS.dispatchAfter, value, SETTINGS_DEFAULTS.dispatchAfter);
}
