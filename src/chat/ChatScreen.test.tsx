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
  vi.unstubAllGlobals();
});

const runtime: RuntimeView = { id: "r1", base: "/rt/r1", root: "/w", name: "w" };

function snapshot(lastEvent?: EventPayload): ConnectionSnapshot {
  return {
    reach: { kind: "ok" },
    runtimes: [runtime],
    stream: { kind: "open" },
    ...(lastEvent ? { lastEvent } : {}),
  };
}

/** Only attach/detach are reached; the real stream needs an EventSource jsdom lacks. */
const connection = {
  attach: () => {},
  detach: () => {},
} as unknown as Connection;

function historyResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Render, or re-render the same mounted screen.
 *
 * Reusing the root matters: a new root is a new component with new state, so
 * it could never show that a later event landed below an earlier history read.
 */
function render(snap: ConnectionSnapshot): void {
  const element = (
    <ChatScreen
      connection={connection}
      snapshot={snap}
      runtimeId="r1"
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        historyResponse([
          { role: "user", content: "老问题", msgIndex: 1 },
          { role: "assistant", content: "老回答", msgIndex: 2 },
        ]),
      ),
    );

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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse(null, 500)));

    render(snapshot());
    await flush();

    expect(container.textContent).toContain("没读到历史");
  });

  it("says it is still reading rather than claiming there is nothing", async () => {
    // "还没有消息" on a session with history is a lie the person acts on.
    let resolve: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(new Promise<Response>((done) => (resolve = done))),
    );

    render(snapshot());
    await flush();

    expect(container.textContent).toContain("正在读这个会话");

    await act(async () => {
      resolve(historyResponse([]));
      await Promise.resolve();
    });
  });

  it("shows no messages only once an empty history really is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(historyResponse([])));

    render(snapshot());
    await flush();

    expect(container.textContent).toContain("还没有消息");
  });
});