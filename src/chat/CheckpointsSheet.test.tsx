import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointsSheet } from "./CheckpointsSheet";

let container: HTMLDivElement;
let root: Root | null = null;
let onClose = vi.fn();
let onRewound = vi.fn();

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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
    root?.render(<CheckpointsSheet base="/rt/r1" onClose={onClose} onRewound={onRewound} />);
  });
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  onClose = vi.fn();
  onRewound = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

describe("CheckpointsSheet", () => {
  it("prepares a plan and commits only after the confirmation", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/checkpoints")) {
        return Promise.resolve(
          json([
            { turn: 3, prompt: "改登录", files: 2 },
            { turn: 2, prompt: "初始化", files: 1 },
          ]),
        );
      }
      if (url.endsWith("/rewind/prepare")) {
        return Promise.resolve(
          json({
            planId: "p1",
            turn: 3,
            coverage: "partial",
            canFiles: true,
            canConversation: true,
            fileCount: 2,
            requiresConfirmation: false,
          }),
        );
      }
      if (url.endsWith("/rewind/commit")) return Promise.resolve(json({ ok: true }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await render();

    expect(container.textContent).toContain("第 3 轮");
    expect(container.textContent).toContain("改登录");

    const first = container.querySelector(".checkpoint-list button") as HTMLButtonElement;
    await act(async () => {
      first.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("回到第 3 轮之前");
    expect(container.textContent).toContain("恢复文件并截断对话");
    expect(onRewound).not.toHaveBeenCalled();

    const confirm = Array.from(container.querySelectorAll(".rewind-actions button")).find((node) =>
      node.textContent?.includes("确认回到这里"),
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/rewind/prepare",
      expect.objectContaining({ body: JSON.stringify({ turn: 3, scope: "both" }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/rewind/commit",
      expect.objectContaining({ body: JSON.stringify({ planId: "p1" }) }),
    );
    expect(onRewound).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says when a checkpoint cannot be restored", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/checkpoints")) {
          return Promise.resolve(json([{ turn: 1, prompt: "开始", files: 0 }]));
        }
        if (url.endsWith("/rewind/prepare")) {
          return Promise.resolve(
            json({
              planId: "p2",
              turn: 1,
              coverage: "none",
              canFiles: false,
              canConversation: false,
              disabledReason: "这一轮没有快照",
              fileCount: 0,
              requiresConfirmation: false,
            }),
          );
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      }),
    );
    await render();

    await act(async () => {
      (container.querySelector(".checkpoint-list button") as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("这一轮没有快照");
    const confirm = Array.from(container.querySelectorAll(".rewind-actions button")).find((node) =>
      node.textContent?.includes("确认回到这里"),
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});
