import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReleaseNotesSheet, parseNotes } from "./ReleaseNotesSheet";

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

describe("parseNotes", () => {
  it("keeps headings, quotes, lists and paragraphs apart", () => {
    const blocks = parseNotes(
      [
        "# 0.2.7",
        "",
        "这一版收了三处小毛病。",
        "",
        "> 可以直接在设置里安装。",
        "",
        "## 修复",
        "",
        "- **状态栏**：两层一起刷。",
        "- 完整界面走本地代理。",
      ].join("\n"),
    );

    expect(blocks).toEqual([
      { kind: "heading", text: "0.2.7" },
      { kind: "para", text: "这一版收了三处小毛病。" },
      { kind: "quote", text: "可以直接在设置里安装。" },
      { kind: "heading", text: "修复" },
      {
        kind: "list",
        items: ["状态栏：两层一起刷。", "完整界面走本地代理。"],
      },
    ]);
  });

  it("drops inline emphasis and link targets, which have no meaning here", () => {
    const blocks = parseNotes("- 见 [已知限制](../../docs/KNOWN_LIMITATIONS.md)，**不要**跳过");
    expect(blocks).toEqual([{ kind: "list", items: ["见 已知限制，不要跳过"] }]);
  });

  it("drops backticks, which the note uses around literal syntax", () => {
    const blocks = parseNotes("- **公式显示成源码**：`$...$` 现在会渲染成真正的数学公式");
    expect(blocks).toEqual([
      { kind: "list", items: ["公式显示成源码：$...$ 现在会渲染成真正的数学公式"] },
    ]);
  });

  it("joins a sentence the author wrapped, instead of splitting it", () => {
    // The notes are typed to a column: one sentence, broken at the margin.
    const blocks = parseNotes("这一版收了三处小毛病：色带修掉了，VPN 也能\n在 App 内打开完整 Studio。");

    expect(blocks).toEqual([
      {
        kind: "para",
        text: "这一版收了三处小毛病：色带修掉了，VPN 也能在 App 内打开完整 Studio。",
      },
    ]);
  });

  it("keeps a wrapped list item whole rather than leaking a paragraph", () => {
    const blocks = parseNotes("- **状态栏**：上一版只改了颜色。\n  现在两层一起刷。\n- 第二条");

    expect(blocks).toEqual([
      { kind: "list", items: ["状态栏：上一版只改了颜色。现在两层一起刷。", "第二条"] },
    ]);
  });

  it("puts a space back between two wrapped ASCII words", () => {
    const blocks = parseNotes("uses the loopback\nproxy for this");
    expect(blocks).toEqual([{ kind: "para", text: "uses the loopback proxy for this" }]);
  });

  it("ends a list at a blank line so two lists stay separate", () => {
    const blocks = parseNotes("- 一\n\n说明一句\n\n- 二");
    expect(blocks.map((block) => block.kind)).toEqual(["list", "para", "list"]);
  });

  it("returns nothing for empty input", () => {
    expect(parseNotes("")).toEqual([]);
    expect(parseNotes("\n\n  \n")).toEqual([]);
  });
});

describe("ReleaseNotesSheet", () => {
  it("draws the whole note and closes on the button", () => {
    let closed = 0;
    act(() => {
      root?.render(
        <ReleaseNotesSheet
          version="0.2.7"
          notes={"# 0.2.7\n\n这一版收了三处小毛病。\n\n## 修复\n\n- 状态栏"}
          onClose={() => {
            closed += 1;
          }}
        />,
      );
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("0.2.7 更新说明");
    expect(container.textContent).toContain("这一版收了三处小毛病。");
    expect(container.textContent).toContain("状态栏");
    // The heading repeats the sheet title, so it is not drawn twice.
    expect(container.querySelectorAll(".release-notes-body h3")).toHaveLength(1);

    const close = container.querySelector(".sheet-foot button");
    act(() => (close as HTMLButtonElement).click());
    expect(closed).toBe(1);
  });
});
