import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

/**
 * Assistant messages are Markdown. Rendering is also the place most likely to
 * turn a model answer into markup, so the tests check both the formatting and
 * that raw HTML stays inert.
 */

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

function render(text: string): void {
  root = createRoot(container);
  act(() => root?.render(<Markdown text={text} />));
}

describe("Markdown", () => {
  it("renders headings, emphasis and lists", () => {
    render("## 结果\n\n这是 **粗体** 和 `code`。\n\n- 一\n- 二");
    expect(container.querySelector("h2")?.textContent).toBe("结果");
    expect(container.querySelector("strong")?.textContent).toBe("粗体");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("keeps fenced code as a block, not inline text", () => {
    render("```js\nconst x = 1;\n```");
    const code = container.querySelector("pre code");
    expect(code?.textContent?.trim()).toBe("const x = 1;");
    expect(code?.className).toContain("language-js");
  });

  it("opens links outside the WebView", () => {
    render("[文档](https://example.com/a)");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noreferrer");
  });

  it("scrolls wide GFM tables instead of widening the bubble", () => {
    render("| 名称 | 值 |\n| --- | --- |\n| a | 1 |");
    expect(container.querySelector(".table-wrap table")).toBeTruthy();
    expect(container.querySelectorAll("th")).toHaveLength(2);
  });

  it("sanitizes raw HTML but keeps a safe details block", () => {
    render(
      '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n' +
        "<details open><summary>展开查看详情</summary>\n\n可折叠内容。</details>",
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("onerror")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(container.querySelector("summary")?.textContent).toBe("展开查看详情");
    expect(container.querySelector("details")?.textContent).toContain("可折叠内容。");
  });

  it("parses markdown inside a details block", () => {
    render("<details><summary>展开</summary>\n\n包含 **粗体** 和 `代码`。\n\n</details>");
    expect(container.querySelector("details strong")?.textContent).toBe("粗体");
    expect(container.querySelector("details code")?.textContent).toBe("代码");
  });

  it("renders the LaTeX delimiters models actually write", () => {
    render("行内 \\(E = mc^2\\)\n\n\\[\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\\]");
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain("\\(");
    expect(container.textContent).not.toContain("\\[");
  });

  it("renders inline and block math via KaTeX", () => {
    render("行内 $E = mc^2$ 公式。\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$");
    const math = container.querySelectorAll(".katex");
    expect(math.length).toBeGreaterThanOrEqual(2);
    // KaTeX 渲染后不再有裸 "$$" 定界符；原始 LaTeX 会保留在 annotation 里，
    // 因此只断言定界符消失和可视节点（.katex-html）生成。
    expect(container.textContent).not.toContain("$$");
    expect(container.querySelector(".katex-html")).toBeTruthy();
  });

  it("highlights fenced code and offers a copy action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render("```js\nconst x = 1;\n```");

    const code = container.querySelector("pre code");
    expect(code?.className).toContain("hljs");
    expect(code?.querySelector(".hljs-keyword")?.textContent).toBe("const");

    const copy = container.querySelector(".code-block > .copy") as HTMLButtonElement | null;
    expect(copy).toBeTruthy();
    await act(async () => {
      copy?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith("const x = 1;");

    delete (navigator as { clipboard?: unknown }).clipboard;
  });
});
