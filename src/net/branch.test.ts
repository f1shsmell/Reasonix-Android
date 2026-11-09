import { afterEach, describe, expect, it, vi } from "vitest";
import { branchAt, branchMessage } from "./branch";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("branchAt", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers the path of the session the kernel forked", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ path: "/w/.reasonix/sessions/fork.jsonl" }, 200));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await branchAt("/rt/r1", 3, "会话 · 分支");

    expect(result).toEqual({ ok: true, path: "/w/.reasonix/sessions/fork.jsonl" });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/rt/r1/branch/at",
      expect.objectContaining({ body: JSON.stringify({ turn: 3, name: "会话 · 分支" }) }),
    );
  });

  it("refuses an answer that names no file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 200)));

    expect(await branchAt("/rt/r1", 3, "")).toEqual({ ok: false, code: "branch.shape" });
  });

  it("carries the kernel's refusal code, not its wording", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { code: "conversation_branch.turn_running", error: "the turn is still running" },
          409,
        ),
      ),
    );

    expect(await branchAt("/rt/r1", 3, "")).toEqual({
      ok: false,
      code: "conversation_branch.turn_running",
    });
  });

  it("falls back to the status when a refusal is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("no", { status: 502 })));

    expect(await branchAt("/rt/r1", 3, "")).toEqual({ ok: false, code: "http.502" });
  });

  it("keeps a dropped request and a deadline apart", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    expect(await branchAt("/rt/r1", 3, "")).toEqual({ ok: false, code: "client.offline" });
  });

  it("reports a kernel that outlives the deadline as a timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

      const pending = branchAt("/rt/r1", 3, "");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await pending).toEqual({ ok: false, code: "client.timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("branchMessage", () => {
  it("says what to do about a refusal it knows", () => {
    expect(branchMessage("conversation_branch.turn_running")).toContain("结束后再建分支");
    expect(branchMessage("conversation_branch.unavailable")).toContain("没有检查点");
    expect(branchMessage("client.offline")).toContain("连不上电脑");
    expect(branchMessage("client.timeout")).toContain("没有及时回应");
  });

  it("keeps an unknown code visible instead of inventing a reason", () => {
    expect(branchMessage("conversation_branch.some_future_code")).toContain(
      "conversation_branch.some_future_code",
    );
  });
});
