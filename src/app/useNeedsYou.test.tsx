import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { needsYouSignal, paneCandidates, useNeedsYou } from "./useNeedsYou";
import type { RuntimeView } from "../wire/runtime";
import type { TreeProject } from "../wire/tree";
import type { EventPayload } from "../wire/events";

vi.mock("../net/status", () => ({
  loadStatus: vi.fn(async () => ({
    ok: true,
    status: { running: false, busy: false, plan: false, decisions: [], toolApprovalMode: "ask" },
  })),
}));

/**
 * Only a pane can be blocked on the person: a decision lives in the
 * controller of a running conversation. The sweep must therefore look at
 * conversations with a `runtimeId` and nothing else — a transcript with no
 * pane has no turn to be waiting on.
 */

afterEach(() => vi.unstubAllGlobals());

function project(overrides: Partial<TreeProject> = {}): TreeProject {
  return {
    root: "/work/app",
    name: "app",
    total: 3,
    remaining: 0,
    sessions: [
      { path: "/work/app/a.jsonl", name: "a", title: "修一下登录", runtimeId: "r2" },
      { path: "/work/app/b.jsonl", name: "b", title: "旧会话" },
    ],
    ...overrides,
  };
}

function runtime(overrides: Partial<RuntimeView> = {}): RuntimeView {
  return { id: "r2", base: "/rt/r2", root: "/work/app", name: "app", ...overrides };
}

describe("paneCandidates", () => {
  it("keeps every open pane, with the tree's labels when it knows it", () => {
    expect(
      paneCandidates([runtime({ sessionPath: "/work/app/a.jsonl" })], [project()]),
    ).toEqual([
      {
        base: "/rt/r2",
        runtimeId: "r2",
        projectName: "app",
        projectRoot: "/work/app",
        title: "修一下登录",
      },
    ]);
  });

  it("labels a pane the tree does not know from the runtime itself", () => {
    const rows = paneCandidates(
      [
        runtime({
          id: "r9",
          base: "/rt/r9",
          root: "/work/docs",
          name: "docs",
          sessionPath: "/work/docs/d.jsonl",
        }),
      ],
      [],
    );

    expect(rows[0]).toEqual({
      base: "/rt/r9",
      runtimeId: "r9",
      projectName: "docs",
      projectRoot: "/work/docs",
      title: "d.jsonl",
    });
  });

  it("does not invent a pane from a tree session alone", () => {
    expect(paneCandidates([], [project()])).toEqual([]);
  });

  it("keeps the pane's own base", () => {
    expect(paneCandidates([runtime({ base: "/rt/custom" })], [project()])[0]?.base).toBe(
      "/rt/custom",
    );
  });

  it("falls back to the root when the runtime has no project name", () => {
    const rows = paneCandidates([runtime({ name: "" })], []);
    expect(rows[0]?.projectName).toBe("/work/app");
  });

  it("reads a Windows transcript name", () => {
    const rows = paneCandidates(
      [runtime({ name: "docs", sessionPath: "C:\\work\\d.jsonl" })],
      [],
    );
    expect(rows[0]?.title).toBe("d.jsonl");
  });
});

describe("needsYouSignal", () => {
  it("counts the frames that change the block and ignores stream noise", () => {
    const frames: { event: EventPayload }[] = [
      { event: { kind: "text" } },
      { event: { kind: "reasoning" } },
      { event: { kind: "usage" } },
      { event: { kind: "ask_request", ask: { id: "a1", questions: [] } } },
      { event: { kind: "tool_done", approval: { id: "t1", tool: "bash", subject: "运行测试" } } },
      { event: { kind: "turn_started" } },
      { event: { kind: "turn_done" } },
    ];
    expect(needsYouSignal(frames)).toBe(4);
    // A batch of pure streaming deltas sweeps nothing.
    expect(needsYouSignal([{ event: { kind: "text" } }])).toBe(0);
  });
});

describe("the sweep on pushed frames", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function Harness({ signal }: { signal: number }): null {
    useNeedsYou([runtime()], [], 0, signal);
    return null;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  it("sweeps again the moment the signal changes, not a clock later", async () => {
    vi.useFakeTimers();
    const { loadStatus } = await import("../net/status");
    const calls = loadStatus as unknown as ReturnType<typeof vi.fn>;
    calls.mockClear();

    act(() => {
      root = createRoot(container);
      root?.render(<Harness signal={0} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toHaveBeenCalledTimes(1);

    // The mux lane pushed a decision: the sweep lands on the same tick
    // instead of waiting out the twenty-second clock.
    act(() => {
      root?.render(<Harness signal={1} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls.at(-1)?.[0]).toBe("/rt/r2");

    // And the twenty-second clock still runs as the backstop it was.
    calls.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });
});
