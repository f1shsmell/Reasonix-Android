import { afterEach, describe, expect, it, vi } from "vitest";
import { paneCandidates } from "./useNeedsYou";
import type { TreeProject } from "../wire/tree";

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

describe("paneCandidates", () => {
  it("keeps the conversations a pane is driving and drops the rest", () => {
    expect(paneCandidates([project()])).toEqual([
      {
        base: "/rt/r2",
        runtimeId: "r2",
        projectName: "app",
        projectRoot: "/work/app",
        title: "修一下登录",
      },
    ]);
  });

  it("falls back to the transcript name when no title was generated", () => {
    const rows = paneCandidates([
      project({
        sessions: [{ path: "/work/app/c.jsonl", name: "c", runtimeId: "r9" }],
      }),
    ]);
    expect(rows[0]?.title).toBe("c");
  });

  it("walks every project, so a blocked pane is found wherever it lives", () => {
    const rows = paneCandidates([
      project(),
      project({
        root: "/work/docs",
        name: "docs",
        sessions: [{ path: "/work/docs/d.jsonl", name: "d", runtimeId: "r5" }],
      }),
    ]);
    expect(rows.map((row) => row.runtimeId)).toEqual(["r2", "r5"]);
    expect(rows.map((row) => row.projectRoot)).toEqual(["/work/app", "/work/docs"]);
  });

  it("answers nothing when no pane is open", () => {
    expect(
      paneCandidates([
        project({ sessions: [{ path: "/work/app/a.jsonl", name: "a" }] }),
      ]),
    ).toEqual([]);
  });
});
