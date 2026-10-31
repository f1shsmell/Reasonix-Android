import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionList } from "./SessionList";
import type { TreeState } from "./useTree";
import type { ConnectionSnapshot } from "../net/connection";
import type { TreeProject } from "../wire/tree";

/**
 * The second level: one project's conversations.
 *
 * Two behaviours carry the screen. A row is a stored transcript, so opening it
 * posts its `sessionPath` (which binds the conversation, running pane or not);
 * and "新会话" posts the project's root with no path at all. A refusal has to
 * be shown, because a tap that silently does nothing is the worst outcome.
 */

let container: HTMLDivElement;
let root: Root | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function route(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

function snapshot(): ConnectionSnapshot {
  return { reach: { kind: "ok" }, runtimes: [], stream: { kind: "idle" } };
}

function project(overrides: Partial<TreeProject> = {}): TreeProject {
  return {
    root: "/work/app",
    name: "app",
    total: 2,
    remaining: 0,
    sessions: [
      {
        path: "/work/app/a.jsonl",
        name: "a",
        title: "修一下登录",
        turns: 4,
        lastActiveAt: Date.now() - 3_600_000,
      },
      { path: "/work/app/b.jsonl", name: "b", runtimeId: "r2" },
    ],
    ...overrides,
  };
}

function tree(overrides: Partial<TreeState> = {}): TreeState {
  return { projects: [project()], status: "loaded", code: "", revision: 1, reload: vi.fn(), ...overrides };
}

async function render(props: Partial<React.ComponentProps<typeof SessionList>> = {}): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <SessionList
        snapshot={snapshot()}
        tree={tree()}
        project={project()}
        onBack={() => {}}
        onOpen={() => {}}
        onRefresh={() => {}}
        {...props}
      />,
    );
  });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button containing ${text}`);
  return found;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** jsdom has no PointerEvent; the long press only reads the coordinates. */
function pointer(node: Element, type: string, x: number, y: number): void {
  act(() => {
    node.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
}

function hold(node: Element, x: number, y: number): void {
  pointer(node, "pointerdown", x, y);
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SessionList", () => {
  it("lists the project's conversations by title, not by transcript name", async () => {
    await render();

    expect(container.querySelectorAll(".session")).toHaveLength(2);
    expect(container.textContent).toContain("修一下登录");
    expect(container.textContent).toContain("4 轮");
    // The second row has no generated title: its file stem is the label.
    expect(container.textContent).toContain("b");
    expect(container.textContent).toContain("运行中");
  });

  it("shows the project name, its root and how many conversations it holds", async () => {
    await render();
    expect(container.querySelector(".bar h1")?.textContent).toBe("app");
    expect(container.textContent).toContain("/work/app");
    expect(container.querySelector(".section-head .meta")?.textContent).toBe("2");
  });

  it("opens a stored conversation by posting its path", async () => {
    const fetchMock = route(() =>
      json({ id: "r7", base: "/rt/r7", root: "/work/app", name: "app" }),
    );
    const onOpen = vi.fn();
    await render({ onOpen });

    await act(async () => {
      button("修一下登录").click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/runtimes",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ root: "/work/app", sessionPath: "/work/app/a.jsonl" }),
      }),
    );
    expect(onOpen).toHaveBeenCalledWith("r7", "修一下登录");
  });

  it("opens a fresh conversation with the root alone", async () => {
    const fetchMock = route(() => json({ id: "r8", base: "/rt/r8", root: "/work/app", name: "app" }));
    const onOpen = vi.fn();
    await render({ onOpen });

    await act(async () => {
      button("新会话").click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/runtimes",
      expect.objectContaining({ body: JSON.stringify({ root: "/work/app" }) }),
    );
    expect(onOpen).toHaveBeenCalledWith("r8", "新会话");
  });

  it("shows a refusal instead of pretending a conversation opened", async () => {
    route(() => json({ code: "session.running" }, 409));
    const onOpen = vi.fn();
    await render({ onOpen });

    await act(async () => {
      button("修一下登录").click();
    });
    await settle();

    expect(container.textContent).toContain("这个会话正在桌面端跑");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says a project with no conversations is empty rather than blank", async () => {
    await render({ project: project({ sessions: [], total: 0, remaining: 0 }) });
    expect(container.textContent).toContain("还没有会话");
    expect(container.querySelectorAll(".session")).toHaveLength(0);
  });

  it("offers the rows a window left out", async () => {
    const reload = vi.fn();
    await render({ tree: tree({ reload }), project: project({ remaining: 5 }) });

    await act(async () => {
      button("还有 5 个更早的会话").click();
    });

    expect(reload).toHaveBeenCalledWith({ "/work/app": 7 });
  });

  it("refuses to open a project whose folder is gone", async () => {
    await render({ project: project({ missing: true }) });
    expect(container.textContent).toContain("这个文件夹已经不在电脑上了");
    expect(button("新会话").disabled).toBe(true);
  });

  it("opens the row's actions on a long press and renames the conversation", async () => {
    vi.useFakeTimers();
    const fetchMock = route(() => new Response(null, { status: 204 }));
    const onRefresh = vi.fn();
    const onOpen = vi.fn();
    await render({ onRefresh, onOpen });

    const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
      candidate.textContent?.includes("修一下登录"),
    ) as HTMLElement;
    hold(row, 100, 100);
    pointer(row, "pointerup", 100, 100);

    const sheet = container.querySelector(".session-sheet") as HTMLElement;
    expect(sheet.textContent).toContain("打开会话");
    expect(sheet.textContent).toContain("重命名");
    expect(sheet.textContent).toContain("删除会话");

    act(() => button("重命名").click());
    const input = container.querySelector(".sheet-input") as HTMLInputElement;
    act(() => typeInto(input, "新的标题"));
    await act(async () => {
      button("保存").click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/tree/sessions/rename",
      expect.objectContaining({
        body: JSON.stringify({ path: "/work/app/a.jsonl", title: "新的标题" }),
      }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(container.querySelector(".session-sheet")).toBeNull();
  });

  it("confirms and deletes a conversation from the row's actions", async () => {
    vi.useFakeTimers();
    const fetchMock = route(() => new Response(null, { status: 204 }));
    const onRefresh = vi.fn();
    await render({ onRefresh });

    const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
      candidate.textContent?.includes("修一下登录"),
    ) as HTMLElement;
    hold(row, 100, 100);
    pointer(row, "pointerup", 100, 100);

    act(() => button("删除会话").click());
    expect(container.textContent).toContain("不能撤销");
    await act(async () => {
      (container.querySelector(".sheet-foot .danger") as HTMLButtonElement).click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/tree/sessions/remove",
      expect.objectContaining({
        body: JSON.stringify({ path: "/work/app/a.jsonl" }),
      }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the refusal visible when a running conversation cannot be deleted", async () => {
    vi.useFakeTimers();
    route(() => json({ code: "session.running" }, 409));
    const onRefresh = vi.fn();
    await render({ onRefresh });

    const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
      candidate.textContent?.includes("修一下登录"),
    ) as HTMLElement;
    hold(row, 100, 100);
    pointer(row, "pointerup", 100, 100);
    act(() => button("删除会话").click());
    await act(async () => {
      (container.querySelector(".sheet-foot .danger") as HTMLButtonElement).click();
    });
    await settle();

    expect(container.textContent).toContain("还在运行");
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("goes back to the project list", async () => {
    const onBack = vi.fn();
    await render({ onBack });
    act(() => (container.querySelector('[aria-label="返回项目列表"]') as HTMLButtonElement).click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
