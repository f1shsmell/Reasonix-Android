import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatScreen } from "./ChatScreen";
import type { Connection, ConnectionSnapshot } from "../net/connection";
import type { EventPayload } from "../wire/events";
import type { RuntimeView } from "../wire/runtime";

/**
 * The screen's own job — putting the stored conversation under the live stream
 * — is the part a fold test cannot reach. A session that has been running for
 * days opens empty without it, which is exactly what it did.
 *
 * The task list has its own read for the same reason: it is the kernel's
 * canonical list, not something the transcript can be folded into. These tests
 * keep the two routes apart so one cannot stand in for the other.
 */

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const runtime: RuntimeView = { id: "r1", base: "/rt/r1", root: "/w", name: "w" };
const other: RuntimeView = { id: "r2", base: "/rt/r2", root: "/w2", name: "w2" };

function snapshot(lastEvent?: EventPayload, runtimes: RuntimeView[] = [runtime]): ConnectionSnapshot {
  return {
    reach: { kind: "ok" },
    runtimes,
    stream: { kind: "open" },
    ...(lastEvent ? { lastEvent } : {}),
  };
}

/** Only attach/detach are reached; the real stream needs an EventSource jsdom lacks. */
const connection = {
  attach: () => {},
  detach: () => {},
} as unknown as Connection;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * One kernel, two routes. The old mock answered every request with the
 * history body, so `/todos` silently received a transcript as its checklist.
 */
function stubKernel(
  options: {
    history?: unknown;
    historyStatus?: number;
    todos?: unknown;
    todosStatus?: number;
  } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/todos")) {
      return Promise.resolve(json(options.todos ?? [], options.todosStatus));
    }
    return Promise.resolve(json(options.history ?? [], options.historyStatus));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function todoCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/todos")).length;
}

async function flush(): Promise<void> {
  // Both reads resolve through `json()`, so give the microtask queue more than
  // one turn before asserting that the screen settled.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Render, or re-render the same mounted screen.
 *
 * Reusing the root matters: a new root is a new component with new state, so
 * it could never show that a later event landed below an earlier history read.
 */
function render(snap: ConnectionSnapshot, runtimeId = "r1"): void {
  const element = (
    <ChatScreen
      connection={connection}
      snapshot={snap}
      runtimeId={runtimeId}
      onBack={() => {}}
    />
  );
  if (!root) {
    root = createRoot(container);
    act(() => root?.render(element));
    return;
  }
  act(() => root?.render(element));
}

describe("ChatScreen history", () => {
  it("draws the stored conversation before the live one", async () => {
    stubKernel({
      history: [
        { role: "user", content: "老问题", msgIndex: 1 },
        { role: "assistant", content: "老回答", msgIndex: 2 },
      ],
    });

    render(snapshot());
    await flush();

    // A frame that arrived while the read was in flight must land below the
    // history, not above it: it happened after.
    render(snapshot({ kind: "text", text: "新回答" }));
    await flush();

    const text = container.textContent ?? "";
    expect(text.indexOf("老问题")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("老问题")).toBeLessThan(text.indexOf("老回答"));
    expect(text.indexOf("老回答")).toBeLessThan(text.indexOf("新回答"));
  });

  it("says the history could not be read without failing the screen", async () => {
    stubKernel({ historyStatus: 500 });

    render(snapshot());
    await flush();

    expect(container.textContent).toContain("没读到历史");
  });

  it("says it is still reading rather than claiming there is nothing", async () => {
    // "还没有消息" on a session with history is a lie the person acts on.
    let resolve: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).endsWith("/todos")) return Promise.resolve(json([]));
        return new Promise<Response>((done) => (resolve = done));
      }),
    );

    render(snapshot());
    await flush();

    expect(container.textContent).toContain("正在读这个会话");

    await act(async () => {
      resolve(json([]));
      await Promise.resolve();
    });
  });

  it("shows no messages only once an empty history really is empty", async () => {
    stubKernel({ history: [] });

    render(snapshot());
    await flush();

    expect(container.textContent).toContain("还没有消息");
  });
});

