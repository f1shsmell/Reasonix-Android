import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { ConnectScreen } from "./ConnectScreen";
import {
  clearRelay,
  configureProxy,
  listRemoteDevices,
  markRelay,
  readProxyConfig,
  signOutAccount,
} from "../net/server";
import type { ProxyConfig, RemoteDevice } from "../net/server";
import { connectRelay, clearRelayRouting } from "../net/relay";
import { clearRelayDevice } from "../net/relayStore";

/**
 * ConnectScreen is the only place a phone can acquire a kernel, and the only
 * place a failed acquisition explains itself. These tests drive it in the
 * browser path (Capacitor reports non-native) so no Activity is involved.
 */
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })), exitApp: vi.fn() },
}));
vi.mock("@capacitor/network", () => ({
  Network: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));
vi.mock("@capacitor/browser", () => ({ Browser: { open: vi.fn() } }));
vi.mock("@capacitor/clipboard", () => ({ Clipboard: { read: vi.fn() } }));
vi.mock("@capacitor/barcode-scanner", () => ({
  CapacitorBarcodeScanner: { scanBarcode: vi.fn() },
  CapacitorBarcodeScannerCameraDirection: { BACK: "BACK" },
  CapacitorBarcodeScannerScanOrientation: { ADAPTIVE: "ADAPTIVE" },
  CapacitorBarcodeScannerTypeHint: { ALL: "ALL" },
}));
vi.mock("../native/login", () => ({ NativeLogin: { open: vi.fn() } }));
vi.mock("../native/pair", () => ({ NativePair: { pair: vi.fn() } }));
vi.mock("../net/relayStore", () => ({ clearRelayDevice: vi.fn() }));
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
  startAccount: vi.fn(),
  pollAccount: vi.fn(),
  parseServerLink: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root | null = null;
let onConnected: Mock<() => void>;

function config(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    origin: "http://192.168.5.2:56789",
    candidates: ["http://192.168.5.2:56789"],
    paired: true,
    mode: "lan",
    account: { signedIn: false },
    ...overrides,
  };
}

function device(overrides: Partial<RemoteDevice> = {}): RemoteDevice {
  return { id: "dev1", name: "DESKTOP", platform: "windows", capabilities: ["desktop"], ...overrides };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  onConnected = vi.fn<() => void>();
  vi.clearAllMocks();
  vi.mocked(readProxyConfig).mockResolvedValue(config());
  vi.mocked(configureProxy).mockResolvedValue(config());
  vi.mocked(listRemoteDevices).mockResolvedValue([]);
  vi.mocked(clearRelay).mockResolvedValue(config());
  vi.mocked(signOutAccount).mockResolvedValue({ signedIn: false });
  vi.mocked(markRelay).mockResolvedValue(config({ mode: "relay", relayDevice: "dev1" }));
  vi.mocked(connectRelay).mockResolvedValue({
    close: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof connectRelay>>);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
});

async function renderScreen(onClose?: () => void): Promise<void> {
  act(() => root?.unmount());
  root = createRoot(container);
  await act(async () => {
    root?.render(
      onClose ? (
        <ConnectScreen onConnected={onConnected} onClose={onClose} />
      ) : (
        <ConnectScreen onConnected={onConnected} />
      ),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`no button labelled ${text}`);
  return found;
}

function press(text: string): Promise<void> {
  return act(async () => {
    button(text).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ConnectScreen", () => {
  it("fills the remembered origin and connects without a code", async () => {
    await renderScreen();

    const origin = container.querySelector("input") as HTMLInputElement;
    expect(origin.value).toMatch(/^http:\/\/192\.168\.5\.2:\d+$/);

    await press("连接");

    expect(configureProxy).toHaveBeenCalledWith("http://192.168.5.2:56789", undefined);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("keeps the address and the refused code in a pairing error", async () => {
    vi.mocked(configureProxy).mockRejectedValue(new Error("device.pairing_invalid"));
    await renderScreen();

    await press("连接");

    expect(container.textContent).toContain("配对码已失效");
    expect(container.textContent).toContain("http://192.168.5.2:56789");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("turns a cloud device press into a relay connection and a saved mode", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true, user: { label: "me" } } }),
    );
    vi.mocked(listRemoteDevices).mockResolvedValue([device()]);
    await renderScreen();

    await press("DESKTOP · windows");

    expect(connectRelay).toHaveBeenCalledWith("dev1");
    expect(markRelay).toHaveBeenCalledWith("dev1");
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("disables a cloud device that has not enabled remote access", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true, user: { label: "me" } } }),
    );
    vi.mocked(listRemoteDevices).mockResolvedValue([device({ capabilities: [] })]);
    await renderScreen();

    const row = button("DESKTOP · windows（未开启远程访问）");
    expect(row.disabled).toBe(true);
    expect(connectRelay).not.toHaveBeenCalled();
  });

  it("does not tear down a working relay when a cloud attempt cannot open", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true, user: { label: "me" } } }),
    );
    vi.mocked(listRemoteDevices).mockResolvedValue([device()]);
    vi.mocked(connectRelay).mockRejectedValue(new Error("relay down"));
    await renderScreen();

    await press("DESKTOP · windows");

    expect(clearRelayRouting).not.toHaveBeenCalled();
  });

  it("clears the relay hint when signing out", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true, user: { label: "me" } } }),
    );
    await renderScreen();

    await press("退出登录");

    expect(signOutAccount).toHaveBeenCalled();
    expect(clearRelayDevice).toHaveBeenCalled();
    expect(clearRelay).toHaveBeenCalled();
  });

  it("offers a back control only when it has somewhere to go", async () => {
    const onClose = vi.fn();
    await renderScreen(onClose);
    await press("←");
    expect(onClose).toHaveBeenCalledTimes(1);

    await renderScreen();
    expect(container.querySelector('button[aria-label="返回"]')).toBeNull();
  });
});
