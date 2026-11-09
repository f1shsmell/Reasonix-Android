/**
 * Opening the paired computer's Studio from one place.
 *
 * The result is a union rather than a throw because the screen has to say
 * different things for "no address" and "both doors failed". These cases pin
 * the URL each door gets and the single-flight guard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const serverMock = vi.hoisted(() => ({
  readProxyConfig: vi.fn(),
  studioAppUrl: vi.fn(),
  studioWebUrl: vi.fn(),
}));
vi.mock("../net/server", () => serverMock);

const storeMock = vi.hoisted(() => ({ loadRelayDevice: vi.fn(() => null) }));
vi.mock("../net/relayStore", () => storeMock);

const webMock = vi.hoisted(() => ({ WebMode: { open: vi.fn() } }));
vi.mock("../native/webmode", () => webMock);

const browserMock = vi.hoisted(() => ({ Browser: { open: vi.fn() } }));
vi.mock("@capacitor/browser", () => browserMock);

let openStudio: typeof import("./openStudio").openStudio;

const LAN = {
  mode: "lan" as const,
  origin: "http://192.168.5.3:57074",
  studioUrl: "http://127.0.0.1:8788/",
  relayDevice: "",
};

beforeEach(async () => {
  vi.resetAllMocks();
  // A fresh module instance: the single-flight promise lives at module scope.
  vi.resetModules();
  ({ openStudio } = await import("./openStudio"));
  storeMock.loadRelayDevice.mockReturnValue(null);
});

describe("openStudio", () => {
  it("answers none when there is no proxy to read", async () => {
    serverMock.readProxyConfig.mockResolvedValue(null);

    await expect(openStudio()).resolves.toEqual({ kind: "none" });
    expect(webMock.WebMode.open).not.toHaveBeenCalled();
  });

  it("opens a LAN page through the loopback proxy", async () => {
    serverMock.readProxyConfig.mockResolvedValue(LAN);
    serverMock.studioAppUrl.mockReturnValue("http://127.0.0.1:8788/");
    webMock.WebMode.open.mockResolvedValue(undefined);

    await expect(openStudio()).resolves.toEqual({ kind: "native" });
    expect(webMock.WebMode.open).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8788/",
      viaProxy: true,
      origin: "http://192.168.5.3:57074",
    });
  });

  it("opens a cloud page without the proxy", async () => {
    serverMock.readProxyConfig.mockResolvedValue({
      mode: "relay",
      origin: "http://192.168.5.3:57074",
      relayDevice: "dev-1",
    });
    serverMock.studioAppUrl.mockReturnValue("https://reasonix.io/remote/?device=dev-1");
    webMock.WebMode.open.mockResolvedValue(undefined);

    await expect(openStudio()).resolves.toEqual({ kind: "native" });
    expect(webMock.WebMode.open).toHaveBeenCalledWith({
      url: "https://reasonix.io/remote/?device=dev-1",
      viaProxy: false,
      origin: "http://192.168.5.3:57074",
    });
  });

  it("answers none when the config has no address", async () => {
    serverMock.readProxyConfig.mockResolvedValue({ mode: "lan", origin: "", relayDevice: "" });
    serverMock.studioAppUrl.mockReturnValue("");

    await expect(openStudio()).resolves.toEqual({ kind: "none" });
    expect(webMock.WebMode.open).not.toHaveBeenCalled();
  });

  it("falls back to the browser with the real address", async () => {
    serverMock.readProxyConfig.mockResolvedValue(LAN);
    serverMock.studioAppUrl.mockReturnValue("http://127.0.0.1:8788/");
    serverMock.studioWebUrl.mockReturnValue("http://192.168.5.3:57074/");
    webMock.WebMode.open.mockRejectedValue(new Error("no activity"));
    browserMock.Browser.open.mockResolvedValue(undefined);

    await expect(openStudio()).resolves.toEqual({ kind: "browser" });
    expect(browserMock.Browser.open).toHaveBeenCalledWith({ url: "http://192.168.5.3:57074/" });
  });

  it("answers failed when both doors refuse", async () => {
    serverMock.readProxyConfig.mockResolvedValue(LAN);
    serverMock.studioAppUrl.mockReturnValue("http://127.0.0.1:8788/");
    serverMock.studioWebUrl.mockReturnValue("http://192.168.5.3:57074/");
    webMock.WebMode.open.mockRejectedValue(new Error("no activity"));
    browserMock.Browser.open.mockRejectedValue(new Error("no browser"));

    await expect(openStudio()).resolves.toMatchObject({ kind: "failed" });
  });

  it("joins a second tap to the first instead of opening twice", async () => {
    serverMock.readProxyConfig.mockResolvedValue(LAN);
    serverMock.studioAppUrl.mockReturnValue("http://127.0.0.1:8788/");
    webMock.WebMode.open.mockResolvedValue(undefined);

    const [first, second] = await Promise.all([openStudio(), openStudio()]);

    expect(first).toEqual({ kind: "native" });
    expect(second).toEqual({ kind: "native" });
    expect(webMock.WebMode.open).toHaveBeenCalledTimes(1);
  });

  it("skips the proxy flag when a LAN door publishes no loopback address", async () => {
    // An older proxy does not publish `studioUrl`; the page then has to load
    // the kernel address directly rather than claim a proxy it has not got.
    serverMock.readProxyConfig.mockResolvedValue({ ...LAN, studioUrl: "" });
    serverMock.studioAppUrl.mockReturnValue("http://192.168.5.3:57074");
    webMock.WebMode.open.mockResolvedValue(undefined);

    await expect(openStudio()).resolves.toEqual({ kind: "native" });
    expect(webMock.WebMode.open).toHaveBeenCalledWith({
      url: "http://192.168.5.3:57074",
      viaProxy: false,
      origin: "http://192.168.5.3:57074",
    });
  });

  it("gives the browser the remote page on a cloud door", async () => {
    serverMock.readProxyConfig.mockResolvedValue({
      mode: "relay",
      origin: "",
      relayDevice: "dev-1",
    });
    serverMock.studioAppUrl.mockReturnValue("https://reasonix.io/remote/?device=dev-1");
    serverMock.studioWebUrl.mockReturnValue("https://reasonix.io/remote/?device=dev-1");
    webMock.WebMode.open.mockRejectedValue(new Error("no activity"));
    browserMock.Browser.open.mockResolvedValue(undefined);

    await expect(openStudio()).resolves.toEqual({ kind: "browser" });
    expect(browserMock.Browser.open).toHaveBeenCalledWith({
      url: "https://reasonix.io/remote/?device=dev-1",
    });
  });
});
