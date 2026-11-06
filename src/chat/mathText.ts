/**
 * The math delimiters models actually write.
 *
 * remark-math reads `$...$` and `$$...$$`; a model that writes LaTeX's own
 * `\(...\)` and `\[...\]` would otherwise reach the screen as escaped
 * parentheses and brackets. Convert the backslash forms outside code spans
 * and fenced blocks, where they are source text rather than math.
 */
export function normalizeMath(text: string): string {
  const parts = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, body: string) => `\n$$\n${body}\n$$\n`)
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, body: string) => `$${body}$`);
    })
    .join("");
}
