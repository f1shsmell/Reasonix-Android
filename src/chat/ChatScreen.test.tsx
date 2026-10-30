import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatScreen } from "./ChatScreen";
import type { Connection, ConnectionSnapshot } from "../net/connection";
import type { EventPayload } from "../wire/events";
import type { RuntimeView } from "../wire/runtime";
import { saveReading } from "./reading";

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
 * One kernel, several routes. The old mock answered every request with the
 * history body, so `/todos` silently received a transcript as its checklist.
 */
function stubKernel(
  options: {
    history?: unknown;
    historyStatus?: number;
    todos?: unknown;
    todosStatus?: number;
    status?: unknown;
    statusStatus?: number;
  } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/todos")) {
      return Promise.resolve(json(options.todos ?? [], options.todosStatus));
    }
    if (url.endsWith("/status")) {
      return Promise.resolve(
        json(options.status ?? { running: false, busy: false, decisions: [] }, options.statusStatus),
      );
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
    // The checklist is a strip between the record and the composer: it stays
    // in reach while the conversation scrolls, without taking its top.
    expect(
      panel !== null &&
        transcript !== null &&
        (transcript.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
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

  it("does not wipe text typed while the send is in flight", async () => {
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
    typeDraft("first");

    act(() => sendButton().click());
    await act(async () => {
      await Promise.resolve();
    });

    // The person keeps typing while the request is in flight.
    typeDraft("second");
    act(() => release(json({})));
    await flush();
    await flush();

    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("second");
    expect(localStorage.getItem("reasonix.draft.r1")).toBe("second");
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

  it("offers a fresh conversation in the same project from the chat header", async () => {
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

    const plus = container.querySelector('button[aria-label="在当前项目新建会话"]');
    act(() => (plus as HTMLButtonElement).click());

    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it("opens the model picker from the header chip and shows the switched model", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/rt/r1/models")) {
        return Promise.resolve(
          json({
            current: "deepseek/deepseek-flash",
            label: "Flash",
            default: "deepseek/deepseek-pro",
            models: [
              { ref: "deepseek/deepseek-flash", provider: "deepseek", model: "deepseek-flash", active: true },
              { ref: "deepseek/deepseek-pro", provider: "deepseek", model: "deepseek-pro", default: true },
            ],
          }),
        );
      }
      if (url.endsWith("/rt/r1/model") && init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/todos")) return Promise.resolve(json([]));
      return Promise.resolve(json([]));
    });
    vi.stubGlobal("fetch", fetchMock);

    root = createRoot(container);
    act(() =>
      root?.render(
        <ChatScreen connection={connection} snapshot={snapshot()} runtimeId="r1" onBack={() => {}} />,
      ),
    );
    await flush();

    const chip = container.querySelector('button[aria-label="切换模型"]');
    expect(chip).toBeTruthy();
    act(() => (chip as HTMLButtonElement).click());
    await flush();

    const sheet = container.querySelector('[aria-label="选择模型"]');
    expect(sheet).toBeTruthy();

    const row = Array.from(sheet?.querySelectorAll(".model-row") ?? []).find((candidate) =>
      candidate.textContent?.includes("deepseek-pro"),
    );
    await act(async () => {
      (row as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await flush();

    // The sheet closes and the header now names the model that answered.
    expect(container.querySelector('[aria-label="选择模型"]')).toBeNull();
    expect(container.querySelector('button[aria-label="切换模型"]')?.textContent).toBe("deepseek-pro");
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

    act(() =>
      (
        container.querySelector('button[aria-label="移除图片 photo.png"]') as HTMLButtonElement
      ).click(),
    );

    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(container.querySelector(".attachment")).toBeNull();
    expect(preview).toHaveBeenCalled();
  });

  it("accepts several images at once and keeps the ones that uploaded", async () => {
    let call = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/rt/r1/attachments")) {
        call += 1;
        // The second upload is refused: one bad file must not sink the rest.
        if (call === 2) {
          return Promise.resolve(json({ code: "attachment.too_large" }, 413));
        }
        return Promise.resolve(
          json({
            path: `.reasonix/attachments/p${call}.png`,
            ref: `@.reasonix/attachments/p${call}.png`,
            image: true,
          }),
        );
      }
      return Promise.resolve(json([]));
    });
    vi.stubGlobal("fetch", fetchMock);
    let blob = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${++blob}`);

    render(snapshot());
    await flush();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.multiple).toBe(true);

    const files = [
      new File(["a"], "one.png", { type: "image/png" }),
      new File(["b"], "two.png", { type: "image/png" }),
      new File(["c"], "three.png", { type: "image/png" }),
    ];
    Object.defineProperty(input, "files", { value: files, configurable: true });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    await flush();
    await flush();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("@.reasonix/attachments/p1.png");
    expect(textarea.value).toContain("@.reasonix/attachments/p3.png");
    expect(textarea.value).not.toContain("p2.png");
    expect(container.querySelectorAll(".attachment")).toHaveLength(2);
    expect(container.textContent).toContain("two.png");
    expect(container.textContent).toContain("图片太大");
  });

  it("appends a second pick instead of replacing the first", async () => {
    let call = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/rt/r1/attachments")) {
        call += 1;
        return Promise.resolve(
          json({ path: `p${call}.png`, ref: `@p${call}.png`, image: true }),
        );
      }
      return Promise.resolve(json([]));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:one");

    render(snapshot());
    await flush();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    Object.defineProperty(input, "files", {
      value: [new File(["a"], "one.png", { type: "image/png" })],
      configurable: true,
    });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    await flush();

    // The attach control stays usable with an image already waiting.
    const attach = container.querySelector('button[aria-label="添加图片或计划"]') as HTMLButtonElement;
    expect(attach.disabled).toBe(false);

    Object.defineProperty(input, "files", {
      value: [new File(["b"], "two.png", { type: "image/png" })],
      configurable: true,
    });
    act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    await flush();

    expect(container.querySelectorAll(".attachment")).toHaveLength(2);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.value).toContain("@p1.png");
    expect(textarea.value).toContain("@p2.png");
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

describe("ChatScreen interject", () => {
  /** A kernel that accepts one inbox item and reports the given disposition. */
  function inboxKernel(disposition: string, extra: Record<string, unknown> = {}) {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/inbox/items")) {
        return Promise.resolve(
          json({ itemId: "i1", disposition, position: 1, paused: false, ...extra }),
        );
      }
      return Promise.resolve(json([]));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function inboxCalls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(([value]) => String(value).endsWith("/inbox/items"));
  }

  /** Put the screen into a running turn with text in the composer. */
  async function runningWithDraft(text: string): Promise<void> {
    render(snapshot({ kind: "turn_started" }));
    await flush();
    typeDraft(text);
  }

  it("offers both ways only while a turn is running", async () => {
    stubKernel();
    render(snapshot());
    await flush();
    typeDraft("等一下");

    // Idle: the send button is the way out, and there is nothing to steer.
    expect(container.querySelector('[aria-label="发送到运行中的回合"]')).toBeNull();

    render(snapshot({ kind: "turn_started" }));
    await flush();

    const group = container.querySelector('[aria-label="发送到运行中的回合"]');
    expect(group).toBeTruthy();
    expect(group?.textContent).toContain("排队");
    expect(group?.textContent).toContain("插话");
  });

  it("queues a message without touching the running turn", async () => {
    const fetchMock = inboxKernel("queued_followup");
    await runningWithDraft("查完日志再说");

    await act(async () => {
      (Array.from(container.querySelectorAll(".interject button")).find(
        (b) => b.textContent === "排队",
      ) as HTMLButtonElement).click();
    });
    await flush();

    const calls = inboxCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      input: "查完日志再说",
      intent: "followup",
    });
    // The receipt says what actually happened, including its place in line.
    expect(container.textContent).toContain("已排队");
    // A queued message is held by the kernel, so the composer is free again.
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  });

  it("steers into the running turn and says so", async () => {
    const fetchMock = inboxKernel("steer_accepted");
    await runningWithDraft("停，先看这个");

    await act(async () => {
      (Array.from(container.querySelectorAll(".interject button")).find(
        (b) => b.textContent === "插话",
      ) as HTMLButtonElement).click();
    });
    await flush();

    const calls = inboxCalls(fetchMock);
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      input: "停，先看这个",
      intent: "steer",
    });
    expect(container.textContent).toContain("这一轮会看到");
  });

  it("reports a steer the kernel queued instead, rather than claiming it landed", async () => {
    // The kernel may decide a steer cannot join the turn; the receipt is the
    // only place that shows, and saying "已插话" would be a lie.
    inboxKernel("queued_followup");
    await runningWithDraft("改一下");

    await act(async () => {
      (Array.from(container.querySelectorAll(".interject button")).find(
        (b) => b.textContent === "插话",
      ) as HTMLButtonElement).click();
    });
    await flush();

    expect(container.textContent).toContain("已排队");
    expect(container.textContent).not.toContain("这一轮会看到");
  });

  it("keeps the draft when the kernel refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/inbox/items")) {
          return Promise.resolve(json({ code: "inbox.capacity_items" }, 409));
        }
        return Promise.resolve(json([]));
      }),
    );
    await runningWithDraft("这条会被拒");

    await act(async () => {
      (Array.from(container.querySelectorAll(".interject button")).find(
        (b) => b.textContent === "排队",
      ) as HTMLButtonElement).click();
    });
    await flush();

    expect(container.textContent).toContain("队列满了");
    expect((container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("这条会被拒");
  });

  it("does not offer to interject into a read-only pane", async () => {
    stubKernel();
    render(
      snapshot({ kind: "turn_started" }, [
        { id: "r1", base: "/rt/r1", root: "/w", name: "w", readOnly: true },
      ]),
    );
    await flush();
    typeDraft("只读也不能发");

    expect(container.querySelector('[aria-label="发送到运行中的回合"]')).toBeNull();
  });
});

describe("ChatScreen structured asks", () => {
  it("draws a surface question as a form and answers with Value, not Selected", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/answer") && init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.endsWith("/todos")) return Promise.resolve(json([]));
      return Promise.resolve(json([]));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      snapshot({
        kind: "ask_request",
        ask: {
          id: "ask-9",
          questions: [
            {
              id: "q1",
              header: "配置",
              prompt: "选一下",
              options: [],
              surface: {
                spec_version: 1,
                body: [
                  {
                    kind: "choice_card",
                    key: "mode",
                    label: "模式",
                    field: {
                      type: "choice",
                      required: true,
                      options: [
                        { value: "fast", label: "快速" },
                        { value: "full", label: "完整" },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    await flush();

    // The option path would have said "这个问题没有可选项"; a form is drawn.
    expect(container.textContent).not.toContain("没有可选项");
    expect(container.querySelector(".surface")).toBeTruthy();

    const pick = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("完整"),
    ) as HTMLButtonElement;
    act(() => pick.click());

    const confirm = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "确认",
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    const call = fetchMock.mock.calls.find(([value]) => String(value).endsWith("/answer"));
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call?.[1]?.body)) as {
      id: string;
      answers: { QuestionID: string; Selected: string[]; Value?: Record<string, unknown> }[];
    };
    expect(body.id).toBe("ask-9");
    // The kernel's surface validation refuses a label here: the answer is the
    // field values, with `Selected` empty.
    expect(body.answers).toEqual([{ QuestionID: "q1", Selected: [], Value: { mode: "full" } }]);
  });

  it("falls back to options for a question without a surface", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/answer") && init?.method === "POST") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(json([]));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      snapshot({
        kind: "ask_request",
        ask: {
          id: "ask-8",
          questions: [
            { id: "q1", prompt: "要茶吗", options: [{ label: "要" }, { label: "不要" }] },
          ],
        },
      }),
    );
    await flush();

    expect(container.querySelector(".surface")).toBeNull();
    const pick = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("要"),
    ) as HTMLButtonElement;
    act(() => pick.click());
    const confirm = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "确认",
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    const call = fetchMock.mock.calls.find(([value]) => String(value).endsWith("/answer"));
    const body = JSON.parse(String(call?.[1]?.body)) as {
      answers: { QuestionID: string; Selected: string[] }[];
    };
    expect(body.answers).toEqual([{ QuestionID: "q1", Selected: ["要"] }]);
  });
});

describe("ChatScreen stop", () => {
  it("offers a labelled stop for a turn that was already running when it opened", async () => {
    const fetchMock = stubKernel({ status: { running: true, busy: true, decisions: [] } });

    render(snapshot());
    await flush();
    await flush();

    const stop = container.querySelector('[aria-label="停止"]') as HTMLButtonElement;
    expect(stop).toBeTruthy();
    expect(stop.textContent).toContain("停止");

    await act(async () => {
      stop.click();
      await Promise.resolve();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the send button when the kernel reports no turn", async () => {
    stubKernel({ status: { running: false, busy: false, decisions: [] } });

    render(snapshot());
    await flush();
    await flush();

    expect(container.querySelector('[aria-label="发送"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="停止"]')).toBeNull();
  });
});

describe("ChatScreen activity", () => {
  it("draws live steps, then collapses the finished run", async () => {
    stubKernel();
    render(snapshot({ kind: "turn_started" }));
    await flush();
    render(
      snapshot({
        kind: "tool_dispatch",
        tool: { id: "c1", name: "bash", args: '{"command":"ls"}' },
      }),
    );
    await flush();
    render(
      snapshot({
        kind: "tool_dispatch",
        tool: { id: "c2", name: "read_file", args: '{"path":"a"}' },
      }),
    );
    await flush();

    // Still in flight: the steps are individually readable.
    expect(container.querySelectorAll(".activity-row")).toHaveLength(2);

    render(snapshot({ kind: "turn_done" }));
    await flush();

    const summary = container.querySelector(".process-row");
    expect(summary?.textContent).toContain("执行命令");
    expect(summary?.textContent).toContain("读取");
    expect(summary?.textContent).toContain("2 个操作");
    expect(container.querySelectorAll(".activity-row")).toHaveLength(0);

    act(() => (summary as HTMLButtonElement).click());
    const sheet = container.querySelector(".process-sheet");
    expect(sheet?.textContent).toContain("执行命令");
    expect(sheet?.textContent).toContain("读取文件");
  });

  it("summarises a running step in compact mode and hides thinking", async () => {
    localStorage.setItem("reasonix.folding.v1", "compact");
    stubKernel();
    render(snapshot({ kind: "turn_started" }));
    await flush();
    render(snapshot({ kind: "reasoning", reasoning: "先看目录" }));
    await flush();

    expect(container.querySelector(".activity-row")).toBeNull();

    render(
      snapshot({
        kind: "tool_dispatch",
        tool: { id: "c1", name: "bash", args: '{"command":"ls"}' },
      }),
    );
    await flush();

    expect(container.querySelector(".activity-row")).toBeNull();
    const summary = container.querySelector(".process-row");
    expect(summary?.textContent).toContain("1 个操作");
    expect(container.querySelector(".activity-icon.running")).not.toBeNull();
  });

  it("keeps each step in full mode after the turn ends", async () => {
    localStorage.setItem("reasonix.folding.v1", "full");
    stubKernel();
    render(snapshot({ kind: "turn_started" }));
    await flush();
    render(
      snapshot({ kind: "tool_dispatch", tool: { id: "c1", name: "bash", args: '{"command":"ls"}' } }),
    );
    await flush();
    render(
      snapshot({ kind: "tool_dispatch", tool: { id: "c2", name: "read_file", args: '{"path":"a"}' } }),
    );
    await flush();
    render(snapshot({ kind: "turn_done" }));
    await flush();

    expect(container.querySelectorAll(".activity-row")).toHaveLength(2);
    expect(container.querySelector(".process-row")).toBeNull();
  });

  it("lifts a thought into its own row", async () => {
    stubKernel();
    render(snapshot({ kind: "turn_started" }));
    await flush();
    render(snapshot({ kind: "reasoning", reasoning: "先看目录" }));
    await flush();

    const row = container.querySelector(".activity-row");
    expect(row?.textContent).toContain("深度思考");

    act(() => (row as HTMLButtonElement).click());
    expect(container.querySelector(".reasoning-text")?.textContent).toBe("先看目录");
  });
});

describe("ChatScreen composer extras", () => {
  it("shows the model /status names when the history carries none", async () => {
    stubKernel({
      status: {
        running: false,
        busy: false,
        decisions: [],
        modelRef: "deepseek/deepseek-flash",
      },
    });
    render(snapshot());
    await flush();

    expect(container.querySelector('button[aria-label="切换模型"]')?.textContent).toBe(
      "deepseek-flash",
    );
  });

  it("opens a plus sheet with camera, image and plan", async () => {
    const fetchMock = stubKernel();
    render(snapshot());
    await flush();

    act(() =>
      (
        container.querySelector('button[aria-label="添加图片或计划"]') as HTMLButtonElement
      ).click(),
    );
    const sheet = container.querySelector(".attach-sheet");
    expect(sheet?.textContent).toContain("相机");
    expect(sheet?.textContent).toContain("图片");
    expect(sheet?.textContent).toContain("计划");

    const plan = Array.from(sheet?.querySelectorAll("button") ?? []).find((candidate) =>
      candidate.textContent?.includes("计划"),
    ) as HTMLButtonElement;
    await act(async () => {
      plan.click();
      await Promise.resolve();
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/plan",
      expect.objectContaining({ body: JSON.stringify({ on: true }) }),
    );
  });

  it("keeps reload and model behind the header's more button", async () => {
    stubKernel();
    render(snapshot());
    await flush();

    act(() => (container.querySelector('button[aria-label="更多"]') as HTMLButtonElement).click());
    const sheet = container.querySelector(".head-menu");
    expect(sheet?.textContent).toContain("重新加载历史");
    expect(sheet?.textContent).toContain("选择模型");
  });
});


describe("ChatScreen reading position", () => {
  function stubScroll(): { top: () => number; restore: () => void } {
    let value = 0;
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const saved = {
      scrollTop: Object.getOwnPropertyDescriptor(proto, "scrollTop"),
      scrollHeight: Object.getOwnPropertyDescriptor(proto, "scrollHeight"),
      clientHeight: Object.getOwnPropertyDescriptor(proto, "clientHeight"),
    };
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 400 });
    Object.defineProperty(proto, "scrollTop", {
      configurable: true,
      get: () => value,
      set: (next: number) => {
        value = next;
      },
    });
    return {
      top: () => value,
      restore: () => {
        for (const [name, descriptor] of Object.entries(saved)) {
          if (descriptor) Object.defineProperty(proto, name, descriptor);
          else delete proto[name];
        }
      },
    };
  }

  it("returns to the place a conversation was left", async () => {
    const scroll = stubScroll();
    try {
      saveReading("r1", { top: 240, atBottom: false });
      stubKernel({
        history: [
          { role: "user", content: "old question", msgIndex: 1 },
          { role: "assistant", content: "old answer", msgIndex: 2 },
        ],
      });

      render(snapshot());
      await flush();
      await flush();

      expect(scroll.top()).toBe(240);
    } finally {
      scroll.restore();
    }
  });

  it("follows the newest row when the last visit was at the bottom", async () => {
    const scroll = stubScroll();
    try {
      saveReading("r1", { top: 0, atBottom: true });
      stubKernel({
        history: [
          { role: "user", content: "old question", msgIndex: 1 },
          { role: "assistant", content: "old answer", msgIndex: 2 },
        ],
      });

      render(snapshot());
      await flush();
      await flush();

      expect(scroll.top()).toBe(1000);
    } finally {
      scroll.restore();
    }
  });
});
