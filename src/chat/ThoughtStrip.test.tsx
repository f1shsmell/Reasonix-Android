import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThoughtStrip } from "./ThoughtStrip";

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

function mount(props: { text: string; thoughtMs?: number; running?: boolean }): void {
  root = createRoot(container);
  act(() => {
    root?.render(<ThoughtStrip {...props} />);
  });
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
  });

describe("ThoughtStrip", () => {
  it("draws nothing for an empty thought", () => {
    mount({ text: "   " });
    expect(container.querySelector(".thought")).toBeNull();
  });

  it("stays one folded line until tapped, then a bounded window", async () => {
    mount({ text: "先想一下\n再想一下", thoughtMs: 2400 });
    await flush();
    const row = container.querySelector<HTMLButtonElement>(".thought-row");
    expect(row?.textContent).toContain("深度思考");
    expect(row?.textContent).toContain("思考了 2 秒");
    expect(row?.textContent).toContain("9 字");
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".thought-body")).toBeNull();
    act(() => row?.click());
    const body = container.querySelector(".thought-body");
    expect(body?.textContent).toContain("先想一下");
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    act(() => row?.click());
    expect(container.querySelector(".thought-body")).toBeNull();
  });

  it("says 思考中 with a caret while the thought is still streaming", async () => {
    mount({ text: "正在想", running: true });
    await flush();
    expect(container.querySelector(".thought-row")?.textContent).toContain("思考中");
    act(() => container.querySelector<HTMLButtonElement>(".thought-row")?.click());
    expect(container.querySelector(".thought-caret")).not.toBeNull();
  });

  it("streams the thought in place while running and closed", () => {
    mount({ text: "第一段思路\n第二段思路", running: true });
    const preview = container.querySelector(".thought-body.live");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain("第二段思路");
    // Decorative: the folded row above is the control that opens it all.
    expect(preview?.getAttribute("aria-hidden")).toBe("true");
  });

  it("a settled strip keeps no preview", () => {
    mount({ text: "想完了", thoughtMs: 900 });
    expect(container.querySelector(".thought-body.live")).toBeNull();
  });

  it("opening swaps the preview for the bounded window", () => {
    mount({ text: "全文都在这里", running: true });
    expect(container.querySelector(".thought-body.live")).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>(".thought-row")?.click());
    expect(container.querySelector(".thought-body.live")).toBeNull();
    expect(container.querySelector(".thought-body:not(.live)")?.textContent).toContain("全文都在这里");
  });

  it("drops the caret once the thought settles", async () => {
    mount({ text: "想完了", thoughtMs: 900 });
    await flush();
    act(() => container.querySelector<HTMLButtonElement>(".thought-row")?.click());
    expect(container.querySelector(".thought-caret")).toBeNull();
  });

  it("counts graphemes, not code units", async () => {
    mount({ text: String.fromCodePoint(0x1f433).repeat(4), thoughtMs: 1000 });
    await flush();
    expect(container.querySelector(".thought-row")?.textContent).toContain("4 字");
  });
});