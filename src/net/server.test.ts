import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answeringOrigins,
  reachReport,
  configureProxy,
  firstAnswering,
  originAnswers,
  parseServerLink,
  probeDoor,
  probeUpstream,
  ProxyError,
  readProxyConfig,
  studioAppUrl,
  studioWebUrl,
} from "./server";

afterEach(() => vi.unstubAllGlobals());

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseServerLink", () => {
  it("reads a LAN pairing link", () => {
    expect(parseServerLink("http://192.168.5.2:8791/#pair=abc123")).toEqual({
      kind: "lan",
      origin: "http://192.168.5.2:8791",
      pairCode: "abc123",
    });
  });

  it("reads a LAN link with no code", () => {
    expect(parseServerLink("http://192.168.5.2:8791/")).toEqual({
      kind: "lan",
      origin: "http://192.168.5.2:8791",
    });
  });

  it("recognises the Internet link as a cloud code, not an origin", () => {
    expect(parseServerLink("https://reasonix.io/remote/?device=abc")).toEqual({
      kind: "cloud",
      device: "abc",
    });
  });

  it("reads a reasonix:// onboarding link", () => {
    expect(
      parseServerLink("reasonix://connect?origin=http%3A%2F%2F192.168.5.2%3A8791&pair=abc"),
    ).toEqual({ kind: "lan", origin: "http://192.168.5.2:8791", pairCode: "abc" });
    expect(
      parseServerLink("reasonix://open?url=https%3A%2F%2Freasonix.io%2Fremote%2F%3Fdevice%3Dabc"),
    ).toEqual({ kind: "cloud", device: "abc" });
  });

  it("refuses a link that is not a server", () => {
    expect(parseServerLink("ftp://192.168.5.2:8791/")).toBeNull();
    expect(parseServerLink("not a url")).toBeNull();
  });
});

describe("studio URLs", () => {
  const lan = {
    mode: "lan" as const,
    origin: "http://192.168.5.3:55716",
    studioUrl: "http://127.0.0.1:8788/",
  };
  const cloud = {
    mode: "relay" as const,
    origin: "",
    relayDevice: "dev-1",
  };

  it("opens a LAN page through the loopback proxy in the app", () => {
    // A bare WebView on the kernel address loses the VPN detour and the
    // pairing cookie; the in-app door must use the proxy's own address.
    expect(studioAppUrl(lan)).toBe("http://127.0.0.1:8788/");
  });

  it("keeps the real kernel address for the system browser", () => {
    // The browser has no proxy cookie and cannot reach 127.0.0.1 of the app.
    expect(studioWebUrl(lan)).toBe("http://192.168.5.3:55716");
  });

  it("falls back to the kernel address when the proxy publishes none", () => {
    // An older proxy or a browser dev session has no studioUrl field.
    expect(studioAppUrl({ mode: "lan", origin: "http://192.168.5.3:55716" })).toBe(
      "http://192.168.5.3:55716",
    );
  });

  it("never sends a cloud door to the loopback proxy", () => {
    expect(studioAppUrl(cloud)).toBe(
      "https://reasonix.io/remote/?device=dev-1",
    );
    expect(studioWebUrl(cloud)).toBe(
      "https://reasonix.io/remote/?device=dev-1",
    );
  });

  it("is empty when there is no link to open", () => {
    expect(studioAppUrl(null)).toBe("");
    expect(studioWebUrl(null)).toBe("");
  });
});

describe("proxy control plane", () => {
  it("reports no proxy in a browser instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    expect(await readProxyConfig()).toBeNull();
  });

  it("carries the refusal code rather than an HTTP number alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: "device.pairing_invalid" }, 403)),
    );
    await expect(configureProxy("http://host:1", "bad")).rejects.toMatchObject({
      name: "Error",
      status: 403,
      code: "device.pairing_invalid",
    } satisfies Partial<ProxyError>);
  });
});

describe("probeDoor", () => {
  it("names the computer behind a door that answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ machine: "MacBook-Pro" })));

    expect(await probeDoor("http://192.168.5.3:57074")).toEqual({
      ok: true,
      machine: "MacBook-Pro",
    });
  });

  it("keeps a refusal apart from a dead network", async () => {
    // The two need different next steps: re-pair, or retry later.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: "device.unauthorized" }, 401)),
    );

    expect(await probeDoor("http://192.168.5.3:57074")).toEqual({
      ok: false,
      code: "device.unauthorized",
    });
  });

  it("accepts a kernel that answers without naming itself", async () => {
    // An older build is a working door, not a broken one.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({})));

    expect(await probeDoor("http://192.168.5.3:57074")).toEqual({ ok: true, machine: "" });
  });

  it("lets an older shell fall back instead of refusing every door", async () => {
    // A proxy that predates `/__reasonix/device` answers 404. Refusing here
    // would turn an app upgrade into a connection that can never open.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: "proxy.unknown_path" }, 404)),
    );

    expect(await probeDoor("http://192.168.5.3:57074")).toEqual({ ok: true, machine: "" });
  });

  it("reports a dropped request as offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    expect(await probeDoor("http://192.168.5.3:57074")).toEqual({
      ok: false,
      code: "client.offline",
    });
  });
});

