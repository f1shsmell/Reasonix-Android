import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ProjectSheet } from "./ProjectSheet";

/**
 * The sheet is the phone's whole project surface. It may only offer roots the
 * kernel listed, and opening one is a POST /runtimes for a fresh conversation.
 */

let container: HTMLDivElement;
let root: Root | null = null;
let opened: Mock<(runtimeId: string) => void>;

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
  opened = vi.fn<(runtimeId: string) => void>();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(<ProjectSheet base="/rt/r1" root="/work/app" onClose={() => {}} onOpened={opened} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button containing ${text}`);
  return found;
}

describe("ProjectSheet", () => {
  it("opens a fresh conversation in the current project", async () => {
    const fetchMock = route((url, init) => {
      if (url.endsWith("/workspaces")) {
        return json({
          current: "/work/app",
          canSwitch: true,
          canIsolate: false,
          recents: [{ path: "/work/docs", name: "docs" }],
        });
      }
      if (url === "/runtimes" && init?.method === "POST") {
        return json({ id: "r7", base: "/rt/r7", root: "/work/app", name: "app" });
      }
      return json({}, 404);
    });

    await render();
    expect(container.textContent).toContain("当前项目新建会话");
    expect(container.textContent).toContain("docs");

    await act(async () => {
      button("当前项目新建会话").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/runtimes",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ root: "/work/app" }) }),
    );
    expect(opened).toHaveBeenCalledWith("r7");
  });

  it("opens a listed recent project through the hub", async () => {
    route((url) => {
      if (url.endsWith("/workspaces")) {
        return json({ current: "/work/app", canSwitch: true, canIsolate: false, recents: [{ path: "/work/docs", name: "docs" }] });
      }
      if (url === "/runtimes") {
        return json({ id: "r8", base: "/rt/r8", root: "/work/docs", name: "docs" });
      }
      return json({}, 404);
    });

    await render();
    await act(async () => {
      button("/work/docs").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(opened).toHaveBeenCalledWith("r8");
  });

  it("still lets the current project start when recents cannot be read", async () => {
    route((url) => {
      if (url.endsWith("/workspaces")) return json({ code: "device.host_only" }, 404);
      return json({ id: "r9", base: "/rt/r9", root: "/work/app", name: "app" });
    });

    await render();
    expect(container.textContent).toContain("读不到最近项目");

    await act(async () => {
      button("当前项目新建会话").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(opened).toHaveBeenCalledWith("r9");
  });

  it("shows a refusal rather than pretending a session opened", async () => {
    route((url) => {
      if (url.endsWith("/workspaces")) {
        return json({ current: "/work/app", canSwitch: false, canIsolate: false, recents: [] });
      }
      return json({ code: "device.host_only" }, 404);
    });

    await render();
    await act(async () => {
      button("当前项目新建会话").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("桌面端不允许手机打开这个项目");
    expect(opened).not.toHaveBeenCalled();
  });
});
