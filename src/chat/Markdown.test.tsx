import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("does not turn raw HTML in a message into DOM", () => {
    render('<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>');
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });
});
