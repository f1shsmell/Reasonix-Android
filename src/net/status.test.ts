import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionLabel, decisionVerb, loadStatus, setPlanMode } from "./status";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("loadStatus", () => {
  it("reads the decisions a conversation is blocked on", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        running: true,
        busy: true,
        plan: false,
        modelRef: "deepseek/deepseek-flash",
        effort: "high",
        decisions: [
          {
            id: "d1",
            kind: "tool_approval",
          },
          {
            id: "d2",
            kind: "ask",
            questions: [
              {
                id: "q1",
                header: "用哪个方案",
                prompt: "选一个",
                options: [{ label: "A" }, { label: "B", description: "更稳" }],
                multi: true,
              },
            ],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadStatus("/rt/r1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/status",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toEqual({
      ok: true,
      status: {
        running: true,
        busy: true,
        plan: false,
        modelRef: "deepseek/deepseek-flash",
        effort: "high",
        decisions: [
          { id: "d1", kind: "tool_approval" },
          {
            id: "d2",
            kind: "ask",
            questions: [
              {
                id: "q1",
                header: "用哪个方案",
                prompt: "选一个",
                options: [{ label: "A" }, { label: "B", description: "更稳" }],
                multi: true,
              },
            ],
          },
        ],
      },
    });
  });

  it("accepts a pane with nothing waiting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ running: false, busy: false, plan: false })));
    const result = await loadStatus("/rt/r1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.decisions).toEqual([]);
  });

  it("drops a decision with no id rather than drawing an unanswerable card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ decisions: [{ kind: "ask" }, { id: "keep", kind: "ask" }] })),
    );
    const result = await loadStatus("/rt/r1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.status.decisions.map((d) => d.id)).toEqual(["keep"]);
  });

  it("carries a refusal code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "session.unknown" }, 404)));
    await expect(loadStatus("/rt/r1")).resolves.toEqual({ ok: false, code: "session.unknown" });
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(loadStatus("/rt/r1")).resolves.toEqual({ ok: false, code: "client.offline" });
  });
});

describe("decisionLabel", () => {
  it("prefers the question's own header over a generic sentence", () => {
    expect(
      decisionLabel({
        id: "d",
        kind: "ask",
        questions: [{ id: "q", header: "用哪个方案", prompt: "选一个", options: [] }],
      }),
    ).toBe("用哪个方案");
  });

  it("falls back to the question when it has no header", () => {
    expect(
      decisionLabel({ id: "d", kind: "ask", questions: [{ id: "q", prompt: "选一个", options: [] }] }),
    ).toBe("选一个");
  });

  it("names the subsystem when there is no question text", () => {
    expect(decisionLabel({ id: "d", kind: "tool_approval" })).toContain("批准");
    expect(decisionLabel({ id: "d", kind: "plan_approval" })).toContain("计划");
    expect(decisionLabel({ id: "d", kind: "recovery_approval" })).toContain("恢复");
    expect(decisionLabel({ id: "d", kind: "something_new" })).toBe("等你处理");
  });
});

describe("decisionVerb", () => {
  it("gives each subsystem its own verb", () => {
    expect(decisionVerb({ id: "d", kind: "ask" })).toBe("待回答");
    expect(decisionVerb({ id: "d", kind: "tool_approval" })).toBe("待批准");
    expect(decisionVerb({ id: "d", kind: "plan_approval" })).toBe("待批准计划");
    expect(decisionVerb({ id: "d", kind: "recovery_approval" })).toBe("待恢复");
    expect(decisionVerb({ id: "d", kind: "future" })).toBe("待处理");
  });
});

describe("setPlanMode", () => {
  it("turns plan mode on for this conversation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(setPlanMode("/rt/r1", true)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/plan",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ on: true }) }),
    );
  });

  it("keeps a refusal code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: "session.running" }, 409)),
    );
    await expect(setPlanMode("/rt/r1", true)).resolves.toEqual({
      ok: false,
      code: "session.running",
    });
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(setPlanMode("/rt/r1", false)).resolves.toEqual({
      ok: false,
      code: "client.offline",
    });
  });
});
