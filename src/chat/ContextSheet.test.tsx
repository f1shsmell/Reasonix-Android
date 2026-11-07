import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextSheet } from "./ContextSheet";
import { loadContext } from "../net/context";
import type { ContextSnapshot } from "../net/context";

vi.mock("../net/context", () => ({
  loadContext: vi.fn(),
  compactContext: vi.fn(),
}));

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
  vi.clearAllMocks();
});

async function render(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(<ContextSheet base="/rt/r1" onCompacted={() => {}} onClose={() => {}} />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function context(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    used: 820,
    window: 1000,
    system: 100,
    tools: 120,
    user: 100,
    reply: 200,
    output: 300,
    compactAt: 900,
    boundary: "capacity",
    capacityAt: 900,
    largest: [],
    ...overrides,
  };
}

describe("ContextSheet", () => {
  it("explains a fold as an archive, not as a model summary", async () => {
    vi.mocked(loadContext).mockResolvedValue({ ok: true, context: context() });
    await render();

    expect(container.textContent).toContain("归档到这台电脑");
    expect(container.textContent).toContain("原文不会删除");
    expect(container.textContent).not.toContain("总结成一段");
  });

  it("names the single automatic trigger as a share of the window", async () => {
    vi.mocked(loadContext).mockResolvedValue({ ok: true, context: context() });
    await render();

    expect(container.textContent).toContain("窗口的 90%");
    expect(container.textContent).not.toContain("成本上限");
  });

  it("warns from 80% without a dialog", async () => {
    vi.mocked(loadContext).mockResolvedValue({ ok: true, context: context() });
    await render();

    expect(container.querySelector(".context-percent.warn")).not.toBeNull();
    expect(container.querySelector(".context-bar.warn")).not.toBeNull();
    expect(container.textContent).toContain("82%");
  });

  it("keeps a quiet reading quiet below 80%", async () => {
    vi.mocked(loadContext).mockResolvedValue({
      ok: true,
      context: context({ used: 300 }),
    });
    await render();

    expect(container.querySelector(".context-percent.warn")).toBeNull();
    expect(container.querySelector(".context-bar.warn")).toBeNull();
  });
});
