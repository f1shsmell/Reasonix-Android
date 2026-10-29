import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTodos, todoRevision } from "./todos";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("loadTodos", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the canonical list and keeps its order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json([
          { content: "读代码", status: "completed" },
          { content: "写测试", status: "in_progress", activeForm: "正在写测试" },
          { content: "跑验证", status: "pending", level: 1 },
        ]),
      ),
    );

    const result = await loadTodos("/rt/r1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items.map((item) => item.content)).toEqual([
        "读代码",
        "写测试",
        "跑验证",
      ]);
      expect(result.items[1]?.activeForm).toBe("正在写测试");
      expect(result.items[2]?.level).toBe(1);
    }
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/rt/r1/todos");
  });

  it("keeps a status this client does not know instead of rewriting it", async () => {
    // The contract only grows: an unknown status is the kernel's, not ours to
    // flatten into "pending" at the wire boundary.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json([{ content: "x", status: "blocked" }])),
    );
    const result = await loadTodos("/rt/r1");
    expect(result.ok && result.items[0]?.status).toBe("blocked");
  });

  it("drops a row with no text rather than drawing an empty line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json([{ content: "", status: "pending" }, { content: "留着我", status: "pending" }]),
      ),
    );
    const result = await loadTodos("/rt/r1");
    expect(result.ok && result.items).toHaveLength(1);
  });

  it("reports a refusal as a code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const result = await loadTodos("/rt/r1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("http.404");
  });

  it("reports a dead socket rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await loadTodos("/rt/r1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("client.offline");
  });

  it("refuses a body that is not a list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ todos: [] })));
    const result = await loadTodos("/rt/r1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("todos.shape");
  });
});

describe("todoRevision", () => {
  it("treats a frame with the same clocks as not news", () => {
    const a = todoRevision({ contentRevision: 2, planRevision: 1, progressRevision: 4 });
    const b = todoRevision({ contentRevision: 2, planRevision: 1, progressRevision: 4 });
    expect(a).toBe(b);
  });

  it("changes when any one clock moves", () => {
    const before = todoRevision({ contentRevision: 2, planRevision: 1, progressRevision: 4 });
    expect(todoRevision({ contentRevision: 3, planRevision: 1, progressRevision: 4 })).not.toBe(
      before,
    );
    expect(todoRevision({ contentRevision: 2, planRevision: 2, progressRevision: 4 })).not.toBe(
      before,
    );
    expect(todoRevision({ contentRevision: 2, planRevision: 1, progressRevision: 5 })).not.toBe(
      before,
    );
  });

  it("tells a missing payload apart from an empty one", () => {
    expect(todoRevision(undefined)).toBe("");
    expect(todoRevision({})).toBe("0:0:0");
  });
});