describe("ChatScreen todos", () => {
  it("draws the kernel's list above the conversation", async () => {
    stubKernel({
      history: [{ role: "user", content: "老问题", msgIndex: 1 }],
      todos: [
        { content: "读契约", status: "completed" },
        { content: "写测试", status: "in_progress", activeForm: "正在写测试" },
      ],
    });

    render(snapshot());
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("1/2");
    expect(text).toContain("正在写测试");

    const panel = container.querySelector(".todos");
    const transcript = container.querySelector(".transcript");
    expect(panel).not.toBeNull();
    expect(transcript).not.toBeNull();
    // The checklist describes the work behind the conversation, so it reads
    // before it in document order as well.
    expect(
      panel !== null &&
        transcript !== null &&
        (panel.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  it("re-reads the list when a todo_progress clock moves", async () => {
    let list = [{ content: "第一步", status: "in_progress" }];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/todos")) return Promise.resolve(json(list));
        return Promise.resolve(json([]));
      }),
    );

    render(snapshot());
    await flush();
    expect(container.textContent).toContain("0/1");

    list = [{ content: "第一步", status: "completed" }];
    render(
      snapshot({
        kind: "todo_progress",
        todoProgress: { kind: "advance", progressRevision: 1 },
      }),
    );
    await flush();

    expect(container.textContent).toContain("1/1");
    expect(container.textContent).toContain("全部完成");
  });

  it("does not re-read on a frame whose clocks did not move", async () => {
    const fetchMock = stubKernel({
      todos: [{ content: "第一步", status: "in_progress" }],
    });

    render(snapshot());
    await flush();
    const before = todoCalls(fetchMock);

    const frame: EventPayload = {
      kind: "todo_progress",
      todoProgress: { kind: "advance", progressRevision: 1 },
    };
    render(snapshot(frame));
    await flush();
    const afterFirst = todoCalls(fetchMock);
    expect(afterFirst).toBe(before + 1);

    // Same three clocks: the kernel would answer exactly what is on screen.
    render(
      snapshot({
        kind: "todo_progress",
        todoProgress: { kind: "advance", progressRevision: 1 },
      }),
    );
    await flush();
    expect(todoCalls(fetchMock)).toBe(afterFirst);
  });

  it("keeps the conversation when the list cannot be read", async () => {
    stubKernel({
      history: [{ role: "user", content: "还在", msgIndex: 1 }],
      todosStatus: 500,
    });

    render(snapshot());
    await flush();

    expect(container.textContent).toContain("还在");
    expect(container.querySelector(".todos")).toBeNull();
  });

  it("keeps the last list and marks it stale when a refresh fails", async () => {
    let fail = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith("/todos")) return Promise.resolve(json([]));
        if (fail) return Promise.resolve(new Response(null, { status: 500 }));
        return Promise.resolve(json([{ content: "旧任务", status: "in_progress" }]));
      }),
    );

    render(snapshot());
    await flush();
    expect(container.textContent).toContain("旧任务");
    expect(container.textContent).not.toContain("任务列表暂时没更新");

    fail = true;
    render(
      snapshot({
        kind: "todo_progress",
        todoProgress: { kind: "advance", progressRevision: 1 },
      }),
    );
    await flush();

    // The old list is still the best account of the work; hiding it would
    // make a transient read failure look like the agent abandoned its plan.
    expect(container.textContent).toContain("旧任务");
    expect(container.textContent).toContain("任务列表暂时没更新");
  });

  it("keeps the newer answer when two reads overlap on the same pane", async () => {
    let releaseFirst: (value: Response) => void = () => {};
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith("/todos")) return Promise.resolve(json([]));
        calls += 1;
        if (calls === 1) return new Promise<Response>((done) => (releaseFirst = done));
        return Promise.resolve(json([{ content: "新任务", status: "in_progress" }]));
      }),
    );

    render(snapshot());
    await flush();
    // The first read is still in flight; a frame starts a second one.
    render(
      snapshot({
        kind: "todo_progress",
        todoProgress: { kind: "advance", progressRevision: 1 },
      }),
    );
    await flush();
    expect(container.textContent).toContain("新任务");

    await act(async () => {
      releaseFirst(json([{ content: "旧任务", status: "in_progress" }]));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("新任务");
    expect(container.textContent).not.toContain("旧任务");
  });

  it("retries a failed refresh on the next frame with the same clocks", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.endsWith("/todos")) return Promise.resolve(json([]));
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(json([{ content: "初始任务", status: "in_progress" }]));
        }
        if (calls === 2) return Promise.resolve(new Response(null, { status: 500 }));
        return Promise.resolve(json([{ content: "重试成功", status: "in_progress" }]));
      }),
    );

    render(snapshot());
    await flush();
    expect(container.textContent).toContain("初始任务");

    const frame = (): EventPayload => ({
      kind: "todo_progress",
      todoProgress: { kind: "advance", progressRevision: 1 },
    });
    render(snapshot(frame()));
    await flush();
    expect(container.textContent).toContain("初始任务");

    // Same clocks on a new frame: the revision guard would normally skip it,
    // but the previous read failed, so it is worth asking again.
    render(snapshot(frame()));
    await flush();
    expect(container.textContent).toContain("重试成功");
  });

  it("does not let the previous pane's list land on the new one", async () => {
    let releaseOld: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/rt/r1/todos") {
          return new Promise<Response>((done) => (releaseOld = done));
        }
        if (url === "/rt/r2/todos") {
          return Promise.resolve(json([{ content: "新会话的任务", status: "in_progress" }]));
        }
        return Promise.resolve(json([]));
      }),
    );

    render(snapshot(undefined, [runtime, other]));
    render(snapshot(undefined, [runtime, other]), "r2");
    await flush();

    expect(container.textContent).toContain("新会话的任务");

    // The old read was still in flight when the screen moved on. Its answer
    // belongs to the pane that is no longer open.
    await act(async () => {
      releaseOld(json([{ content: "旧会话的任务", status: "in_progress" }]));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("旧会话的任务");
    expect(container.textContent).toContain("新会话的任务");
  });
});

