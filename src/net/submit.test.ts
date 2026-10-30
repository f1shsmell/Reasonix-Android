import { afterEach, describe, expect, it, vi } from "vitest";
import { cancel, submit } from "./submit";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("submit", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not call the kernel for empty input", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await submit("/rt/r1", "   ");
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("trims the input it sends", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    await submit("/rt/r1", "  hello  ");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/rt/r1/submit",
      expect.objectContaining({ body: JSON.stringify({ input: "hello" }) }),
    );
  });

  /**
   * The kernel's refusal is `{code, error, params}`. The code is the stable
   * identity and the message is only its wording, so the client carries the
   * code and never the sentence.
   */
  it("carries the kernel's refusal code, not its message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            code: "provider.key_missing",
            error: "the selected model has no API key yet; add one with /setup",
            params: { model: "deepseek-flash" },
          },
          409,
        ),
      ),
    );

    const result = await submit("/rt/r1", "hello");

    expect(result.ok).toBe(false);
    expect(result.code).toBe("provider.key_missing");
    expect(JSON.stringify(result)).not.toContain("add one with");
  });

  it("does not offer a retry for a refusal the person has to fix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ code: "provider.key_missing" }, 409)),
    );
    const result = await submit("/rt/r1", "hello");
    expect(result.retryable).toBe(false);
  });

  it("offers a retry for a server error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ code: "internal" }, 503)));
    const result = await submit("/rt/r1", "hello");
    expect(result.retryable).toBe(true);
  });

  it("falls back to a status code when the body is not json", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("gateway gone", { status: 502 })),
    );
    const result = await submit("/rt/r1", "hello");
    expect(result.code).toBe("http.502");
  });

  it("reports a dead socket as unconfirmed, not as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await submit("/rt/r1", "hello");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("client.offline");
    expect(result.retryable).toBe(false);
    expect(result.unconfirmed).toBe(true);
  });
});

describe("cancel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts a JSON body to the runtime's cancel route", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const result = await cancel("/rt/r1");
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/rt/r1/cancel",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        credentials: "same-origin",
      }),
    );
  });

  it("reports an offline cancel as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await cancel("/rt/r1");
    expect(result.retryable).toBe(true);
  });
});
