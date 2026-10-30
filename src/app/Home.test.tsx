import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home, projectActivity, recentConversations } from "./Home";
import { rememberConnection } from "../net/savedConnections";
import type { LinkState } from "../net/link";
import type { HomeTab } from "./swipe";
import type { NeedsYouState } from "./useNeedsYou";
import type { TreeState } from "./useTree";
import type { ConnectionSnapshot } from "../net/connection";
import type { TreeProject } from "../wire/tree";

/**
 * The home screen has two views of one tree: every conversation by recency,
 * or the projects themselves. These assertions cover the merge, the search,
 * the two-way switch, and that a row opens what it names.
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
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function snapshot(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return { reach: { kind: "ok" }, runtimes: [], stream: { kind: "idle" }, ...overrides };
}

function project(overrides: Partial<TreeProject> = {}): TreeProject {
  return {
    root: "/work/app",
    name: "app",
    remembered: true,
    total: 2,
    remaining: 0,
    sessions: [
      { path: "/work/app/a.jsonl", name: "a", title: "修一下登录", lastActiveAt: Date.now() - 60_000 },
      { path: "/work/app/b.jsonl", name: "b", runtimeId: "r2", lastActiveAt: Date.now() - 7_200_000 },
    ],
    ...overrides,
  };
}

function tree(overrides: Partial<TreeState> = {}): TreeState {
  return { projects: [project()], status: "loaded", code: "", revision: 1, reload: vi.fn(), ...overrides };
}

function pending(overrides: Partial<NeedsYouState> = {}): NeedsYouState {
  return { items: [], running: [], status: "loaded", refresh: vi.fn(), markSeen: vi.fn(), ...overrides };
}

function Harness(props: Partial<React.ComponentProps<typeof Home>>): React.ReactElement {
  const [tab, setTab] = useState<HomeTab>("recent");
  return (
    <Home
      snapshot={snapshot()}
      tree={tree()}
      pending={pending()}
      tab={tab}
      onTabChange={setTab}
      link={{ phase: "connected", completed: [], attempt: 0, target: "/work/app", name: "app", mode: "lan" }}
      onSwitchConnection={() => {}}
      onRetryLink={() => {}}
      onOpenProject={() => {}}
      onOpenSession={() => {}}
      onOpenRuntime={() => {}}
      onNewSession={() => {}}
      onRefresh={() => {}}
      {...props}
    />
  );
}

function render(props: Partial<React.ComponentProps<typeof Home>> = {}): void {
  act(() => root?.unmount());
  root = createRoot(container);
  act(() => root?.render(<Harness {...props} />));
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

function typeInto(input: HTMLInputElement, value: string): void {
  // React tracks the input's value; setting it through the prototype setter is
  // what makes the synthetic change fire instead of being swallowed.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeIntoArea(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** jsdom has no PointerEvent; React only reads the fields the row uses. */
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

/** jsdom reports every box as 0×0; rows need a height for a drop to land. */
function stubRows(): HTMLElement[] {
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-project-root]"));
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () =>
      ({
        top: index * 60,
        bottom: index * 60 + 60,
        height: 60,
        left: 0,
        right: 320,
        width: 320,
        x: 0,
        y: index * 60,
        toJSON: () => ({}),
      }) as DOMRect;
  });
  return rows;
}

