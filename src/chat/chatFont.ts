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

export type ChatFont = "sm" | "standard" | "lg" | "xl";

export const CHAT_FONT_CHOICES: ReadonlyArray<{ value: ChatFont; label: string }> = [
  { value: "sm", label: "小" },
  { value: "standard", label: "标准" },
  { value: "lg", label: "大" },
  { value: "xl", label: "特大" },
];

export const CHAT_FONT_NOTE =
  "只改变会话正文的字号，标题、代码和时间戳等元信息保持原样。只影响这台手机。";

const KEY = "reasonix.chat-font.v1";
const DEFAULT: ChatFont = "standard";

export function isChatFont(value: unknown): value is ChatFont {
  return value === "sm" || value === "standard" || value === "lg" || value === "xl";
}

export function loadChatFont(): ChatFont {
  try {
    const stored = localStorage.getItem(KEY);
    return isChatFont(stored) ? stored : DEFAULT;
  } catch {
    // A blocked storage API costs the setting, not the screen.
    return DEFAULT;
  }
}

export function saveChatFont(font: ChatFont): void {
  try {
    if (font === DEFAULT) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, font);
  } catch {
    // The next cold start reads the default; this session keeps the choice.
  }
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
