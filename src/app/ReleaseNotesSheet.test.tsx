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