describe("Home", () => {
  it("merges every project's conversations by recency", () => {
    const rows = recentConversations([
      project(),
      project({
        root: "/work/docs",
        name: "docs",
        sessions: [
          { path: "/work/docs/c.jsonl", name: "c", title: "文档", lastActiveAt: Date.now() - 30_000 },
        ],
      }),
    ]);

    expect(rows.map((row) => row.session.path)).toEqual([
      "/work/docs/c.jsonl",
      "/work/app/a.jsonl",
      "/work/app/b.jsonl",
    ]);
  });

  it("opens on the recent view with a project name on each row", () => {
    render();
    expect(container.querySelectorAll(".session")).toHaveLength(2);
    expect(container.textContent).toContain("修一下登录");
    expect(container.textContent).toContain("app");
    expect(container.textContent).toContain("运行中");
  });

  it("switches to the project view and back", () => {
    render();
    expect(container.querySelectorAll(".project")).toHaveLength(0);

    act(() => button("项目").click());
    expect(container.querySelectorAll(".project")).toHaveLength(1);
    expect(container.textContent).toContain("/work/app");

    act(() => button("最近").click());
    expect(container.querySelectorAll(".session")).toHaveLength(2);
  });

  it("filters conversations by title, project name or path", () => {
    render();
    const search = container.querySelector(".search") as HTMLInputElement;

    act(() => {
      typeInto(search, "登录");
    });
    expect(container.querySelectorAll(".session")).toHaveLength(1);

    act(() => {
      typeInto(search, "/work/app");
    });
    expect(container.querySelectorAll(".session")).toHaveLength(2);

    act(() => {
      typeInto(search, "没有这个");
    });
    expect(container.textContent).toContain("没有匹配");
  });

  it("filters projects in the project view", () => {
    render({
      tree: tree({
        projects: [
          project(),
          project({ root: "/work/docs", name: "docs", sessions: [], total: 0 }),
        ],
      }),
    });
    act(() => button("项目").click());
    expect(container.querySelectorAll(".project")).toHaveLength(2);

    const search = container.querySelector(".search") as HTMLInputElement;
    act(() => {
      typeInto(search, "docs");
    });
    expect(container.querySelectorAll(".project")).toHaveLength(1);
  });

  it("opens a conversation by posting its path", async () => {
    const fetchMock = route(() =>
      json({ id: "r9", base: "/rt/r9", root: "/work/app", name: "app" }),
    );
    const onOpenSession = vi.fn();
    render({ onOpenSession });

    await act(async () => {
      button("修一下登录").click();
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/runtimes",
      expect.objectContaining({
        body: JSON.stringify({ root: "/work/app", sessionPath: "/work/app/a.jsonl" }),
      }),
    );
    expect(onOpenSession).toHaveBeenCalledWith("r9", "/work/app", "修一下登录");
  });

  it("opens a project without opening a conversation", () => {
    const onOpenProject = vi.fn();
    render({ onOpenProject });
    act(() => button("项目").click());
    act(() => button("app/work/app").click());
    expect(onOpenProject).toHaveBeenCalledWith("/work/app");
  });

  it("starts a new conversation after choosing a project", () => {
    const onNewSession = vi.fn();
    render({
      onNewSession,
      tree: tree({
        projects: [
          project(),
          project({ root: "/work/docs", name: "docs", sessions: [], total: 0 }),
        ],
      }),
    });

    act(() => (container.querySelector('[aria-label="新建会话"]') as HTMLButtonElement).click());
    const sheet = container.querySelector(".sheet");
    expect(sheet?.textContent).toContain("在哪个项目新建");

    act(() =>
      (Array.from(sheet?.querySelectorAll(".project") ?? []).find((candidate) =>
        candidate.textContent?.includes("docs"),
      ) as HTMLButtonElement).click(),
    );

    expect(onNewSession).toHaveBeenCalledWith("/work/docs");
    expect(container.querySelector(".sheet")).toBeNull();
  });

  it("cannot start a session when no project is known", () => {
    render({ tree: tree({ projects: [] }) });
    expect(container.textContent).toContain("还没有会话");
    expect((container.querySelector('[aria-label="新建会话"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a failed read with its code", () => {
    render({
      tree: tree({ projects: [], status: "failed", code: "client.offline" }),
      snapshot: snapshot({ reach: { kind: "unreachable", detail: "connection refused" } }),
    });
    expect(container.textContent).toContain("读不到项目列表");
    expect(container.textContent).toContain("client.offline");
    expect(container.textContent).toContain("连不上这台电脑");
  });

  it("shows a refusal instead of pretending a conversation opened", async () => {
    route(() => json({ code: "session.running" }, 409));
    const onOpenSession = vi.fn();
    render({ onOpenSession });

    await act(async () => {
      button("修一下登录").click();
    });
    await settle();

    expect(container.textContent).toContain("这个会话正在桌面端跑");
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("reports a project's newest conversation as its activity", () => {
    const at = Date.now() - 60_000;
    expect(projectActivity(project())).toBe(at);
  });

  describe("Dispatch", () => {
    it("sends a task without opening the chat", async () => {
      const onDispatch = vi.fn(async () => ({ ok: true as const }));
      render({ onDispatch });

      act(() => {
        (container.querySelector('[aria-label="派任务"]') as HTMLButtonElement).click();
      });
      const sheet = container.querySelector(".dispatch-sheet");
      expect(sheet?.textContent).toContain("派任务");
      expect(sheet?.textContent).toContain("app");

      const prompt = sheet?.querySelector(".dispatch-prompt") as HTMLTextAreaElement;
      act(() => typeIntoArea(prompt, "修复登录白屏"));
      act(() => {
        (Array.from(sheet?.querySelectorAll("button") ?? []).find(
          (candidate) => candidate.textContent?.trim() === "派发",
        ) as HTMLButtonElement).click();
      });
      await settle();

      expect(onDispatch).toHaveBeenCalledWith("/work/app", "修复登录白屏");
      expect(container.querySelector(".dispatch-sheet")).toBeNull();
    });

    it("keeps the sheet and the reason when the task cannot start", async () => {
      const onDispatch = vi.fn(async () => ({ ok: false, message: "连不上电脑。" }));
      render({ onDispatch });

      act(() => {
        (container.querySelector('[aria-label="派任务"]') as HTMLButtonElement).click();
      });
      const sheet = container.querySelector(".dispatch-sheet");
      const prompt = sheet?.querySelector(".dispatch-prompt") as HTMLTextAreaElement;
      act(() => typeIntoArea(prompt, "跑一下测试"));
      act(() => {
        (Array.from(sheet?.querySelectorAll("button") ?? []).find(
          (candidate) => candidate.textContent?.trim() === "派发",
        ) as HTMLButtonElement).click();
      });
      await settle();

      expect(container.querySelector(".dispatch-sheet")).toBeTruthy();
      expect(container.querySelector(".dispatch-sheet")?.textContent).toContain("连不上电脑。");
    });
  });

  describe("Needs You", () => {
    function waiting(overrides: Partial<import("./useNeedsYou").PendingItem> = {}) {
      return {
        base: "/rt/r2",
        runtimeId: "r2",
        projectName: "app",
        projectRoot: "/work/app",
        title: "修一下登录",
        decision: { id: "d1", kind: "ask" },
        firstSeenAt: Date.now(),
        isNew: false,
        ...overrides,
      };
    }

    it("puts a blocked conversation above the list, with what it wants", () => {
      render({
        pending: pending({
          items: [
            waiting({
              decision: {
                id: "d1",
                kind: "ask",
                questions: [{ id: "q", header: "用哪个方案", prompt: "选一个", options: [] }],
              },
            }),
          ],
        }),
      });

      const block = container.querySelector(".needs-you");
      expect(block).toBeTruthy();
      expect(block?.textContent).toContain("待你处理");
      expect(block?.textContent).toContain("修一下登录");
      expect(block?.textContent).toContain("待回答");
      expect(block?.textContent).toContain("用哪个方案");
      expect(block?.textContent).toContain("app");
    });

    it("marks a new decision with its computer and how long it has waited", () => {
      render({
        pending: pending({
          items: [waiting({ firstSeenAt: Date.now() - 6 * 60_000, isNew: true })],
        }),
        link: {
          phase: "connected",
          completed: [],
          attempt: 0,
          target: "/work/app",
          name: "studio",
          mode: "lan",
        },
      });

      const block = container.querySelector(".needs-you");
      expect(block?.textContent).toContain("新");
      expect(block?.textContent).toContain("等待 6 分钟");
      expect(block?.textContent).toContain("studio · app");
    });

    it("marks a decision seen when its card is opened", () => {
      const markSeen = vi.fn();
      render({ pending: pending({ items: [waiting({ isNew: true })], markSeen }) });

      act(() => (container.querySelector(".card-need") as HTMLButtonElement).click());

      expect(markSeen).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "r2" }));
    });

    it("names the subsystem when the decision carries no question text", () => {
      render({ pending: pending({ items: [waiting({ decision: { id: "d2", kind: "tool_approval" } })] }) });
      expect(container.querySelector(".needs-you")?.textContent).toContain("待批准");
      expect(container.querySelector(".needs-you")?.textContent).toContain("批准一个工具调用");
    });

    it("opens the running pane rather than opening a second one", () => {
      const onOpenRuntime = vi.fn();
      render({ pending: pending({ items: [waiting()] }), onOpenRuntime });

      act(() => (container.querySelector(".card-need") as HTMLButtonElement).click());

      expect(onOpenRuntime).toHaveBeenCalledWith("r2", "/work/app", "修一下登录");
    });

    it("shows a turn that is still working, apart from a blocked one", () => {
      render({
        pending: pending({
          running: [
            {
              base: "/rt/r2",
              runtimeId: "r2",
              projectName: "app",
              projectRoot: "/work/app",
              title: "修一下登录",
              firstSeenAt: Date.now(),
            },
          ],
        }),
      });

      const block = container.querySelector(".needs-you");
      expect(block?.textContent).toContain("正在运行");
      expect(block?.textContent).toContain("修一下登录");
      expect(block?.textContent).toContain("正在处理…");
      expect(block?.textContent).not.toContain("待你处理");
    });

    it("does not repeat a blocked conversation under running", () => {
      render({
        pending: pending({
          items: [waiting()],
          running: [
            {
              base: "/rt/r2",
              runtimeId: "r2",
              projectName: "app",
              projectRoot: "/work/app",
              title: "修一下登录",
              firstSeenAt: Date.now(),
            },
          ],
        }),
      });

      expect(container.querySelectorAll(".card-need")).toHaveLength(1);
    });

    it("draws nothing when nothing is waiting", () => {
      render({ pending: pending() });
      expect(container.querySelector(".needs-you")).toBeNull();
    });

    it("draws nothing while the first sweep is still running", () => {
      render({ pending: pending({ status: "loading" }) });
      expect(container.querySelector(".needs-you")).toBeNull();
    });

    it("belongs to the recent view, not to the project folders", () => {
      render({ pending: pending({ items: [waiting()] }) });
      expect(container.querySelector(".needs-you")).toBeTruthy();

      act(() => button("项目").click());
      expect(container.querySelector(".needs-you")).toBeNull();
    });

    it("is hidden while searching, so a filtered list stays filtered", () => {
      render({ pending: pending({ items: [waiting()] }) });
      const search = container.querySelector(".search") as HTMLInputElement;
      act(() => {
        typeInto(search, "登录");
      });
      expect(container.querySelector(".needs-you")).toBeNull();
    });
  });

  describe("pinning", () => {
    function pinnedProject(): TreeProject {
      return project({
        sessions: [
          { path: "/work/app/a.jsonl", name: "a", title: "旧的", lastActiveAt: Date.now() - 60_000 },
          {
            path: "/work/app/b.jsonl",
            name: "b",
            title: "钉住的",
            pinned: true,
            lastActiveAt: Date.now() - 7_200_000,
          },
        ],
      });
    }

    it("moves a pinned conversation above a newer one", () => {
      render({ tree: tree({ projects: [pinnedProject()] }) });

      const names = Array.from(container.querySelectorAll(".session-name")).map(
        (node) => node.textContent ?? "",
      );
      expect(names[0]).toContain("钉住的");
      expect(names[1]).toContain("旧的");
    });

    it("keeps the pin off the row and behind a press", () => {
      render({ tree: tree({ projects: [pinnedProject()] }) });

      expect(container.querySelector(".list li.pinned")).toBeTruthy();
      expect(container.querySelector(".pinbtn")).toBeNull();
      expect(container.textContent).not.toContain("已置顶");
    });

    it("opens the row's actions on a long press instead of the conversation", () => {
      vi.useFakeTimers();
      const onOpenSession = vi.fn();
      render({ tree: tree({ projects: [pinnedProject()] }), onOpenSession });

      const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
        candidate.textContent?.includes("钉住的"),
      ) as HTMLElement;
      hold(row, 100, 100);
      pointer(row, "pointerup", 100, 100);

      const sheet = container.querySelector(".session-sheet");
      expect(sheet?.textContent).toContain("取消置顶");
      expect(sheet?.textContent).toContain("打开会话");

      const click = new MouseEvent("click", { bubbles: true, cancelable: true });
      act(() => row.dispatchEvent(click));
      expect(onOpenSession).not.toHaveBeenCalled();
    });

    it("posts the pin from the actions and re-reads the tree", async () => {
      const fetchMock = route(() => new Response(null, { status: 204 }));
      const onRefresh = vi.fn();
      render({ tree: tree({ projects: [pinnedProject()] }), onRefresh });

      act(() => {
        container
          .querySelector(".session")
          ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
      const sheet = container.querySelector(".session-sheet") as HTMLElement;
      await act(async () => {
        (Array.from(sheet.querySelectorAll("button")).find((candidate) =>
          candidate.textContent?.includes("置顶"),
        ) as HTMLButtonElement).click();
      });
      await settle();

      expect(fetchMock).toHaveBeenCalledWith(
        "/tree/sessions/pin",
        expect.objectContaining({
          body: JSON.stringify({ path: "/work/app/b.jsonl", pinned: false }),
        }),
      );
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it("does not draw the pin before the kernel agrees", async () => {
      // A refusal means the row must stay exactly where it was.
      route(() => json({ code: "session.outside_workspace" }, 403));
      const onRefresh = vi.fn();
      render({ tree: tree({ projects: [pinnedProject()] }), onRefresh });

      act(() => {
        container
          .querySelector(".session")
          ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
      const sheet = container.querySelector(".session-sheet") as HTMLElement;
      await act(async () => {
        (Array.from(sheet.querySelectorAll("button")).find((candidate) =>
          candidate.textContent?.includes("取消置顶"),
        ) as HTMLButtonElement).click();
      });
      await settle();

      expect(container.textContent).toContain("不在已知项目");
      expect(onRefresh).not.toHaveBeenCalled();
      expect(container.querySelector(".list li.pinned")).toBeTruthy();
    });
  });

  describe("project order", () => {
    function twoProjects(): TreeProject[] {
      return [
        project({ root: "/work/app", name: "app" }),
        project({ root: "/work/docs", name: "docs", sessions: [], total: 0 }),
      ];
    }

    /** The projects view with rows that have real heights for a drop to land in. */
    function drawProjects(props: Partial<React.ComponentProps<typeof Home>> = {}): HTMLElement[] {
      render({ tree: tree({ projects: twoProjects() }), ...props });
      act(() => button("项目").click());
      return stubRows();
    }

    function rowAt(rows: HTMLElement[], index: number): HTMLElement {
      const found = rows[index];
      if (!found) throw new Error(`no project row ${index}`);
      return found;
    }

    it("picks a row up after a still press and drops it at the end", async () => {
      vi.useFakeTimers();
      const fetchMock = route(() => new Response(null, { status: 204 }));
      const onRefresh = vi.fn();
      const rows = drawProjects({ onRefresh });

      hold(rowAt(rows, 0), 160, 10);
      pointer(rowAt(rows, 0), "pointermove", 160, 110);
      expect(rowAt(rows, 1).getAttribute("data-drop")).toBe("after");

      pointer(rowAt(rows, 0), "pointerup", 160, 110);
      await settle();

      expect(fetchMock).toHaveBeenCalledWith(
        "/tree/workspaces/move",
        expect.objectContaining({
          body: JSON.stringify({ path: "/work/app", before: "" }),
        }),
      );
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it("drops before the project it was released above", async () => {
      vi.useFakeTimers();
      const fetchMock = route(() => new Response(null, { status: 204 }));
      const rows = drawProjects();

      hold(rowAt(rows, 1), 160, 130);
      pointer(rowAt(rows, 1), "pointermove", 160, 10);
      expect(rowAt(rows, 0).getAttribute("data-drop")).toBe("before");

      pointer(rowAt(rows, 1), "pointerup", 160, 10);
      await settle();

      expect(fetchMock).toHaveBeenCalledWith(
        "/tree/workspaces/move",
        expect.objectContaining({
          body: JSON.stringify({ path: "/work/docs", before: "/work/app" }),
        }),
      );
    });

    it("writes nothing when a row is dropped where it already sat", async () => {
      vi.useFakeTimers();
      const fetchMock = route(() => new Response(null, { status: 204 }));
      const rows = drawProjects();

      hold(rowAt(rows, 0), 160, 20);
      pointer(rowAt(rows, 0), "pointermove", 160, 40);
      pointer(rowAt(rows, 0), "pointerup", 160, 40);
      await settle();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("leaves the order alone when the kernel refuses", async () => {
      vi.useFakeTimers();
      route(() => json({ code: "workspace.not_remembered" }, 404));
      const onRefresh = vi.fn();
      const rows = drawProjects({ onRefresh });

      hold(rowAt(rows, 0), 160, 10);
      pointer(rowAt(rows, 0), "pointermove", 160, 110);
      pointer(rowAt(rows, 0), "pointerup", 160, 110);
      await settle();

      expect(container.textContent).toContain("没有被记住");
      expect(onRefresh).not.toHaveBeenCalled();
    });

    it("does not pick up rows while a search is filtering them", () => {
      vi.useFakeTimers();
      const fetchMock = route(() => new Response(null, { status: 204 }));
      const rows = drawProjects();

      const search = container.querySelector(".search") as HTMLInputElement;
      act(() => {
        typeInto(search, "app");
      });
      // The one visible row is not the first project, so a drop has no place.
      hold(rowAt(rows, 0), 160, 10);
      pointer(rowAt(rows, 0), "pointermove", 160, 110);
      pointer(rowAt(rows, 0), "pointerup", 160, 110);

      expect(rowAt(rows, 0).getAttribute("data-drop")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not pick up a folder the kernel does not remember", () => {
      vi.useFakeTimers();
      const rows = drawProjects({
        tree: tree({
          projects: [
            project({ root: "/work/app", name: "app", remembered: false }),
            project({ root: "/work/docs", name: "docs", sessions: [], total: 0 }),
          ],
        }),
      });

      hold(rowAt(rows, 0), 160, 10);

      expect(rowAt(rows, 0).getAttribute("data-drop")).toBeNull();
    });
  });

  describe("swiping between the views", () => {
    /** jsdom has no Touch; the handler only reads the coordinates. */
    function swipeOn(node: Element, from: [number, number], to: [number, number]): void {
      act(() => {
        node.dispatchEvent(
          Object.assign(new Event("touchstart", { bubbles: true }), {
            touches: [{ clientX: from[0], clientY: from[1] }],
          }),
        );
        node.dispatchEvent(
          Object.assign(new Event("touchend", { bubbles: true }), {
            changedTouches: [{ clientX: to[0], clientY: to[1] }],
          }),
        );
      });
    }

    it("switches to the project view on a leftward drag", () => {
      render();
      expect(container.querySelectorAll(".session").length).toBeGreaterThan(0);

      swipeOn(container.querySelector(".shell") as Element, [300, 400], [120, 410]);

      expect(container.querySelector('button[role="tab"][aria-selected="true"]')?.textContent).toBe(
        "项目",
      );
    });

    it("switches back on a rightward drag", () => {
      render();
      act(() => button("项目").click());

      swipeOn(container.querySelector(".shell") as Element, [120, 400], [300, 410]);

      expect(container.querySelector('button[role="tab"][aria-selected="true"]')?.textContent).toBe(
        "最近",
      );
    });

    it("leaves a vertical scroll alone", () => {
      render();
      // A list that scrolls must never change views because a scroll drifted
      // sideways a little.
      swipeOn(container.querySelector(".shell") as Element, [200, 500], [170, 200]);

      expect(container.querySelector('button[role="tab"][aria-selected="true"]')?.textContent).toBe(
        "最近",
      );
    });

    it("leaves text selection alone", () => {
      render();
      const search = container.querySelector(".search") as Element;

      swipeOn(search, [300, 400], [120, 400]);

      expect(container.querySelector('button[role="tab"][aria-selected="true"]')?.textContent).toBe(
        "最近",
      );
    });
  });
});

describe("Home connection bar", () => {
  function connected(overrides: Partial<LinkState> = {}): LinkState {
    return {
      phase: "connected",
      completed: [],
      attempt: 0,
      target: "http://192.168.5.2:56789",
      name: "192.168.5.2:56789",
      mode: "lan",
      ...overrides,
    };
  }

  it("shows the current computer and how the link stands", () => {
    render({ link: connected() });
    const bar = container.querySelector(".linkbar") as HTMLButtonElement;
    expect(bar.textContent).toContain("192.168.5.2:56789");
    expect(bar.textContent).toContain("局域网已连接");
  });

  it("shows reconnect attempts instead of a silent spinner", () => {
    render({
      link: {
        ...connected(),
        phase: "reconnecting",
        attempt: 3,
        error: { code: "client.offline", message: "到不了", retryable: true },
      },
    });
    expect(container.querySelector(".linkbar")?.textContent).toContain("第 3 次");
  });

  it("opens the switch sheet with the recorded computers", () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    rememberConnection("lan", "http://192.168.5.2:56789");
    render({ link: connected() });
    act(() => (container.querySelector(".linkbar") as HTMLButtonElement).click());

    const sheet = container.querySelector(".switch-sheet");
    expect(sheet?.textContent).toContain("切换连接");
    expect(sheet?.textContent).toContain("192.168.9.9:51234");
    expect(sheet?.textContent).toContain("当前");
  });

  it("switches to a row and closes the sheet", () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    const onSwitchConnection = vi.fn();
    render({ link: connected(), onSwitchConnection });
    act(() => (container.querySelector(".linkbar") as HTMLButtonElement).click());

    const row = Array.from(container.querySelectorAll(".switch-row")).find((node) =>
      node.textContent?.includes("192.168.9.9"),
    ) as HTMLButtonElement;
    act(() => row.click());

    expect(onSwitchConnection).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "lan", target: "http://192.168.9.9:51234" }),
    );
    expect(container.querySelector(".switch-sheet")).toBeNull();
  });

  it("offers a retry when the link failed", () => {
    const onRetryLink = vi.fn();
    render({
      link: {
        ...connected(),
        phase: "failed",
        name: "电脑",
        error: { code: "client.offline", message: "到不了这台电脑", retryable: true },
      },
      onRetryLink,
    });
    act(() => (container.querySelector(".linkbar") as HTMLButtonElement).click());

    expect(container.querySelector(".switch-sheet")?.textContent).toContain("到不了这台电脑");
    act(() => button("重试连接").click());
    expect(onRetryLink).toHaveBeenCalledTimes(1);
  });

  it("sends 管理连接 to settings", () => {
    const onSettings = vi.fn();
    render({ onSettings });
    act(() => (container.querySelector(".linkbar") as HTMLButtonElement).click());
    act(() => button("管理连接").click());
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});
