import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureProxy,
  firstAnswering,
  originAnswers,
  parseServerLink,
  probeUpstream,
  ProxyError,
  readProxyConfig,
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
  it("answers the first remembered address that replies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) =>
        String(input).startsWith("http://down") ? Promise.reject(new TypeError("network")) : Promise.resolve(new Response(null)),
      ),
    );

    await expect(firstAnswering(["http://down:1", "http://up:2"])).resolves.toBe("http://up:2");
  });

  it("answers null when none replies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(firstAnswering(["http://a:1", "http://b:2"])).resolves.toBeNull();
  });

  it("answers null without probing an empty list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(firstAnswering([])).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
