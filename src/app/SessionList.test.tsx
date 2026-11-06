import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClickSwallow } from "./longPress";
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
  resetClickSwallow();
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
  return {
    reach: { kind: "ok" },
    runtimes: [],
    stream: { kind: "idle" },
    events: [],
    eventSeq: 0,
  };
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

  /**
   * The kernel folds a recovery copy or an earlier version under the
   * conversation it came from. Drawn flat, a copy is a second row with the same
   * title and the same turn count — what the phone used to show.
   */
  describe("folded rows", () => {
    const foldedProject = (overrides: Partial<TreeProject> = {}) =>
      project({
        total: 1,
        sessions: [
          {
            path: "/work/app/a.jsonl",
            name: "a",
            title: "review 一下这个 pr",
            turns: 46,
            lastActiveAt: Date.now() - 60_000,
            copies: [
              {
                path: "/work/app/a-recovery-1.jsonl",
                name: "a-recovery-1",
                title: "review 一下这个 pr",
                turns: 46,
              },
            ],
            versions: [{ path: "/work/app/a-version-1.jsonl", name: "a-version-1", turns: 4 }],
          },
        ],
        ...overrides,
      });

    it("draws one row and a count, not one row per transcript", async () => {
      await render({ project: foldedProject() });

      // The copy's title is the conversation's own, so a flat list shows it twice.
      expect(container.querySelectorAll(".session")).toHaveLength(1);
      const fold = container.querySelector(".fold") as HTMLElement;
      expect(fold.textContent).toBe("+2");
      expect(fold.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain("恢复副本");
      expect(container.textContent).not.toContain("早先版本");
    });

    it("opens the fold without opening the conversation", async () => {
      const onOpen = vi.fn();
      await render({ project: foldedProject(), onOpen });

      const fold = container.querySelector(".fold") as HTMLButtonElement;
      await act(async () => {
        fold.click();
      });

      expect(container.textContent).toContain("早先版本 · 4 轮");
      expect(container.textContent).toContain("恢复副本");
      expect(container.querySelector(".fold")?.textContent).toBe("−");
      expect(container.querySelector(".fold")?.getAttribute("aria-expanded")).toBe("true");
      // Tapping the fold is a decision about the list, never about a pane.
      expect(onOpen).not.toHaveBeenCalled();
    });

    // A control inside a control is announced as two buttons and the inner one
    // cannot take its own tap on touch; the fold has to be the row's sibling.
    it("keeps the fold out of the conversation's own button", async () => {
      await render({ project: foldedProject() });

      const row = container.querySelector(".session") as HTMLElement;
      const fold = container.querySelector(".fold") as HTMLElement;
      expect(fold.tagName).toBe("BUTTON");
      expect(row.contains(fold)).toBe(false);
      expect(fold.parentElement).toBe(row.parentElement);
      expect(row.querySelectorAll("button, [role='button']")).toHaveLength(0);
    });

    it("labels an earlier version by its turns, and without turns when unknown", async () => {
      await render({
        project: foldedProject({
          sessions: [
            {
              path: "/work/app/a.jsonl",
              name: "a",
              versions: [
                { path: "/work/app/v1.jsonl", name: "v1", turns: 4 },
                { path: "/work/app/v2.jsonl", name: "v2" },
              ],
            },
          ],
        }),
      });

      await act(async () => {
        (container.querySelector(".fold") as HTMLElement).click();
      });

      expect(container.textContent).toContain("早先版本 · 4 轮");
      // No turn count is not the same claim as zero turns.
      expect(container.textContent).toContain("早先版本");
      expect(container.textContent).not.toContain("早先版本 · 0 轮");
    });

    // The two lists are separate on the wire; one transcript named in both must
    // not become two rows with the same React key.
    it("draws a transcript once even when it is listed as both a version and a copy", async () => {
      const shared = { path: "/work/app/same.jsonl", name: "same", turns: 3 };
      await render({
        project: foldedProject({
          sessions: [
            {
              path: "/work/app/a.jsonl",
              name: "a",
              versions: [shared],
              copies: [shared],
            },
          ],
        }),
      });

      await act(async () => {
        (container.querySelector(".fold") as HTMLElement).click();
      });

      expect(container.querySelector(".fold")?.textContent).toBe("−");
      expect(container.querySelectorAll(".session")).toHaveLength(2);
      expect(container.textContent).toContain("早先版本 · 3 轮");
    });

    it("opens a folded row as its own conversation", async () => {
      const fetchMock = route(() => json({ id: "r9", base: "/rt/r9", root: "/work/app", name: "app" }));
      const onOpen = vi.fn();
      await render({ project: foldedProject(), onOpen });

      await act(async () => {
        (container.querySelector(".fold") as HTMLElement).click();
      });
      await act(async () => {
        button("恢复副本").click();
      });
      await settle();

      expect(fetchMock).toHaveBeenCalledWith(
        "/runtimes",
        expect.objectContaining({
          body: JSON.stringify({ root: "/work/app", sessionPath: "/work/app/a-recovery-1.jsonl" }),
        }),
      );
      expect(onOpen).toHaveBeenCalledWith("r9", "review 一下这个 pr");
    });

    // A tap that does nothing for the whole of a 15s request reads as broken.
    it("marks the folded row that is opening", async () => {
      let release: (() => void) | undefined;
      route(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(json({ id: "r9", base: "/rt/r9", root: "/work/app", name: "app" }));
          }),
      );
      await render({ project: foldedProject() });

      await act(async () => {
        (container.querySelector(".fold") as HTMLElement).click();
      });
      act(() => {
        button("恢复副本").click();
      });

      const opening = Array.from(container.querySelectorAll("button.session")).find((candidate) =>
        candidate.textContent?.includes("正在打开…"),
      ) as HTMLButtonElement;
      expect(opening).toBeDefined();
      expect(opening.disabled).toBe(true);

      await act(async () => {
        release?.();
      });
      await settle();
    });

    it("warns that a delete keeps the copies holding content of their own", async () => {
      vi.useFakeTimers();
      await render({ project: foldedProject() });

      const row = container.querySelector(".session") as HTMLElement;
      hold(row, 100, 100);
      pointer(row, "pointerup", 100, 100);
      act(() => button("删除会话").click());

      expect(container.textContent).toContain("还有 1 份恢复副本带着这个会话没有的内容");
      expect(container.textContent).toContain("不能撤销");
    });

    it("keeps the plain delete warning for a row with nothing folded under it", async () => {
      vi.useFakeTimers();
      await render();

      const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
        candidate.textContent?.includes("修一下登录"),
      ) as HTMLElement;
      hold(row, 100, 100);
      pointer(row, "pointerup", 100, 100);
      act(() => button("删除会话").click());

      expect(container.textContent).not.toContain("份恢复副本");
      expect(container.textContent).toContain("不能撤销");
    });
  });
});
