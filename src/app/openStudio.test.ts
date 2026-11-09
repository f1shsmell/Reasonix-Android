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
  // The real helper is a pure string; keep the tests on the same spelling.
  studioRemoteUrl: (device: string | null | undefined) => {
    const id = (device ?? "").trim();
    return id ? `https://reasonix.io/remote/?device=${encodeURIComponent(id)}` : "";
  },
}));
vi.mock("../net/server", () => serverMock);

const storeMock = vi.hoisted(() => ({ loadRelayDevice: vi.fn<() => string | null>(() => null) }));
const relayMock = vi.hoisted(() => ({ relayAlive: vi.fn(() => false) }));
vi.mock("../net/relay", () => relayMock);
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
  relayMock.relayAlive.mockReturnValue(false);
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
      // The cloud page redirects itself to the Studio host; that is the same
      // visit, not an external link.
      allowHosts: ["studio.reasonix.io", "id.reasonix.io"],
    });
  });

  it("follows a live relay even before the proxy calls itself relay", async () => {
    // A handover opens the link before it marks it; the config still says
    // "lan" for that window, and the loopback it names is already gone.
    serverMock.readProxyConfig.mockResolvedValue({ ...LAN, relayDevice: "" });
    serverMock.studioAppUrl.mockReturnValue("http://127.0.0.1:8788/");
    storeMock.loadRelayDevice.mockReturnValue("dev-1");
    relayMock.relayAlive.mockReturnValue(true);
    webMock.WebMode.open.mockResolvedValue(undefined);

    await expect(openStudio()).resolves.toEqual({ kind: "native" });
    expect(webMock.WebMode.open).toHaveBeenCalledWith({
      url: "https://reasonix.io/remote/?device=dev-1",
      viaProxy: false,
      origin: "http://192.168.5.3:57074",
      allowHosts: ["studio.reasonix.io", "id.reasonix.io"],
    });
  });

  it("falls back to the remote page when a live relay's page cannot open", async () => {
    // The proxy still says "lan" during a handover; the browser must not be
    // handed the LAN origin the app has already left.
    serverMock.readProxyConfig.mockResolvedValue({ ...LAN, relayDevice: "" });
    serverMock.studioAppUrl.mockReturnValue("http://127.0.0.1:8788/");
    serverMock.studioWebUrl.mockReturnValue("http://192.168.5.3:57074");
    storeMock.loadRelayDevice.mockReturnValue("dev-1");
    relayMock.relayAlive.mockReturnValue(true);
    webMock.WebMode.open.mockRejectedValue(new Error("no activity"));
    browserMock.Browser.open.mockResolvedValue(undefined);

    await expect(openStudio()).resolves.toEqual({ kind: "browser" });
    expect(browserMock.Browser.open).toHaveBeenCalledWith({
      url: "https://reasonix.io/remote/?device=dev-1",
    });
  });

  it("prefers the cloud door while the link is not a working LAN", async () => {
    // A phone that just left Wi-Fi still has a LAN origin in the proxy; the
    // caller's route says it is not usable, so the page must be the remote one.
    serverMock.readProxyConfig.mockResolvedValue({ ...LAN, relayDevice: "dev-1" });
    serverMock.studioAppUrl.mockReturnValue("http://127.0.0.1:8788/");
    webMock.WebMode.open.mockResolvedValue(undefined);

    await expect(openStudio({ preferRelay: true })).resolves.toEqual({ kind: "native" });
    expect(webMock.WebMode.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://reasonix.io/remote/?device=dev-1", viaProxy: false }),
    );
  });

  it("keeps the LAN door when no cloud device is known", async () => {
    serverMock.readProxyConfig.mockResolvedValue({ ...LAN, relayDevice: "" });
    serverMock.studioAppUrl.mockReturnValue("http://127.0.0.1:8788/");
    webMock.WebMode.open.mockResolvedValue(undefined);

    await expect(openStudio({ preferRelay: true })).resolves.toEqual({ kind: "native" });
    expect(webMock.WebMode.open).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://127.0.0.1:8788/" }),
    );
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
