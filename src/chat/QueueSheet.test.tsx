import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueSheet, blockText, stateLabel, whenText } from "./QueueSheet";

let container: HTMLDivElement;
let root: Root | null = null;
let onClose = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(<QueueSheet base="/rt/r1" onClose={onClose} />);
  });
  await flush();
}

/** The list read, and a body read for whichever id the detail asks for. */
function queueKernel(items: unknown[], detail?: unknown, detailStatus = 200) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/inbox\/items\/[^/]+$/.test(url)) {
      return Promise.resolve(json(detail ?? { code: "inbox.not_found" }, detailStatus));
    }
    if (url.endsWith("/inbox")) {
      return Promise.resolve(json({ revision: 1, paused: false, items }));
    }
    return Promise.resolve(json({ code: "unexpected" }, 500));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  onClose = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

describe("QueueSheet", () => {
  it("lists the queue in order with the kernel's own preview", async () => {
    vi.stubGlobal(
      "fetch",
      queueKernel([
        { id: "a", intent: "followup", state: "queued", preview: "先看日志" },
        { id: "b", intent: "steer", state: "blocked", preview: "停下", blockCode: "steer_unapplied" },
      ]),
    );

    await render();

    const rows = [...container.querySelectorAll(".queue-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("先看日志");
    expect(rows[0]?.textContent).toContain("1");
    expect(rows[0]?.textContent).toContain("排队");
    expect(rows[1]?.textContent).toContain("停下");
    // A steer says so: it is a different promise from a queued follow-up.
    expect(rows[1]?.textContent).toContain("插话");
    expect(rows[1]?.textContent).toContain("受阻");
  });

  it("opens the full body only when the row is tapped", async () => {
    const fetchMock = queueKernel(
      [{ id: "a", intent: "followup", state: "queued", preview: "看日志" }],
      {
        meta: { id: "a", intent: "followup", state: "queued", preview: "看日志" },
        envelope: {
          displayText: "看日志\n第二行",
          submitText: "看日志\n第二行",
          refs: [{ kind: "clean_git", path: "src/a.ts", displayPath: "src/a.ts" }],
        },
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await render();
    // The list alone does not fetch a body.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/inbox/items/"))).toHaveLength(0);

    const row = container.querySelector(".queue-row");
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/inbox/items/a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const body = container.querySelector(".queue-body");
    // The line break the person typed survives: this is a message, not a label.
    expect(body?.textContent).toBe("看日志\n第二行");
    expect(container.textContent).toContain("src/a.ts");
    // One spelling of the text means one body, not the same text twice.
    expect(container.querySelector(".queue-actual")).toBeNull();
  });

  it("says why an entry is blocked, in words rather than a state name", async () => {
    vi.stubGlobal(
      "fetch",
      queueKernel(
        [
          {
            id: "a",
            intent: "steer",
            state: "blocked",
            preview: "停下",
            blockCode: "steer_unapplied",
          },
        ],
        {
          meta: { id: "a", intent: "steer", state: "blocked", preview: "停下" },
          envelope: { displayText: "停下", submitText: "停下" },
        },
      ),
    );

    await render();
    await act(async () => {
      container.querySelector(".queue-row")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const block = container.querySelector(".queue-block");
    expect(block?.textContent).toContain("可以插话的位置");
    expect(block?.textContent).not.toContain("steer_unapplied");
  });

  it("shows the text that will actually be sent when it differs", async () => {
    vi.stubGlobal(
      "fetch",
      queueKernel(
        [{ id: "a", intent: "followup", state: "queued", preview: "看日志 /review" }],
        {
          meta: { id: "a", intent: "followup", state: "queued", preview: "看日志 /review" },
          envelope: { displayText: "看日志 /review", submitText: "看日志" },
        },
      ),
    );

    await render();
    await act(async () => {
      container.querySelector(".queue-row")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const actual = container.querySelector(".queue-actual");
    expect(actual?.textContent).toContain("实际发给模型的文本");
    expect(actual?.textContent).toContain("看日志");
  });

  it("draws the kernel's refusal instead of an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      queueKernel(
        [{ id: "a", intent: "followup", state: "queued", preview: "看日志" }],
        { code: "inbox.not_found" },
        409,
      ),
    );

    await render();
    await act(async () => {
      container.querySelector(".queue-row")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.querySelector(".queue-detail")?.textContent).toContain("inbox.not_found");
    expect(container.querySelector(".queue-body")).toBeNull();
  });

  it("tells an empty queue from an unreadable one", async () => {
    vi.stubGlobal("fetch", queueKernel([]));
    await render();
    expect(container.textContent).toContain("队列是空的");
    act(() => root?.unmount());
    root = null;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ revision: 1, paused: false, unrecovered: true, items: [] })),
    );
    await render();
    // An unreadable queue is not an empty one: it says so, and does not claim
    // there is nothing waiting.
    expect(container.textContent).toContain("读不出来");
    expect(container.textContent).not.toContain("队列是空的");
  });

  it("says a paused queue will not advance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          revision: 1,
          paused: true,
          items: [{ id: "a", intent: "followup", state: "queued", preview: "看日志" }],
        }),
      ),
    );
    await render();
    expect(container.textContent).toContain("队列已暂停");
  });
});

describe("QueueSheet wording", () => {
  it("names every lifecycle state the kernel writes", () => {
    expect(stateLabel("queued")).toBe("等待");
    expect(stateLabel("running")).toBe("运行中");
    expect(stateLabel("blocked")).toBe("受阻");
    // An unknown state is shown rather than hidden, so a newer kernel is visible.
    expect(stateLabel("future_state")).toBe("future_state");
    expect(stateLabel("")).toBe("未知");
  });

  it("prefers its own words for a block, then the kernel's", () => {
    expect(blockText("steer_unapplied", "ignored")).toContain("可以插话的位置");
    expect(blockText(undefined, "the kernel's own sentence")).toBe("the kernel's own sentence");
    expect(blockText(undefined, undefined)).toBe("");
  });

  it("reads a timestamp as an age, and nothing when there is none", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(whenText("2026-10-31T11:59:30Z", now)).toBe("刚刚");
    expect(whenText("2026-10-31T11:45:00Z", now)).toBe("15 分钟前");
    expect(whenText("2026-10-31T09:00:00Z", now)).toBe("3 小时前");
    expect(whenText("2026-10-29T12:00:00Z", now)).toBe("2 天前");
    expect(whenText(undefined, now)).toBe("");
    expect(whenText("not a date", now)).toBe("");
  });
});
