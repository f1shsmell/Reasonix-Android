/**
 * How large the conversation's reading text is drawn.
 *
 * The transcript is the one surface a person stares at for minutes, and the
 * comfortable size varies with eyes and holding distance — one fixed 15px
 * cannot fit all of it. The choice scales the message bubbles and the markdown
 * inside them; metadata (timestamps, pills, activity rows) keeps its own size,
 * because those are chrome, not content. Like the fold and the theme, the
 * choice belongs to this phone, not to the kernel.
 */

import { readChoice, writeChoice, SETTINGS_KEYS } from "../app/settings";

export type ChatFont = "sm" | "standard" | "lg" | "xl";

export const CHAT_FONT_CHOICES: ReadonlyArray<{ value: ChatFont; label: string }> = [
  { value: "sm", label: "小" },
  { value: "standard", label: "标准" },
  { value: "lg", label: "大" },
  { value: "xl", label: "特大" },
];

export const CHAT_FONT_NOTE =
  "只改变会话正文的字号，标题、代码和时间戳等元信息保持原样。只影响这台手机。";

const DEFAULT: ChatFont = "standard";

export function isChatFont(value: unknown): value is ChatFont {
  return value === "sm" || value === "standard" || value === "lg" || value === "xl";
}

export function loadChatFont(): ChatFont {
  return readChoice(SETTINGS_KEYS.chatFont, ["sm", "standard", "lg", "xl"], DEFAULT);
}

export function saveChatFont(font: ChatFont): void {
  writeChoice(SETTINGS_KEYS.chatFont, font, DEFAULT);
}

/**
 * Apply as a `data-chat-font` attribute on the document root, the way the
 * theme applies `data-theme`; the default removes the attribute so the CSS
 * default stands. Called before the first paint and again on every change.
 */
export function applyChatFont(font: ChatFont): void {
  const root = document.documentElement;
  if (font === DEFAULT) root.removeAttribute("data-chat-font");
  else root.setAttribute("data-chat-font", font);
}
