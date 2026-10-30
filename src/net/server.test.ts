import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureProxy,
  originAnswers,
  parseServerLink,
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
