import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestTimeout, fetchWithTimeout, withTimeout } from "./http";

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns a response that arrives before the deadline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const response = await fetchWithTimeout("/runtimes", {}, 1_000);
    expect(await response.text()).toBe("ok");
  });

  it("rejects with RequestTimeout when the fetch never settles", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const pending = fetchWithTimeout("/runtimes", {}, 1_000);
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeout);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("aborts the underlying request when the deadline passes", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    const pending = fetchWithTimeout("/runtimes", {}, 500);
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeout);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it("forwards a caller's abort without calling it a timeout", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }),
    );
    const pending = fetchWithTimeout("/runtimes", { signal: controller.signal }, 10_000);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
  });
});

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects a promise that never settles", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => undefined), 1_000, "probe hung");
    const assertion = expect(pending).rejects.toBeInstanceOf(RequestTimeout);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("passes through a value that arrives first", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1_000)).resolves.toBe("done");
  });
});
