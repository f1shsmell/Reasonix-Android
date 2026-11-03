import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachinePanel } from "./MachinePanel";

let container: HTMLDivElement;
let root: Root | null = null;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function missing(): Response {
  return new Response(null, { status: 404 });
}

async function render(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(<MachinePanel base="/rt/r1" />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

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

describe("MachinePanel", () => {
  it("summarises spend, tools, boundary and version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/usage?")) {
          return Promise.resolve(
            json({
              tokens: 1_234_567,
              requests: 42,
              turns: 12,
              cost: [{ amount: "1.20", currency: "USD" }],
              top_model: "deepseek-pro",
            }),
          );
        }
        if (url.endsWith("/tools")) {
          return Promise.resolve(
            json({
              tools: [
                { name: "bash", disabled: false },
                { name: "edit_file", disabled: true },
                { name: "grep", disabled: false },
              ],
            }),
          );
        }
        if (url.endsWith("/permissions")) {
          return Promise.resolve(json({ mode: "ask", allow: ["a"], ask: ["b", "c"], deny: [] }));
        }
        if (url.endsWith("/studio/versions")) {
          return Promise.resolve(json({ current: "2.49.0", latest: "2.49.0", newer: false }));
        }
        return Promise.resolve(missing());
      }),
    );

    await render();

    const text = container.textContent ?? "";
    expect(text).toContain("最近 30 天");
    expect(text).toContain("1.2M tokens");
    expect(text).toContain("42 次请求");
    expect(text).toContain("USD 1.20");
    expect(text).toContain("2 / 3");
    expect(text).toContain("逐次询问");
    expect(text).toContain("已是最新");
  });

  it("does not read the context gauge, which belongs to a conversation", async () => {
    // The gauge is per pane. This panel only knows a machine, so it used to
    // show the window of whichever runtime was first in the list — somebody
    // else's conversation. It lives in the chat's own sheet now.
    const fetchMock = vi.fn((input: RequestInfo | URL) =>
      String(input).includes("/usage?")
        ? Promise.resolve(json({ tokens: 10, requests: 1, turns: 1 }))
        : Promise.resolve(missing()),
    );
    vi.stubGlobal("fetch", fetchMock);

    await render();

    const asked = fetchMock.mock.calls.map(([input]) => String(input));
    expect(asked.some((url) => url.endsWith("/context"))).toBe(false);
    expect(container.textContent).not.toContain("上下文");
    expect(container.textContent).toContain("最近 30 天");
  });

  it("keeps the sections this kernel does have", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).endsWith("/tools")
          ? Promise.resolve(json({ tools: [{ name: "bash", disabled: false }] }))
          : Promise.resolve(missing()),
      ),
    );

    await render();

    expect(container.textContent).toContain("工具");
    expect(container.textContent).not.toContain("最近 30 天");
    expect(container.textContent).not.toContain("读不到这台机器的状态");
  });

  it("shows nothing when every read fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => missing()));

    await render();

    // No section answered, so there is no panel to draw. The settings page
    // already says whether there is a computer; an empty explanation here
    // repeated it in smaller type.
    expect(container.textContent).toBe("");
  });
});