describe("originAnswers", () => {
  it("asks the origin with a no-cors GET and no credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(originAnswers(" http://192.168.5.2:56789/ ")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.5.2:56789/",
      expect.objectContaining({ method: "GET", mode: "no-cors", credentials: "omit" }),
    );
  });

  it("answers false when the computer does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(originAnswers("http://10.0.0.9:1234")).resolves.toBe(false);
  });

  it("answers false for an empty origin without asking", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(originAnswers("   ")).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("probeUpstream", () => {
  it("treats a readable conversation list as proof", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([{ id: "r1" }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeUpstream()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/runtimes",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("keeps an authorization refusal apart from a dead network", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({}, 401)));
    await expect(probeUpstream()).resolves.toEqual({ ok: false, code: "device.unauthorized" });
  });

  it("reports a body it cannot use", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ nope: true })));
    await expect(probeUpstream()).resolves.toEqual({ ok: false, code: "runtime.shape" });
  });

  it("reports a dropped request as offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(probeUpstream()).resolves.toEqual({ ok: false, code: "client.offline" });
  });
});

describe("firstAnswering", () => {
  it("answers the first remembered address the proxy says replies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          origins: [
            { origin: "http://down:1", ok: false, status: -1 },
            { origin: "http://up:2", ok: true, status: 200 },
          ],
        }),
      ),
    );

    await expect(firstAnswering(["http://down:1", "http://up:2"])).resolves.toBe("http://up:2");
  });

  it("answers null when none replies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({ origins: [{ origin: "http://a:1", ok: false, status: -1 }] }),
      ),
    );
    await expect(firstAnswering(["http://a:1", "http://b:2"])).resolves.toBeNull();
  });

  it("answers null without probing an empty list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(firstAnswering([])).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("answeringOrigins", () => {
  it("asks the proxy to probe the whole batch in one round trip", async () => {
    // The proxy binds each probe to the local link, which is the answer the
    // switch itself will get; the page cannot ask that question honestly.
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        origins: [
          { origin: "http://down:1", ok: false, status: -1 },
          { origin: "http://up:2", ok: true, status: 200 },
          { origin: "http://also:3", ok: true, status: 401 },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      answeringOrigins(["http://down:1", "http://up:2", "http://also:3"]),
    ).resolves.toEqual(["http://up:2", "http://also:3"]);

    const call = fetchMock.mock.calls[0] ?? [];
    const init = (call[1] ?? {}) as RequestInit;
    expect(call[0]).toBe("/__reasonix/reach");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      origins: ["http://down:1", "http://up:2", "http://also:3"],
    });
  });

  it("keeps the batch for the diagnostics text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          origins: [
            { origin: "http://down:1", ok: false, status: -1, ms: 3001 },
            { origin: "http://up:2", ok: true, status: 200, ms: 42 },
          ],
        }),
      ),
    );

    await answeringOrigins(["http://down:1", "http://up:2"]);

    expect(reachReport()).toEqual([
      { origin: "http://down:1", status: -1, ms: 3001 },
      { origin: "http://up:2", status: 200, ms: 42 },
    ]);
  });

  it("keeps the caller's order, not the answer's", async () => {
    // The walk is the person's own order; the proxy is free to answer in any.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          origins: [
            { origin: "http://b:2", ok: true, status: 200 },
            { origin: "http://a:1", ok: true, status: 200 },
          ],
        }),
      ),
    );

    await expect(answeringOrigins(["http://a:1", "http://b:2"])).resolves.toEqual([
      "http://a:1",
      "http://b:2",
    ]);
  });

  it("falls back to the page sweep on a shell without the route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ code: "proxy.unknown_path" }, 404))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(answeringOrigins(["http://a:1"])).resolves.toEqual(["http://a:1"]);
    // The fallback reads the address itself, as the page used to.
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("http://a:1/");
    // It cannot time the read, but it still says which door answered.
    expect(reachReport()).toEqual([{ origin: "http://a:1", status: 1, ms: -1 }]);
  });

  it("does not read a malformed answer as 'nothing answers'", async () => {
    // A 200 without rows is a shell that does not know the route; trusting it
    // would filter out every door and send the walk straight to the account.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(answeringOrigins(["http://a:1"])).resolves.toEqual(["http://a:1"]);
  });

  it("probes nothing for an empty list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(answeringOrigins([])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
