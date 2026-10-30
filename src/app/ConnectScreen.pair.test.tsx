import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ConnectScreen } from "./ConnectScreen";
import { configureProxy, probeUpstream, ProxyError, readProxyConfig } from "../net/server";
import type { ProxyConfig } from "../net/server";
import type { LinkError } from "../net/link";
import { NativePair } from "../native/pair";

/**
 * The Android pairing path: a scanned code goes through the hidden share page
 * first, and the direct exchange is what catches the cases that page cannot.
 */
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })), exitApp: vi.fn() },
}));
vi.mock("@capacitor/network", () => ({
  Network: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));
vi.mock("@capacitor/browser", () => ({ Browser: { open: vi.fn(async () => {}) } }));
vi.mock("@capacitor/clipboard", () => ({ Clipboard: { read: vi.fn() } }));
vi.mock("@capacitor/barcode-scanner", () => ({
  CapacitorBarcodeScanner: { scanBarcode: vi.fn() },
  CapacitorBarcodeScannerCameraDirection: { BACK: "BACK" },
  CapacitorBarcodeScannerScanOrientation: { ADAPTIVE: "ADAPTIVE" },
  CapacitorBarcodeScannerTypeHint: { ALL: "ALL" },
}));
vi.mock("../native/login", () => ({ NativeLogin: { open: vi.fn(async () => {}) } }));
vi.mock("../native/pair", () => ({ NativePair: { pair: vi.fn() } }));
vi.mock("../native/turn", () => ({
  loadBackgroundStatus: vi.fn(async () => null),
  openBatterySettings: vi.fn(),
  openNotificationSettings: vi.fn(),
}));
vi.mock("../net/relayStore", () => ({ clearRelayDevice: vi.fn() }));
vi.mock("../net/fleet", () => ({ forgetFleetPeer: vi.fn(async () => {}) }));
vi.mock("../net/relay", () => ({
  clearRelayRouting: vi.fn(),
  connectRelay: vi.fn(),
  RelayError: class RelayError extends Error {
    readonly kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  },
}));
vi.mock("../net/server", () => ({
  readProxyConfig: vi.fn(),
  configureProxy: vi.fn(),
  refreshProxy: vi.fn(),
  listRemoteDevices: vi.fn(),
  markRelay: vi.fn(),
  clearRelay: vi.fn(),
  signOutAccount: vi.fn(),
  signInAccount: vi.fn(),
  approveDevice: vi.fn(),
  startAccount: vi.fn(),
  pollAccount: vi.fn(),
  parseServerLink: vi.fn(),
  probeUpstream: vi.fn(),
  ProxyError: class ProxyError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string) {
      super(code);
      this.status = status;
      this.code = code;
    }
  },
}));

const first = "http://192.168.5.3:51900";
const second = "http://192.168.5.42:8591";

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    origin: first,
    candidates: [first],
    paired: true,
    mode: "lan",
    account: { signedIn: false },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let onConnected: Mock<() => void>;
let onFailed: Mock<(error: LinkError) => void>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
  onConnected = vi.fn<() => void>();
  onFailed = vi.fn<(error: LinkError) => void>();
  vi.clearAllMocks();
  vi.mocked(readProxyConfig).mockResolvedValue(config());
  vi.mocked(configureProxy).mockImplementation(async (origin) => config({ origin }));
  vi.mocked(probeUpstream).mockResolvedValue({ ok: true });
  vi.mocked(NativePair.pair).mockResolvedValue({ paired: false, reason: "timeout" });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
});

async function renderScreen(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(<ConnectScreen onConnected={onConnected} onFailed={onFailed} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  return act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function pairAt(origin: string, code: string): Promise<void> {
  const inputs = container.querySelectorAll("details.manual-group input");
  await typeInto(inputs[0] as HTMLInputElement, origin);
  await typeInto(inputs[1] as HTMLInputElement, code);
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "连接",
  );
  if (!button) throw new Error("no connect button");
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ConnectScreen native pairing", () => {
  it("exchanges the code directly when the hidden page never reports a cookie", async () => {
    await renderScreen();

    await pairAt(second, "code-1");

    expect(NativePair.pair).toHaveBeenCalledWith({
      url: `${second}/#pair=code-1`,
      origin: second,
    });
    expect(configureProxy).toHaveBeenCalledWith(second, "code-1");
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("adopts the native page's successful pairing", async () => {
    vi.mocked(NativePair.pair).mockResolvedValue({ paired: true, reason: "paired" });
    await renderScreen();

    await pairAt(second, "code-1");

    expect(configureProxy).toHaveBeenCalledWith(second);
    expect(configureProxy).not.toHaveBeenCalledWith(second, "code-1");
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("falls back when the native bridge itself fails", async () => {
    vi.mocked(NativePair.pair).mockRejectedValue(new Error("bridge missing"));
    await renderScreen();

    await pairAt(second, "code-1");

    expect(configureProxy).toHaveBeenCalledWith(second, "code-1");
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("does not spend a code the person cancelled", async () => {
    vi.mocked(NativePair.pair).mockResolvedValue({ paired: false, reason: "cancelled" });
    await renderScreen();

    await pairAt(second, "code-1");

    expect(configureProxy).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("配对没有完成");
  });

  it("adopts a cookie the page left after spending the code", async () => {
    vi.mocked(configureProxy).mockImplementation(async (origin, code) => {
      if (code) throw new ProxyError(403, "device.pairing_invalid");
      return config({ origin });
    });
    await renderScreen();

    await pairAt(second, "code-1");

    expect(configureProxy).toHaveBeenNthCalledWith(1, second, "code-1");
    expect(configureProxy).toHaveBeenNthCalledWith(2, second);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("配对码已失效");
  });

  it("names an address that is not the share listener", async () => {
    vi.mocked(configureProxy).mockRejectedValue(new ProxyError(404, "device.pair_route_missing"));
    await renderScreen();

    await pairAt(second, "code-1");

    expect(container.textContent).toContain("不是局域网配对端口");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("keeps a code a network failure did not spend", async () => {
    vi.mocked(configureProxy).mockRejectedValue(new ProxyError(502, "device.pair_unreachable"));
    await renderScreen();

    await pairAt(second, "code-1");

    const inputs = container.querySelectorAll("details.manual-group input");
    expect((inputs[1] as HTMLInputElement).value).toBe("code-1");
    expect(container.textContent).toContain("到不了这台电脑");
  });

  it("restores the working computer when the new one cannot be read", async () => {
    vi.mocked(configureProxy).mockImplementation(async (origin, code) => {
      if (code) throw new ProxyError(403, "device.pairing_invalid");
      return config({ origin });
    });
    vi.mocked(probeUpstream)
      .mockResolvedValueOnce({ ok: false, code: "device.unauthorized" })
      .mockResolvedValueOnce({ ok: true });
    await renderScreen();

    await pairAt(second, "code-1");

    expect(configureProxy).toHaveBeenLastCalledWith(first);
    expect(onConnected).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(container.textContent).toContain("配对码已失效");
  });

  it("reports a failed link when the old computer no longer answers", async () => {
    vi.mocked(configureProxy).mockImplementation(async (origin, code) => {
      if (code) throw new ProxyError(403, "device.pairing_invalid");
      return config({ origin });
    });
    vi.mocked(probeUpstream).mockResolvedValue({ ok: false, code: "device.unauthorized" });
    await renderScreen();

    await pairAt(second, "code-1");

    expect(configureProxy).toHaveBeenLastCalledWith(first);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
  });
});
