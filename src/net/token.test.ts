import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap } from "./token";

/**
 * The fragment must never survive the exchange. It is in the URL a page can
 * navigate from and a referrer can carry, and the credential in it is the whole
 * authority the phone has.
 */
describe("bootstrap", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.unstubAllGlobals();
  });

  it("does nothing when the fragment carries no credential", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await bootstrap();
    expect(result).toEqual({ exchanged: false, paired: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exchanges a token and wipes the fragment", async () => {
    window.history.replaceState(null, "", "/#token=abc123");
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrap();

    expect(result).toEqual({ exchanged: true, paired: false });
    expect(window.location.hash).toBe("");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/auth/token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "abc123" }),
      }),
    );
  });

  it("posts a pairing code to /pair, not /auth/token", async () => {
    window.history.replaceState(null, "", "/#pair=code9");
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await bootstrap();

    expect(result).toEqual({ exchanged: true, paired: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/pair",
      expect.objectContaining({ body: JSON.stringify({ code: "code9" }) }),
    );
  });

  it("keeps unrelated fragment keys and reports a refusal", async () => {
    window.history.replaceState(null, "", "/#token=bad&tab=chat");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    );

    const result = await bootstrap();

    expect(result.exchanged).toBe(false);
    expect(result.error).toBe("HTTP 401");
    expect(window.location.hash).toBe("#tab=chat");
  });
});
