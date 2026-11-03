import { afterEach, describe, expect, it, vi } from "vitest";
import { compactContext, loadContext } from "./context";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("loadContext", () => {
  it("reads this conversation's gauge and its breakdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        used: 32_000,
        window: 100_000,
        system: 4_000,
        tools: 6_000,
        user: 2_000,
        reply: 8_000,
        output: 12_000,
        compact_at: 80_000,
        boundary: "capacity",
        capacity_at: 90_000,
        largest: [{ class: "output", tool: "read_file", tokens: 9_000 }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadContext("/rt/r1");

    // The path is the point: `/context` is a per-runtime route, so reading it
    // through a machine-level base answered for whichever pane was first.
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/rt/r1/context");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.used).toBe(32_000);
    expect(result.context.window).toBe(100_000);
    expect(result.context.output).toBe(12_000);
    expect(result.context.compactAt).toBe(80_000);
    expect(result.context.boundary).toBe("capacity");
    expect(result.context.largest).toEqual([
      { class: "output", tool: "read_file", tokens: 9_000 },
    ]);
  });

  it("treats a missing field as zero rather than losing the whole read", async () => {
    // A kernel that does not report a breakdown still reports the gauge, and
    // the gauge is what the sheet exists for.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ used: 10, window: 20 })));

    const result = await loadContext("/rt/r1");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.used).toBe(10);
    expect(result.context.output).toBe(0);
    expect(result.context.compactAt).toBe(0);
    expect(result.context.largest).toEqual([]);
  });

  it("reports the kernel's refusal code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: "runtime.gone" }, 404)),
    );

    const result = await loadContext("/rt/r1");

    expect(result).toEqual({ ok: false, code: "runtime.gone" });
  });

  it("reports a dead transport as offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));

    const result = await loadContext("/rt/r1");

    expect(result).toEqual({ ok: false, code: "client.offline" });
  });
});

describe("compactContext", () => {
  it("posts to this conversation and reports a completed fold", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ compacted: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await compactContext("/rt/r1");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/rt/r1/compact");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    // The kernel's CSRF guard refuses a POST without a JSON content type.
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(result).toEqual({ ok: true, compacted: true });
  });

  it("keeps a declined fold as a verdict, not a failure", async () => {
    // The kernel answers 200 with `compacted: false` when nothing was worth
    // folding. Reporting that as an error sent people looking for a fault.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ compacted: false, reason: "nothing_to_fold", detail: "这次没有可压缩的内容。" }),
      ),
    );

    const result = await compactContext("/rt/r1");

    expect(result).toEqual({
      ok: true,
      compacted: false,
      reason: "nothing_to_fold",
      detail: "这次没有可压缩的内容。",
    });
  });

  it("reports a busy refusal with its code, so the sheet can say to wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: "http.409" }, 409)),
    );

    const result = await compactContext("/rt/r1");

    expect(result.ok).toBe(false);
  });

  it("survives a refusal that is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const result = await compactContext("/rt/r1");

    expect(result).toEqual({ ok: false, code: "http.500" });
  });
});
