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
  probeUpstream,
  readProxyConfig,
  signOutAccount,
} from "../net/server";
import type { ProxyConfig, RemoteDevice } from "../net/server";
import { connectRelay, clearRelayRouting } from "../net/relay";
import { clearRelayDevice } from "../net/relayStore";
import { loadStatus } from "../net/status";
import { rememberConnection } from "../net/savedConnections";
import type { LinkError } from "../net/link";

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
// The posture read goes through `loadStatus`; stubbing it keeps these tests
// about the screen rather than about the transport.
vi.mock("../net/status", () => ({
  loadStatus: vi.fn(async () => ({
    ok: true,
    status: { decisions: [], running: false, busy: false, plan: false },
  })),
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
  localStorage.clear();
  onConnected = vi.fn<() => void>();
  vi.clearAllMocks();
  vi.mocked(readProxyConfig).mockResolvedValue(config());
  vi.mocked(configureProxy).mockResolvedValue(config());
  vi.mocked(listRemoteDevices).mockResolvedValue([]);
  vi.mocked(probeUpstream).mockResolvedValue({ ok: true });
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

async function renderScreen(
  onClose?: () => void,
  props: { runtimeBase?: string; onFailed?: (error: LinkError) => void } = {},
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
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
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

    await pressRow("DESKTOP", "windows");

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

    const deviceRow = row("DESKTOP", "windows", "未开启远程访问");
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

    await pressRow("DESKTOP", "windows");

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

  describe("appearance, posture and about", () => {
    beforeEach(() => {
      localStorage.clear();
      document.documentElement.removeAttribute("data-theme");
    });

    afterEach(() => {
      document.documentElement.removeAttribute("data-theme");
    });

    it("pins a theme and remembers it", async () => {
      await renderScreen();

      await act(async () => {
        button("深色").click();
        await Promise.resolve();
      });

      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(localStorage.getItem("reasonix.theme")).toBe("dark");
    });

    it("goes back to following the system, which is the absent attribute", async () => {
      await renderScreen();
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

    it("shows the version the build was given", async () => {
      await renderScreen();
      expect(container.textContent).toContain("版本");
      // The value comes from `define`, so the test asserts it is not blank
      // rather than pinning a number that a release would change.
      const value = container.querySelector(".setting-value")?.textContent ?? "";
      expect(value.trim()).not.toBe("");
    });

    it("hides the approval control when there is no pane to address", async () => {
      await renderScreen();
      expect(container.querySelector('[aria-label="工具批准"]')).toBeNull();
    });

    it("reads this conversation's posture and posts the chosen one", async () => {
      vi.mocked(loadStatus).mockResolvedValue({
        ok: true,
        status: {
          decisions: [],
          running: false,
          busy: false,
          plan: false,
          toolApprovalMode: "ask",
        },
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchMock);

      await renderScreen(undefined, { runtimeBase: "/rt/r1" });

      expect(loadStatus).toHaveBeenCalledWith("/rt/r1");
      expect(container.textContent).toContain("逐次询问");

      const auto = Array.from(container.querySelectorAll(".approval")).find((node) =>
        node.textContent?.includes("自动"),
      ) as HTMLButtonElement | undefined;
      expect(auto).toBeTruthy();

      await act(async () => {
        auto?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "/rt/r1/tool-approval-mode",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "auto" }) }),
      );
    });

    it("says why a posture change was refused", async () => {
      vi.mocked(loadStatus).mockResolvedValue({
        ok: true,
        status: { decisions: [], running: false, busy: false, plan: false, toolApprovalMode: "ask" },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ code: "request.bad_value" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      await renderScreen(undefined, { runtimeBase: "/rt/r1" });

      const yolo = Array.from(container.querySelectorAll(".approval")).find((node) =>
        node.textContent?.includes("全放开"),
      ) as HTMLButtonElement | undefined;
      await act(async () => {
        yolo?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(container.textContent).toContain("request.bad_value");
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

  it("forgets a saved computer without touching the rest", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    await renderScreen();

    act(() => {
      (
        container.querySelector('[aria-label="移除 192.168.9.9:51234"]') as HTMLButtonElement
      ).click();
    });

    expect(container.textContent).not.toContain("192.168.9.9:51234");
    expect(container.textContent).toContain("192.168.5.2:56789");
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

    await press("连接");
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

    await press("连接");
    await settle();

    expect(onFailed).toHaveBeenCalledWith(
      expect.objectContaining({ code: "client.offline", retryable: true }),
    );
  });

  it("connects when the kernel answers after the switch", async () => {
    await renderScreen();
    await press("连接");
    await settle();
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
