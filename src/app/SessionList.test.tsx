import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionList } from "./SessionList";
import type { ConnectionSnapshot } from "../net/connection";

/**
 * The list is the screen that has to be honest about reachability: a row that
 * cannot be opened must not look like an invitation. These are the four
 * `Reach` states and the two controls a person can press.
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

function snapshot(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    reach: { kind: "ok" },
    runtimes: [
      { id: "r1", base: "/rt/r1", root: "/work/app", name: "app" },
      { id: "r2", base: "/rt/r2", root: "/work/docs", name: "docs", readOnly: true },
    ],
    stream: { kind: "open" },
    ...overrides,
  };
}

function render(node: React.ReactElement): void {
  act(() => root?.unmount());
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

describe("SessionList", () => {
  it("shows every runtime with its root and read-only state", () => {
    render(<SessionList snapshot={snapshot()} onOpen={() => {}} onRefresh={() => {}} />);

    expect(container.querySelectorAll(".session")).toHaveLength(2);
    expect(container.textContent).toContain("app");
    expect(container.textContent).toContain("/work/app");
    expect(container.textContent).toContain("只读");
  });

  it("opens the runtime that was pressed", () => {
    const onOpen = vi.fn();
    render(<SessionList snapshot={snapshot()} onOpen={onOpen} onRefresh={() => {}} />);

    act(() => button("app/work/app").click());

    expect(onOpen).toHaveBeenCalledWith("r1");
  });

  it("distinguishes unauthorized, unreachable and still-connecting", () => {
    render(
      <SessionList
        snapshot={snapshot({ reach: { kind: "unauthorized" }, runtimes: [] })}
        onOpen={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(container.textContent).toContain("需要令牌");

    render(
      <SessionList
        snapshot={snapshot({ reach: { kind: "unreachable", detail: "connection refused" }, runtimes: [] })}
        onOpen={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(container.textContent).toContain("连不上这台电脑");
    expect(container.textContent).toContain("connection refused");

    render(
      <SessionList snapshot={snapshot({ reach: { kind: "unknown" }, runtimes: [] })} onOpen={() => {}} onRefresh={() => {}} />,
    );
    expect(container.textContent).toContain("正在连接");
  });

  it("shows an empty state instead of an empty list", () => {
    render(<SessionList snapshot={snapshot({ runtimes: [] })} onOpen={() => {}} onRefresh={() => {}} />);
    expect(container.textContent).toContain("没有打开的会话");
    expect(container.querySelectorAll(".session")).toHaveLength(0);
  });

  it("wires refresh and settings, and hides settings when it has nowhere to go", () => {
    const onRefresh = vi.fn();
    const onSettings = vi.fn();
    render(
      <SessionList snapshot={snapshot()} onOpen={() => {}} onRefresh={onRefresh} onSettings={onSettings} />,
    );

    act(() => button("⟳").click());
    act(() => button("⚙").click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onSettings).toHaveBeenCalledTimes(1);

    render(<SessionList snapshot={snapshot()} onOpen={() => {}} onRefresh={() => {}} />);
    expect(container.querySelector('button[aria-label="连接与账号"]')).toBeNull();
  });

  it("opens the new-session/project sheet from the plus", () => {
    const onNew = vi.fn();
    render(<SessionList snapshot={snapshot()} onOpen={() => {}} onRefresh={() => {}} onNew={onNew} />);

    act(() => button("＋").click());

    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
