import { afterEach, describe, expect, it, vi } from "vitest";
import { paneCandidates } from "./useNeedsYou";
import type { RuntimeView } from "../wire/runtime";
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
