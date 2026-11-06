import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { Browser } from "@capacitor/browser";
import { ConnectScreen } from "./ConnectScreen";
import {
  approveDevice,
  clearRelay,
  configureProxy,
  disconnectProxy,
  listRemoteDevices,
  markRelay,
  probeUpstream,
  readProxyConfig,
  signInAccount,
  signOutAccount,
  startAccount,
  ProxyError,
} from "../net/server";
import type { DeviceGrant, ProxyConfig, RemoteDevice } from "../net/server";
import { RequestTimeout } from "../net/http";
import { WebMode } from "../native/webmode";
import {
  studioAppUrl,
  studioWebUrl,
} from "../net/server";
import { forgetFleetPeer } from "../net/fleet";
import { connectRelay, clearRelayRouting, RelayError } from "../net/relay";
import { clearRelayDevice } from "../net/relayStore";
import { deviceFingerprint, pinDevice, trustedDevice } from "../net/deviceTrust";
import {
  loadBackgroundStatus,
  openBatterySettings,
  openNotificationSettings,
} from "../native/turn";
import { loadConnections, rememberConnection } from "../net/savedConnections";
import { loadHaptics } from "./haptics";
import { idleLink } from "../net/link";
import type { LinkError, LinkState } from "../net/link";

/**
 * ConnectScreen is the only place a phone can acquire a kernel, and the only
 * place a failed acquisition explains itself. These tests drive it in the
 * browser path (Capacitor reports non-native) so no Activity is involved.
 */
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })), exitApp: vi.fn() },
}));
vi.mock("../native/networkWatch", () => ({
  readNetworkStatus: vi.fn(async () => null),
  onNetworkChange: vi.fn(async () => ({ remove: vi.fn() })),
}));
vi.mock("@capacitor/browser", () => ({ Browser: { open: vi.fn(async () => {}) } }));
vi.mock("@capacitor/clipboard", () => ({ Clipboard: { read: vi.fn(), write: vi.fn(async () => {}) } }));
vi.mock("@capacitor/barcode-scanner", () => ({
  CapacitorBarcodeScanner: { scanBarcode: vi.fn() },
  CapacitorBarcodeScannerCameraDirection: { BACK: "BACK" },
  CapacitorBarcodeScannerScanOrientation: { ADAPTIVE: "ADAPTIVE" },
  CapacitorBarcodeScannerTypeHint: { ALL: "ALL" },
}));
vi.mock("../native/login", () => ({ NativeLogin: { open: vi.fn(async () => {}) } }));
vi.mock("../native/pair", () => ({ NativePair: { pair: vi.fn() } }));
vi.mock("../native/webmode", () => ({ WebMode: { open: vi.fn(async () => {}) } }));
vi.mock("../native/turn", () => ({
  loadBackgroundStatus: vi.fn(async () => null),
  openBatterySettings: vi.fn(),
  openNotificationSettings: vi.fn(),
}));
vi.mock("../native/update", () => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  launchInstaller: vi.fn(),
  onUpdateProgress: vi.fn(async () => ({ remove: vi.fn() })),
}));
vi.mock("../net/relayStore", () => ({ clearRelayDevice: vi.fn(), loadRelayDevice: vi.fn(() => null) }));
vi.mock("../net/fleet", () => ({ forgetFleetPeer: vi.fn(async () => {}) }));
vi.mock("../net/relay", () => ({
  clearRelayRouting: vi.fn(),
  connectRelay: vi.fn(),
  prefetchGrant: vi.fn(),
  RelayError: class MockRelayError extends Error {
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
  disconnectProxy: vi.fn(),
  signOutAccount: vi.fn(),
  signInAccount: vi.fn(),
  approveDevice: vi.fn(),
  startAccount: vi.fn(),
  pollAccount: vi.fn(),
  parseServerLink: vi.fn(),
  studioWebUrl: vi.fn(() => ""),
  studioAppUrl: vi.fn(() => ""),
  probeUpstream: vi.fn(),
  readMachineIdentity: vi.fn(async () => null),
  ProxyError: class MockProxyError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string) {
      super(code);
      this.status = status;
      this.code = code;
    }
  },
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

function grant(overrides: Partial<DeviceGrant> = {}): DeviceGrant {
  return {
    deviceCode: "device-code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://reasonix.io/device",
    verificationUriComplete: "https://reasonix.io/device?code=ABCD-EFGH",
    interval: 5,
    expiresIn: 600,
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
  onConnected = vi.fn<() => void>();
  vi.clearAllMocks();
  vi.mocked(readProxyConfig).mockResolvedValue(config());
  vi.mocked(loadBackgroundStatus).mockResolvedValue(null);
  vi.mocked(configureProxy).mockResolvedValue(config());
  vi.mocked(listRemoteDevices).mockResolvedValue([]);
  vi.mocked(probeUpstream).mockResolvedValue({ ok: true });
  vi.mocked(clearRelay).mockResolvedValue(config());
  vi.mocked(signOutAccount).mockResolvedValue({ signedIn: false });
  vi.mocked(signInAccount).mockResolvedValue({ signedIn: true });
  vi.mocked(approveDevice).mockResolvedValue(undefined);
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

async function renderScreen(
  onClose?: () => void,
  props: {
    onFailed?: (error: LinkError) => void;
    link?: LinkState;
  } = {},
): Promise<void> {
  act(() => root?.unmount());
  root = createRoot(container);
  await act(async () => {
    root?.render(
      onClose ? (
        <ConnectScreen onConnected={onConnected} onClose={onClose} {...props} />
      ) : (
        <ConnectScreen onConnected={onConnected} {...props} />
      ),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function button(text: string): HTMLButtonElement {
  const matches = Array.from(container.querySelectorAll("button")).filter(
    (candidate) => candidate.textContent?.trim() === text,
  );
  // The settings tabs also carry one-word labels; an action with the same
  // name is never the tab.
  const found = matches.find((candidate) => !candidate.closest(".settings-tabs")) ?? matches[0];
  if (!found) throw new Error(`no button labelled ${text}`);
  return found;
}

/** A row whose label and subtitle are two lines: match on both. */
function row(...parts: string[]): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((candidate) => {
    const text = candidate.textContent ?? "";
    return parts.every((part) => text.includes(part));
  });
  if (!found) throw new Error(`no row containing ${parts.join(" + ")}`);
  return found;
}

function press(text: string): Promise<void> {
  return act(async () => {
    button(text).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pressRow(...parts: string[]): Promise<void> {
  return act(async () => {
    row(...parts).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Type into a controlled input the way React sees a real keystroke. */
function typeInto(selector: string, value: string): Promise<void> {
  return act(async () => {
    const input = container.querySelector(selector) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

/** Drive a touch drag through the DOM, the way a finger would. */




/** jsdom has no PointerEvent; React only reads the fields the row uses. */
function pointer(node: Element, type: string, x: number, y: number): void {
  act(() => {
    node.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
}

/** A still press long enough for the row to be picked up. */
function hold(node: Element, x: number, y: number): void {
  pointer(node, "pointerdown", x, y);
  act(() => {
    vi.advanceTimersByTime(500);
  });
}

describe("ConnectScreen", () => {

  it("fills the remembered origin and connects without a code", async () => {
    await renderScreen();

    const origin = container.querySelector("input") as HTMLInputElement;
    expect(origin.value).toMatch(/^http:\/\/192\.168\.5\.2:\d+$/);

    await press("连接这台电脑");

    expect(configureProxy).toHaveBeenCalledWith("http://192.168.5.2:56789", undefined);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("folds the manual address fields behind a disclosure", async () => {
    await renderScreen();

    const manual = container.querySelector("details.manual-group") as HTMLDetailsElement;
    expect(manual).not.toBeNull();
    expect(manual.open).toBe(false);
    expect(manual.querySelector("summary")?.textContent).toContain("手动填写地址");
    const origin = manual.querySelector("input") as HTMLInputElement;
    expect(origin.value).toMatch(/^http:\/\/192\.168\.5\.2:\d+$/);
  });

  it("keeps the address and the refused code in a pairing error", async () => {
    vi.mocked(configureProxy).mockRejectedValue(new Error("device.pairing_invalid"));
    await renderScreen();

    await press("连接这台电脑");

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
    await press("账号");

    await pressRow("DESKTOP", "windows");

    expect(connectRelay).toHaveBeenCalledWith(
      "dev1",
      expect.objectContaining({ confirm: expect.any(Function) }),
    );
    expect(markRelay).toHaveBeenCalledWith("dev1");
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("disables a cloud device that has not enabled remote access", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true, user: { label: "me" } } }),
    );
    vi.mocked(listRemoteDevices).mockResolvedValue([device({ capabilities: [] })]);
    await renderScreen();
    await press("账号");

    const deviceRow = row("DESKTOP", "windows", "未开启");
    expect(deviceRow.disabled).toBe(true);
    expect(connectRelay).not.toHaveBeenCalled();
  });

  it("does not tear down a working relay when a cloud attempt cannot open", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true, user: { label: "me" } } }),
    );
    vi.mocked(listRemoteDevices).mockResolvedValue([device()]);
    vi.mocked(connectRelay).mockRejectedValue(new Error("relay down"));
    await renderScreen();
    await press("账号");

    await pressRow("DESKTOP", "windows");

    expect(clearRelayRouting).not.toHaveBeenCalled();
  });

  it("clears the relay hint when signing out", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true, user: { label: "me" } } }),
    );
    await renderScreen();
    await press("账号");

    await press("退出登录");

    expect(signOutAccount).toHaveBeenCalled();
    expect(clearRelayDevice).toHaveBeenCalled();
    expect(clearRelay).toHaveBeenCalled();
  });

  it("disconnects on purpose and drops the shown upstream", async () => {
    vi.mocked(disconnectProxy).mockResolvedValue(
      config({ origin: "", candidates: ["http://192.168.5.2:56789"] }),
    );
    await renderScreen();

    await press("断开连接");

    expect(disconnectProxy).toHaveBeenCalledTimes(1);
    // The saved row survives (reconnect is one tap), the network row reads
    // as disconnected, the danger button is gone with the upstream, and the
    // manual form no longer carries the old origin.
    expect(container.textContent).toContain("未连接");
    expect(container.textContent).not.toContain("断开连接");
    const origin = container.querySelector(".manual-group input") as HTMLInputElement;
    expect(origin.value).toBe("");
  });

  it("offers a back control only when it has somewhere to go", async () => {
    const onClose = vi.fn();
    await renderScreen(onClose);
    await press("←");
    expect(onClose).toHaveBeenCalledTimes(1);

    await renderScreen();
    expect(container.querySelector('button[aria-label="返回"]')).toBeNull();
  });

  describe("appearance, posture and about", () => {
    beforeEach(() => {
      localStorage.clear();
      document.documentElement.removeAttribute("data-theme");
    });

    afterEach(() => {
      document.documentElement.removeAttribute("data-theme");
      document.documentElement.removeAttribute("data-style");
    });

    async function renderPrefs(): Promise<void> {
      await renderScreen();
      await press("偏好");
    }

    it("pins a theme and remembers it", async () => {
      await renderPrefs();

      await act(async () => {
        button("深色").click();
        await Promise.resolve();
      });

      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(localStorage.getItem("reasonix.theme")).toBe("dark");
    });

    it("switches the visual language and remembers it", async () => {
      await renderPrefs();

      await act(async () => {
        button("深蓝").click();
        await Promise.resolve();
      });

      expect(document.documentElement.getAttribute("data-style")).toBe("studio");
      expect(localStorage.getItem("reasonix.ui-style")).toBe("studio");

      await act(async () => {
        button("暖纸").click();
        await Promise.resolve();
      });

      expect(document.documentElement.getAttribute("data-style")).toBe("paper");
      expect(localStorage.getItem("reasonix.ui-style")).toBeNull();
    });

    it("goes back to following the system, which is the absent attribute", async () => {
      await renderPrefs();
      await act(async () => {
        button("深色").click();
        await Promise.resolve();
      });
      await act(async () => {
        button("跟随系统").click();
        await Promise.resolve();
      });

      expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
      expect(localStorage.getItem("reasonix.theme")).toBeNull();
    });

    it("remembers where a dispatch lands", async () => {
      await renderPrefs();

      await act(async () => {
        button("不跳转").click();
        await Promise.resolve();
      });
      expect(localStorage.getItem("reasonix.dispatch-after")).toBe("stay");

      await act(async () => {
        button("派发的会话").click();
        await Promise.resolve();
      });
      expect(localStorage.getItem("reasonix.dispatch-after")).toBe("session");

      await act(async () => {
        button("最近").click();
        await Promise.resolve();
      });
      expect(localStorage.getItem("reasonix.dispatch-after")).toBeNull();
    });

    it("pins the transcript fold and remembers it", async () => {
      await renderPrefs();

      const group = container.querySelector('[aria-label="会话详略"]');
      const compact = Array.from(group?.querySelectorAll("button") ?? []).find(
        (candidate) => candidate.textContent === "精简",
      ) as HTMLButtonElement;

      await act(async () => {
        compact.click();
        await Promise.resolve();
      });

      expect(localStorage.getItem("reasonix.folding.v1")).toBe("compact");
      expect(compact.getAttribute("aria-pressed")).toBe("true");
    });

    it("remembers the vibration switch", async () => {
      await renderPrefs();

      const toggle = container.querySelector(
        '[role="switch"][aria-label="震动"]',
      ) as HTMLButtonElement;
      expect(toggle.getAttribute("aria-checked")).toBe("true");

      await act(async () => {
        toggle.click();
        await Promise.resolve();
      });

      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(loadHaptics()).toBe(false);
    });

    it("shows the version the build was given", async () => {
      await renderPrefs();
      expect(container.textContent).toContain("版本");
      // The value comes from `define`, so the test asserts it is not blank
      // rather than pinning a number that a release would change.
      const value = container.querySelector(".setting-value")?.textContent ?? "";
      expect(value.trim()).not.toBe("");
    });

  });
});

describe("ConnectScreen saved connections", () => {
  it("records the current computer and marks it", async () => {
    await renderScreen();

    expect(container.textContent).toContain("已连接的电脑");
    const current = row("192.168.5.2:56789", "当前");
    expect(current).toBeTruthy();
    // The proxy's own origin is a record worth keeping even before a scan.
    expect(JSON.parse(localStorage.getItem("reasonix.connections.v1") ?? "[]")).toHaveLength(1);
  });

  it("switches to a saved computer with no code", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    await renderScreen();

    await pressRow("192.168.9.9:51234");
    expect(configureProxy).toHaveBeenCalledWith("http://192.168.9.9:51234", undefined);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("names the door this phone can reach directly", async () => {
    // One computer, two addresses: the Wi-Fi one is a neighbour, the mesh-VPN
    // one is only reachable through the tunnel. Both are saved rows, and the
    // person has to be able to tell which is the fast one.
    rememberConnection("lan", "http://172.16.2.59:57074");
    rememberConnection("lan", "http://192.168.5.3:57074");
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({
        origin: "http://192.168.5.3:57074",
        candidates: ["http://172.16.2.59:57074", "http://192.168.5.3:57074"],
        preferred: ["http://192.168.5.3:57074", "http://172.16.2.59:57074"],
        direct: ["http://192.168.5.3:57074"],
      }),
    );

    await renderScreen();

    const direct = row("192.168.5.3:57074");
    const tunnel = row("172.16.2.59:57074");
    expect(direct?.textContent).toContain("可直连");
    expect(tunnel?.textContent).not.toContain("可直连");
  });

  it("says nothing about directness when the proxy named no order", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    await renderScreen();

    // A browser dev session has no interfaces to judge, so no row claims to
    // be the direct one.
    expect(container.textContent).not.toContain("可直连");
  });

  it("reorders the saved computers with a held drag", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    await renderScreen();
    vi.useFakeTimers();

    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-drag-key]"));
    rows.forEach((node, index) => {
      node.getBoundingClientRect = () =>
        ({
          top: index * 60,
          bottom: index * 60 + 60,
          height: 60,
          left: 0,
          right: 320,
          width: 320,
          x: 0,
          y: index * 60,
          toJSON: () => ({}),
        }) as DOMRect;
    });
    // The row saved before the screen opened keeps the first slot; the
    // proxy's own origin was appended when the screen read it.
    expect(rows[0]?.getAttribute("data-drag-key")).toBe("lan:http://192.168.9.9:51234");
    const moving = rows[1] as HTMLElement;

    hold(moving, 160, 70);
    pointer(moving, "pointermove", 160, 10);
    pointer(moving, "pointerup", 160, 10);
    vi.useRealTimers();

    // The order is the retry order, so it has to reach storage rather than
    // live only in the screen that drew it.
    expect(loadConnections().map((entry) => entry.target)).toEqual([
      "http://192.168.5.2:56789",
      "http://192.168.9.9:51234",
    ]);
  });

  it("drags a computer and its doors as one block", async () => {
    // The drag key sits on the wrapper so a computer with doors is measured at
    // its real height; the drop indicator would otherwise land short. Moving
    // the wrapper has to carry both doors with it.
    rememberConnection("lan", "http://192.168.5.3:57074", "工作台", "studio-pc");
    rememberConnection("cloud", "dev1", "工作台", "studio-pc");
    await renderScreen();
    vi.useFakeTimers();

    const groups = Array.from(container.querySelectorAll<HTMLElement>("[data-drag-key]"));
    groups.forEach((node, index) => {
      node.getBoundingClientRect = () =>
        ({
          top: index * 120,
          bottom: index * 120 + 120,
          height: 120,
          left: 0,
          right: 320,
          width: 320,
          x: 0,
          y: index * 120,
          toJSON: () => ({}),
        }) as DOMRect;
    });

    // One wrapper for the computer, listing both doors inside it.
    const studio = groups.find(
      (node) => node.getAttribute("data-drag-key") === "machine:studio-pc",
    );
    expect(studio).toBeTruthy();
    expect(studio?.querySelectorAll(".saved-row.door")).toHaveLength(2);

    const moving = studio as HTMLElement;
    hold(moving, 160, 130);
    pointer(moving, "pointermove", 160, 10);
    pointer(moving, "pointerup", 160, 10);
    vi.useRealTimers();

    // Both doors travelled together: one computer, one block.
    const rows = loadConnections();
    expect(rows.filter((saved) => saved.machine === "studio-pc")).toHaveLength(2);
  });

  it("asks before removing a saved computer", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    await renderScreen();

    act(() => {
      (
        container.querySelector('[aria-label="移除 192.168.9.9:51234"]') as HTMLButtonElement
      ).click();
    });

    expect(container.textContent).toContain("移除这台电脑？");
    expect(loadConnections().some((entry) => entry.target === "http://192.168.9.9:51234")).toBe(
      true,
    );

    await press("取消");

    expect(container.textContent).not.toContain("移除这台电脑？");
    expect(loadConnections().some((entry) => entry.target === "http://192.168.9.9:51234")).toBe(
      true,
    );
    expect(forgetFleetPeer).not.toHaveBeenCalled();
  });

  it("forgets a saved computer without touching the rest", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    await renderScreen();

    act(() => {
      (
        container.querySelector('[aria-label="移除 192.168.9.9:51234"]') as HTMLButtonElement
      ).click();
    });
    await press("移除");

    expect(container.textContent).not.toContain("192.168.9.9:51234");
    expect(container.textContent).toContain("192.168.5.2:56789");
    expect(forgetFleetPeer).toHaveBeenCalledWith("lan", "http://192.168.9.9:51234");
  });

  it("drops the link when the computer it is connected to is removed", async () => {
    // Removing the live computer has to disconnect as well. Every `connected()`
    // records the target again, so a removal that left the link up would be
    // undone by the next reconnect — the row would simply come back.
    vi.mocked(disconnectProxy).mockResolvedValue(config({ origin: "", candidates: [] }));
    rememberConnection("lan", "http://192.168.5.2:56789");
    await renderScreen();

    act(() => {
      (
        container.querySelector('[aria-label="移除 192.168.5.2:56789"]') as HTMLButtonElement
      ).click();
    });
    await press("移除");

    expect(disconnectProxy).toHaveBeenCalledTimes(1);
    // The row is gone from the list even though the link teardown is still in
    // flight; the saved list is written synchronously by the confirm.
    expect(container.textContent).not.toContain("移除 192.168.5.2:56789");
  });

  it("leaves the link alone when a different computer is removed", async () => {
    // The row being removed is not the one in use, so tearing the link down
    // would disconnect a working session for no reason.
    rememberConnection("lan", "http://192.168.9.9:51234");
    await renderScreen();

    act(() => {
      (
        container.querySelector('[aria-label="移除 192.168.9.9:51234"]') as HTMLButtonElement
      ).click();
    });
    await press("移除");

    expect(disconnectProxy).not.toHaveBeenCalled();
  });

  it("lists each address of one computer, so one can go without the other", async () => {
    // A LAN origin and a cloud id for the same machine are two doors. Removing
    // the computer because one address went stale would drop a route that
    // still works, so each door carries its own ×.
    rememberConnection("lan", "http://192.168.5.3:57074", "工作台", "studio-pc");
    rememberConnection("cloud", "dev1", "工作台", "studio-pc");
    await renderScreen();

    // Both doors are listed with their own control, so one can go alone.
    const lan = container.querySelector('[aria-label="移除 局域网 · http://192.168.5.3:57074"]');
    const cloud = container.querySelector('[aria-label="移除 云端 · Reasonix 账号"]');
    expect(lan).toBeTruthy();
    expect(cloud).toBeTruthy();
    // The computer's own row carries no ×: there is nothing to forget there
    // without choosing a door. The drag key lives on the group wrapper now, so
    // the row is what sits under it without the door class.
    const group = container.querySelector('.saved-group[data-drag-key="machine:studio-pc"]');
    expect(group).toBeTruthy();
    expect(group?.querySelector(".setting.saved-row:not(.door) .saved-forget")).toBeNull();
  });

  it("keeps the other address when one door of a computer is removed", async () => {
    rememberConnection("lan", "http://192.168.5.3:57074", "工作台", "studio-pc");
    rememberConnection("cloud", "dev1", "工作台", "studio-pc");
    await renderScreen();

    act(() => {
      (
        container.querySelector(
          '[aria-label="移除 局域网 · http://192.168.5.3:57074"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(container.textContent).toContain("移除这个地址？");
    await press("移除");

    // The cloud door survives, and it is still the same computer.
    expect(container.textContent).toContain("云端 · Reasonix 账号");
    expect(container.textContent).not.toContain("192.168.5.3:57074");
    expect(disconnectProxy).not.toHaveBeenCalled();
  });

  it("forgets a removed cloud computer's identity along with the row", async () => {
    const key = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    const print = await deviceFingerprint(key);
    pinDevice({ id: "dev1", publicKey: key, fingerprint: print?.full ?? "" });
    rememberConnection("cloud", "dev1", "工作室的电脑");
    await renderScreen();

    act(() => {
      (container.querySelector('[aria-label="移除 工作室的电脑"]') as HTMLButtonElement).click();
    });
    await press("移除");

    expect(trustedDevice("dev1")).toBeNull();
    expect(container.textContent).not.toContain("工作室的电脑");
    expect(forgetFleetPeer).toHaveBeenCalledWith("cloud", "dev1");
  });

  it("asks for an account before using a cloud row", async () => {
    rememberConnection("cloud", "dev1", "工作室的电脑");
    await renderScreen();

    await pressRow("工作室的电脑", "云端");

    expect(container.textContent).toContain("先登录 Reasonix 账号");
    expect(connectRelay).not.toHaveBeenCalled();
  });

  it("uses the computer name the account reports for a cloud row", async () => {
    rememberConnection("cloud", "dev1");
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true } }),
    );
    vi.mocked(listRemoteDevices).mockResolvedValue([device({ name: "楼下的台式机" })]);
    await renderScreen();

    expect(container.textContent).toContain("楼下的台式机");
  });
});

describe("ConnectScreen account sign-in", () => {
  it("shows the code request beside the account button while it waits", async () => {
    let finish: (value: DeviceGrant) => void = () => {};
    vi.mocked(startAccount).mockImplementation(
      () =>
        new Promise<DeviceGrant>((resolve) => {
          finish = resolve;
        }),
    );
    await renderScreen();
    await press("账号");

    await press("登录 Reasonix 账号");

    expect(button("正在获取登录码…").disabled).toBe(true);
    expect(container.querySelector(".account-busy")?.textContent).toContain("最多等 25 秒");

    await act(async () => {
      finish(grant());
      await Promise.resolve();
    });

    // The fast path opens a form, not the slow sign-in page.
    expect(container.querySelector('input[type="email"]')).not.toBeNull();
    expect(button("登录并批准").disabled).toBe(true);
    expect(Browser.open).not.toHaveBeenCalled();
    expect(container.querySelector(".account-busy")).toBeNull();
  });

  it("signs in with the account form and approves the code", async () => {
    vi.mocked(startAccount).mockResolvedValue(grant());
    await renderScreen();
    await press("账号");

    await press("登录 Reasonix 账号");
    await typeInto('input[type="email"]', "me@example.com");
    await typeInto('input[type="password"]', "secret123");
    await press("登录并批准");

    expect(signInAccount).toHaveBeenCalledWith("me@example.com", "secret123");
    expect(approveDevice).toHaveBeenCalledWith("ABCD-EFGH");
    expect(container.textContent).toContain("已批准，正在完成登录");
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it("keeps the form after a wrong password", async () => {
    vi.mocked(startAccount).mockResolvedValue(grant());
    vi.mocked(signInAccount).mockRejectedValue(new ProxyError(401, "invalid_credentials"));
    await renderScreen();
    await press("账号");

    await press("登录 Reasonix 账号");
    await typeInto('input[type="email"]', "me@example.com");
    await typeInto('input[type="password"]', "wrongpass");
    await press("登录并批准");

    expect(approveDevice).not.toHaveBeenCalled();
    expect(container.querySelector(".account-notice")?.textContent).toContain("邮箱或密码不正确");
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it("explains a timeout next to the login button, not above the fold", async () => {
    vi.mocked(startAccount).mockRejectedValue(new RequestTimeout(25_000));
    await renderScreen();
    await press("账号");

    await press("登录 Reasonix 账号");

    const notice = container.querySelector(".account-notice");
    expect(notice?.textContent).toContain("id.reasonix.io");
    expect(notice?.textContent).toContain("换 Wi‑Fi/流量");
    expect(notice?.textContent).toContain("蒲公英");
  });

  it("names the service when the phone cannot reach it", async () => {
    vi.mocked(startAccount).mockRejectedValue(new ProxyError(502, "proxy.upstream_unreachable"));
    await renderScreen();
    await press("账号");

    await press("登录 Reasonix 账号");

    expect(container.querySelector(".account-notice")?.textContent).toContain(
      "手机连不上登录服务",
    );
  });
});

describe("ConnectScreen hero", () => {
  it("shows the link machine's stage", async () => {
    await renderScreen(undefined, {
      link: {
        ...idleLink,
        phase: "connecting",
        step: "verify",
        completed: ["probe", "switch"],
      },
    });

    expect(container.querySelector(".link-hero-sub")?.textContent).toBe("正在读取会话…");
    expect(container.querySelectorAll(".link-steps li")).toHaveLength(3);
  });

  it("names the cloud computer while the proxy still points at the LAN", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true, user: { label: "me" } } }),
    );
    vi.mocked(listRemoteDevices).mockResolvedValue([device()]);
    vi.mocked(connectRelay).mockImplementation(() => new Promise(() => {}));
    await renderScreen();
    await press("账号");

    await pressRow("DESKTOP", "windows");

    expect(container.querySelector(".link-hero-title")?.textContent).toBe("DESKTOP");
    expect(container.querySelector(".link-hero-sub")?.textContent).toBe("正在连接云端…");
  });
});

describe("ConnectScreen background", () => {
  it("reports the two system permissions and opens their pages", async () => {
    vi.mocked(loadBackgroundStatus).mockResolvedValue({ exempt: false, notifications: true });
    await renderScreen();
    await press("偏好");

    expect(container.textContent).toContain("后台运行");
    expect(container.textContent).toContain("已开启");
    expect(container.textContent).toContain("受限");

    await pressRow("通知", "已开启");
    await pressRow("电池优化", "受限");

    expect(openNotificationSettings).toHaveBeenCalledTimes(1);
    expect(openBatterySettings).toHaveBeenCalledTimes(1);
  });

  it("hides the group when the native side cannot answer", async () => {
    await renderScreen();
    expect(container.textContent).not.toContain("后台运行");
  });
});

describe("ConnectScreen first trust", () => {
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function signedInWithDevice(): void {
    vi.mocked(readProxyConfig).mockResolvedValue(
      config({ account: { signedIn: true, user: { label: "me" } } }),
    );
    vi.mocked(listRemoteDevices).mockResolvedValue([device()]);
  }

  /** A relay that really waits for the person, the way `checkDeviceTrust` does. */
  function awaitingTrust(): void {
    vi.mocked(connectRelay).mockImplementation(async (id, options) => {
      const accepted = await options?.confirm?.({ id, fingerprint: "a1b2 c3d4 e5f6 7890" });
      if (!accepted) throw new RelayError("trust_cancelled", "已取消确认这台电脑的身份。");
      return { close: vi.fn() } as unknown as Awaited<ReturnType<typeof connectRelay>>;
    });
  }

  /** Cloud devices live on the account pane; every test below starts there. */
  async function renderAccount(): Promise<void> {
    await renderScreen();
    await press("账号");
  }

  it("shows the fingerprint before the first cloud connection", async () => {
    signedInWithDevice();
    awaitingTrust();
    await renderAccount();

    await pressRow("DESKTOP", "windows");

    expect(container.querySelector(".trust-sheet")?.textContent).toContain("a1b2 c3d4 e5f6 7890");
    expect(container.querySelector(".trust-sheet")?.textContent).toContain("DESKTOP");

    await press("信任并连接");
    await settle();

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".trust-sheet")).toBeNull();
  });

  it("leaves the relay alone when the person declines", async () => {
    signedInWithDevice();
    awaitingTrust();
    await renderAccount();

    await pressRow("DESKTOP", "windows");
    await press("取消");
    await settle();

    expect(onConnected).not.toHaveBeenCalled();
    expect(clearRelayRouting).not.toHaveBeenCalled();
    expect(container.querySelector(".trust-sheet")).toBeNull();
    expect(container.querySelector(".notice.error")).toBeNull();
  });

  it("says why a changed fingerprint was refused", async () => {
    signedInWithDevice();
    vi.mocked(connectRelay).mockRejectedValue(
      new RelayError("trust_changed", "这台电脑的身份指纹和上次不同，连接已拒绝。"),
    );
    await renderAccount();

    await pressRow("DESKTOP", "windows");
    await settle();

    expect(container.textContent).toContain("身份指纹和上次不同");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("offers an explicit reset when the fingerprint changed", async () => {
    signedInWithDevice();
    let calls = 0;
    vi.mocked(connectRelay).mockImplementation(async (id, options) => {
      calls += 1;
      if (calls === 1) throw new RelayError("trust_changed", "这台电脑的身份指纹和上次不同，连接已拒绝。");
      const accepted = await options?.confirm?.({ id, fingerprint: "ffff 0000 1111 2222" });
      if (!accepted) throw new RelayError("trust_cancelled", "已取消确认这台电脑的身份。");
      return { close: vi.fn() } as unknown as Awaited<ReturnType<typeof connectRelay>>;
    });
    await renderAccount();

    await pressRow("DESKTOP", "windows");
    await settle();

    expect(container.textContent).toContain("身份指纹和上次不同");

    await press("这台电脑重装过，重新确认它的身份");
    expect(container.querySelector(".trust-sheet")?.textContent).toContain("ffff 0000 1111 2222");

    await press("信任并连接");
    await settle();

    expect(connectRelay).toHaveBeenCalledTimes(2);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("resolves a pending prompt when the screen goes away", async () => {
    signedInWithDevice();
    awaitingTrust();
    await renderAccount();

    await pressRow("DESKTOP", "windows");
    expect(container.querySelector(".trust-sheet")).not.toBeNull();

    act(() => root?.unmount());
    root = null;
    await settle();

    expect(onConnected).not.toHaveBeenCalled();
  });
});

describe("ConnectScreen verification", () => {
  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("does not call a dead LAN address connected", async () => {
    vi.mocked(probeUpstream).mockResolvedValue({ ok: false, code: "client.offline" });
    await renderScreen();

    await press("连接这台电脑");
    await settle();

    expect(onConnected).not.toHaveBeenCalled();
    expect(container.textContent).toContain("读不到会话");
  });

  it("closes a cloud link whose kernel does not answer", async () => {
    rememberConnection("cloud", "dev1", "工作室的 Mac");
    vi.mocked(readProxyConfig).mockResolvedValue(config({ account: { signedIn: true } }));
    vi.mocked(listRemoteDevices).mockResolvedValue([device({ name: "工作室的 Mac" })]);
    vi.mocked(probeUpstream).mockResolvedValue({ ok: false, code: "client.offline" });
    await renderScreen();

    await pressRow("工作室的 Mac", "云端");
    await settle();

    expect(onConnected).not.toHaveBeenCalled();
    expect(clearRelayRouting).toHaveBeenCalled();
    expect(container.textContent).toContain("读不到会话");
  });

  it("tells the app that a switched address could not be verified", async () => {
    const onFailed = vi.fn();
    vi.mocked(probeUpstream).mockResolvedValue({ ok: false, code: "client.offline" });
    await renderScreen(undefined, { onFailed });

    await press("连接这台电脑");
    await settle();

    expect(onFailed).toHaveBeenCalledWith(
      expect.objectContaining({ code: "client.offline", retryable: true }),
    );
  });

  it("connects when the kernel answers after the switch", async () => {
    await renderScreen();
    await press("连接这台电脑");
    await settle();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});

describe("ConnectScreen full Studio", () => {
  const loopback = "http://127.0.0.1:8788/";
  const kernel = "http://192.168.5.2:56789";

  beforeEach(() => {
    // The real URL helpers are mocked at module scope; give these tests the
    // two answers a LAN door would produce so the wiring itself is exercised.
    vi.mocked(studioWebUrl).mockReturnValue(kernel);
    vi.mocked(studioAppUrl).mockReturnValue(loopback);
    vi.mocked(readProxyConfig).mockResolvedValue(config({ studioUrl: loopback }));
  });

  afterEach(() => {
    // The file-wide beforeEach only calls clearAllMocks(), which keeps
    // implementations. Without this reset the next describe would see a
    // "完整界面" section that its config never asked for.
    vi.mocked(studioWebUrl).mockReturnValue("");
    vi.mocked(studioAppUrl).mockReturnValue("");
  });

  it("opens the in-app Studio through the loopback proxy on a LAN door", async () => {
    await renderScreen();
    await pressRow("在应用内打开");

    // A bare WebView on the kernel address is the "打不开完整界面" bug: it
    // loses the VPN detour and the pairing cookie. The activity must be told
    // to load the proxy's own origin and carry the UA marker.
    expect(WebMode.open).toHaveBeenCalledWith({
      url: loopback,
      viaProxy: true,
      origin: kernel,
    });
  });

  it("hands the system browser the real kernel address", async () => {
    await renderScreen();
    await pressRow("在浏览器打开");

    // The browser has no proxy cookie and cannot reach this app's 127.0.0.1.
    expect(Browser.open).toHaveBeenCalledWith({ url: kernel });
    expect(WebMode.open).not.toHaveBeenCalled();
  });

  it("falls back to the real address when no native WebView exists", async () => {
    vi.mocked(WebMode.open).mockRejectedValueOnce(new Error("no activity"));
    await renderScreen();
    await pressRow("在应用内打开");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The browser fallback must not be handed the loopback URL it cannot use.
    expect(Browser.open).toHaveBeenCalledWith({ url: kernel });
  });
});

describe("ConnectScreen on an old WebView", () => {
  const loopback = "http://127.0.0.1:8788/";
  const kernel = "http://192.168.5.2:56789";
  const jsdomAgent = navigator.userAgent;

  beforeEach(() => {
    vi.mocked(studioWebUrl).mockReturnValue(kernel);
    vi.mocked(studioAppUrl).mockReturnValue(loopback);
    vi.mocked(readProxyConfig).mockResolvedValue(config({ studioUrl: loopback }));
  });

  afterEach(() => {
    vi.mocked(studioWebUrl).mockReturnValue("");
    vi.mocked(studioAppUrl).mockReturnValue("");
    // The agent is read at render time, so it has to be put back for the rest
    // of the file: jsdom's own agent carries no Chrome token, which is what
    // keeps every other test on the "unknown, say nothing" path.
    Object.defineProperty(navigator, "userAgent", {
      value: jsdomAgent,
      configurable: true,
    });
  });

  function setAgent(value: string): void {
    Object.defineProperty(navigator, "userAgent", { value, configurable: true });
  }

  it("warns on the rows instead of opening a page that will look broken", async () => {
    // The reported phone before its WebView was updated.
    setAgent(
      "Mozilla/5.0 (Linux; Android 12; Redmi K30 Pro Zoom Edition; wv) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/96.0.4664.104 Mobile Safari/537.36",
    );
    await renderScreen();

    // The row itself says why, rather than promising a working page.
    expect(container.textContent).toContain("系统 WebView 是 Chrome 96");
    // And the note names the way out.
    expect(container.textContent).toContain("Android 系统 WebView");
    // The browser row is offered as the working alternative.
    expect(container.textContent).toContain("自带内核");
  });

  it("still opens the page, because half a page beats none", async () => {
    setAgent("Mozilla/5.0 (Linux; Android 12; wv) Chrome/96.0.4664.104 Mobile Safari/537.36");
    await renderScreen();
    await pressRow("在应用内打开");

    // A warning is not a block: the compatibility sheet already restores the
    // colours and the height, so the page stays reachable.
    expect(WebMode.open).toHaveBeenCalledWith({
      url: loopback,
      viaProxy: true,
      origin: kernel,
    });
  });

  it("says nothing on an engine new enough for the page", async () => {
    setAgent(
      "Mozilla/5.0 (Linux; Android 12; Redmi K30 Pro) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/158.0.8127.2 Mobile Safari/537.36",
    );
    await renderScreen();

    expect(container.textContent).not.toContain("系统 WebView 是 Chrome");
    expect(container.textContent).toContain("电脑上那套 Studio 页面");
  });
});