function typeDraft(text: string): void {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("no composer");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendButton(): HTMLButtonElement {
  const button = container.querySelector('button[aria-label="发送"]');
  if (!button) throw new Error("no send button");
  return button as HTMLButtonElement;
}

describe("ChatScreen composer", () => {
  it("shows the empty state when neither history nor live rows exist", async () => {
    stubKernel();
    render(snapshot());
    await flush();
    expect(container.textContent).toContain("还没有消息");
  });

  it("restores a draft left in this pane before an interruption", async () => {
    localStorage.setItem("reasonix.draft.r1", "没发出去的想法");
    stubKernel();

    render(snapshot());
    await flush();

    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "没发出去的想法",
    );
  });

  it("shows a retryable refusal and keeps the text in the composer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/todos")) return Promise.resolve(json([]));
        if (url.endsWith("/submit")) {
          return Promise.resolve(json({ code: "http.500", error: "busy" }, 500));
        }
        return Promise.resolve(json([]));
      }),
    );

    render(snapshot());
    await flush();
    typeDraft("hello");

    act(() => sendButton().click());
    await flush();
    await flush();

    expect(container.querySelector(".sendfail")?.textContent).toContain("没发出去：http.500");
    expect(container.querySelector(".sendfail button")?.textContent).toBe("重试");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("hello");
    expect(container.querySelector(".row.user")).toBeNull();
  });

  it("draws the sent message before the stream confirms it", async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/submit")) return pending;
        if (url.endsWith("/todos")) return Promise.resolve(json([]));
        return Promise.resolve(json([]));
      }),
    );

    render(snapshot());
    await flush();
    typeDraft("hello");

    act(() => sendButton().click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector(".row.user")?.textContent).toContain("hello");

    act(() => release(json({})));
    await flush();
    await flush();

    expect(container.querySelectorAll(".row.user")).toHaveLength(1);
  });

  it("does not yank the transcript down while the person reads back", async () => {
    stubKernel();
    render(snapshot());
    await flush();

    const list = container.querySelector(".transcript") as HTMLDivElement;
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(list, "scrollTop", { value: 100, configurable: true, writable: true });
    const scrollTo = vi.fn();
    list.scrollTo = scrollTo;
    act(() => list.dispatchEvent(new Event("scroll")));
    scrollTo.mockClear();

    render(snapshot({ kind: "text", text: "新内容" }));
    await flush();

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("offers the session/project sheet from the chat header", async () => {
    stubKernel();
    const onNewSession = vi.fn();
    root = createRoot(container);
    act(() =>
      root?.render(
        <ChatScreen
          connection={connection}
          snapshot={snapshot()}
          runtimeId="r1"
          onBack={() => {}}
          onNewSession={onNewSession}
        />,
      ),
    );
    await flush();

    const plus = container.querySelector('button[aria-label="新建会话或切换项目"]');
    act(() => (plus as HTMLButtonElement).click());

    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it("uploads an image, inserts the kernel reference, and can remove it", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/rt/r1/attachments")) {
        return Promise.resolve(
          json({
            path: ".reasonix/attachments/photo.png",
            ref: "@.reasonix/attachments/photo.png",
            image: true,
          }),
        );
      }
      return Promise.resolve(json([]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const preview = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:photo");

    render(snapshot());
    await flush();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["image"], "photo.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("@.reasonix/attachments/photo.png");
    expect(container.querySelector(".attachment img")?.getAttribute("src")).toBe("blob:photo");
    expect(container.querySelector(".attachment")?.textContent).toContain("photo.png");
    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/attachments",
      expect.objectContaining({ method: "POST" }),
    );

    act(() => (container.querySelector('button[aria-label="移除图片"]') as HTMLButtonElement).click());

    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(container.querySelector(".attachment")).toBeNull();
    expect(preview).toHaveBeenCalled();
  });

  it("sends the uploaded reference as the turn input", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/rt/r1/attachments")) {
        return Promise.resolve(json({ path: "p.png", ref: "@p.png", image: true }));
      }
      if (url.endsWith("/submit")) return Promise.resolve(json({}));
      return Promise.resolve(json([]));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:photo");

    render(snapshot());
    await flush();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["image"], "photo.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    await flush();

    act(() => sendButton().click());
    await flush();
    await flush();

    const submitCall = fetchMock.mock.calls.find(([value]) => String(value).endsWith("/submit"));
    expect(submitCall).toBeTruthy();
    expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({ input: "@p.png" });
  });
});
