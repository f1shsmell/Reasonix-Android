/**
 * Which visual language this phone uses: warm paper or studio glass.
 *
 * Independent of light/dark: both styles have both appearances. Applied as a
 * root attribute so one stylesheet carries both palettes under the same
 * variable names, and a remembered choice survives cold starts.
 */

import { readChoice, writeChoice, SETTINGS_KEYS, SETTINGS_DEFAULTS, type UiStyle } from "./settings";

export type { UiStyle };

export const UI_STYLE_CHOICES: { value: UiStyle; label: string }[] = [
  { value: "paper", label: "暖纸" },
  { value: "studio", label: "深蓝" },
];

export function loadUiStyle(): UiStyle {
  return readChoice(SETTINGS_KEYS.uiStyle, ["paper", "studio"], SETTINGS_DEFAULTS.uiStyle);
}

export function saveUiStyle(style: UiStyle): void {
  writeChoice(SETTINGS_KEYS.uiStyle, style, SETTINGS_DEFAULTS.uiStyle);
}

export function applyUiStyle(style: UiStyle): void {
  document.documentElement.setAttribute("data-style", style);
}
