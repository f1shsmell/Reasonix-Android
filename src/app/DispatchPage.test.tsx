import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DispatchPage } from "./DispatchPage";
import type { TreeProject } from "../wire/tree";

vi.mock("../native/speech", () => ({
  speechSupported: () => true,
  beginSpeechHold: vi.fn(async (onChange: (state: Record<string, unknown>) => void) => {
    const state = {
      transcript: "跑一下测试",
      levels: [0.2, 0.4],
      ready: true,
      cancelArmed: false,
      ended: false,
      error: "",
    };
    onChange({ ...state });
    return {
      hold: {
        session: 1,
        state,
        move: () => {},
        release: () => {
          state.ended = true;
          onChange({ ...state });
        },
        abandon: () => {
          state.ended = true;
          onChange({ ...state });
        },
      },
    };
  }),
}));

let container: HTMLDivElement;
let root: Root | null = null;

const project: TreeProject = {
  root: "/work/app",
  name: "app",
  remembered: true,
  total: 0,
  remaining: 0,
  sessions: [],
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

function mount(projects: TreeProject[]): void {
  root = createRoot(container);
  act(() => {
    root?.render(
      <DispatchPage
        projects={projects}
        computerName="app"
        notify
        onDispatch={vi.fn(async () => ({ ok: true as const }))}
        onSent={() => {}}
      />,
    );
  });
}

describe("DispatchPage", () => {
  it("adopts the first project when the tree arrives after the page opened", () => {
    mount([]);
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);

    act(() => {
      root?.render(
        <DispatchPage
          projects={[project]}
          computerName="app"
          notify
          onDispatch={vi.fn(async () => ({ ok: true as const }))}
          onSent={() => {}}
        />,
      );
    });

    const option = container.querySelector('[role="option"]') as HTMLButtonElement;
    expect(option.textContent).toContain("app");
    expect(option.getAttribute("aria-selected")).toBe("true");

    const input = container.querySelector(".dispatch-input") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setter?.call(input, "跑测试");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect((container.querySelector(".dispatch-send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("cancels dictation by tapping the live strip", async () => {
    mount([project]);
    const mic = container.querySelector(".dispatch-tools .mic") as HTMLButtonElement;
    expect(mic).toBeTruthy();

    await act(async () => {
      mic.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientY: 200 }));
      await Promise.resolve();
    });
    const live = container.querySelector(".voice-live") as HTMLButtonElement;
    expect(live?.textContent).toContain("跑一下测试");
    expect(live.textContent).not.toContain("取消");

    act(() => live.click());

    expect(container.querySelector(".voice-live")).toBeNull();
    expect((container.querySelector(".dispatch-input") as HTMLTextAreaElement).value).toBe("");
  });
});
