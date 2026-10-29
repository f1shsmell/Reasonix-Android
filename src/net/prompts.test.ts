import { afterEach, describe, expect, it, vi } from "vitest";
import { answer, approve } from "./prompts";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Both request bodies here were once wrong, and both wrong bodies were
 * accepted or rejected by the kernel in ways that hid the bug. These tests pin
 * the shapes that a real kernel answered 204 to.
 */
describe("answer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends AskAnswer objects with the Go field names", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await answer("/rt/r1", "ask-1", [{ QuestionID: "q1", Selected: ["茶"] }]);

    expect(fetchSpy).toHaveBeenCalledWith(
      "/rt/r1/answer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "ask-1",
          answers: [{ QuestionID: "q1", Selected: ["茶"] }],
        }),
      }),
    );
  });

  it("never sends a bare string list", async () => {
    // `answers: ["茶"]` is what the first version sent; the kernel refused it
    // with `request.missing_field`, which reads as "you forgot id".
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await answer("/rt/r1", "ask-1", [{ QuestionID: "q1", Selected: ["茶"] }]);

    const body = (fetchSpy.mock.calls[0]?.[1] as { body: string }).body;
    expect(body).not.toContain('"answers":["');
  });

  it("carries every question in a multi-question form", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await answer("/rt/r1", "ask-1", [
      { QuestionID: "q1", Selected: ["a"] },
      { QuestionID: "q2", Selected: ["b", "c"] },
    ]);

    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body) as {
      answers: unknown[];
    };
    expect(body.answers).toHaveLength(2);
  });

  it("reports the kernel's refusal code, not its wording", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            code: "ask.not_found",
            error: "no question by that name is open",
            params: { path: "" },
          },
          404,
        ),
      ),
    );

    const result = await answer("/rt/r1", "gone", [{ QuestionID: "q1", Selected: ["a"] }]);

    expect(result.ok).toBe(false);
    expect(result.code).toBe("ask.not_found");
    expect(JSON.stringify(result)).not.toContain("no question by that name");
  });

  it("does not offer a retry for a settled question", async () => {
    // `ask.already_resolved` will not change by asking again.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: "ask.already_resolved" }, 409)),
    );
    const result = await answer("/rt/r1", "a1", [{ QuestionID: "q1", Selected: ["a"] }]);
    expect(result.retryable).toBe(false);
  });

  it("reports a dead socket as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await answer("/rt/r1", "a1", [{ QuestionID: "q1", Selected: ["a"] }]);
    expect(result.code).toBe("client.offline");
    expect(result.retryable).toBe(true);
  });
});

describe("approve", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends session and persist, the fields the kernel reads", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await approve("/rt/r1", "ap-1", true, true, false);

    expect(fetchSpy).toHaveBeenCalledWith(
      "/rt/r1/approve",
      expect.objectContaining({
        body: JSON.stringify({ id: "ap-1", allow: true, session: true, persist: false }),
      }),
    );
  });

  it("never sends remember, which the kernel ignores", async () => {
    // A `remember` field is accepted and dropped, so the request looks like it
    // worked while the grant the person asked for is never applied.
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await approve("/rt/r1", "ap-1", true, true, true);

    const body = (fetchSpy.mock.calls[0]?.[1] as { body: string }).body;
    expect(body).not.toContain("remember");
  });

  it("sends a denial with no grants", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    await approve("/rt/r1", "ap-1", false, false, false);

    expect((fetchSpy.mock.calls[0]?.[1] as { body: string }).body).toBe(
      JSON.stringify({ id: "ap-1", allow: false, session: false, persist: false }),
    );
  });

  it("reports a refusal with its code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: "approval.stale" }, 409)),
    );
    const result = await approve("/rt/r1", "ap-1", true, false, false);
    expect(result.code).toBe("approval.stale");
  });

  it("reports an offline approve as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await approve("/rt/r1", "ap-1", true, false, false);
    expect(result.code).toBe("client.offline");
    expect(result.retryable).toBe(true);
  });
});