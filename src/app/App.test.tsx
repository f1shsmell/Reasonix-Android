import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { App } from "./App";
import {
  configureProxy,
  markRelay,
  readProxyConfig,
  refreshProxy,
} from "../net/server";
import { connectRelay, ensureRelay } from "../net/relay";

/**
 * The shell has three jobs: choose the boot screen from the proxy config,
 * replace a failed relay with a remembered LAN origin, and move between the
 * session list, the connect overlay and a chat. The child screens are stubs
 * here so the assertions are about navigation, not their CSS.
 */

const connectionMock = vi.hoisted(() => ({
  current: {
    reach: { kind: "ok" as const },
    runtimes: [] as unknown[],
    stream: { kind: "idle" as const },
  },
  subscribe: vi.fn(() => () => {}),
  refresh: vi.fn(async () => {}),
  attach: vi.fn(),
  detach: vi.fn(),
}));

vi.mock("../net/connection", () => ({
  Connection: class {
    get current() {
      return connectionMock.current;
    }
    subscribe = connectionMock.subscribe;
    refresh = connectionMock.refresh;
    attach = connectionMock.attach;
    detach = connectionMock.detach;
  },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: vi.fn(() => true) } }));
const appMock = vi.hoisted(() => ({
  back: null as (() => void) | null,
  exitApp: vi.fn(),
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (event: string, handler: () => void) => {
      if (event === "backButton") appMock.back = handler;
      return { remove: vi.fn() };
    }),
    exitApp: appMock.exitApp,
  },
}));
vi.mock("@capacitor/network", () => ({
  Network: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));
vi.mock("../net/token", () => ({ bootstrap: vi.fn(async () => {}) }));
vi.mock("../net/relayStore", () => ({
  loadRelayDevice: vi.fn(() => "saved-device"),
  saveRelayDevice: vi.fn(),
}));
vi.mock("../net/relay", () => ({
  connectRelay: vi.fn(),
  ensureRelay: vi.fn(),
  clearRelayRouting: vi.fn(),
}));
vi.mock("../net/server", () => ({
  readProxyConfig: vi.fn(),
  refreshProxy: vi.fn(),
  configureProxy: vi.fn(),
  markRelay: vi.fn(),
}));
vi.mock("./SessionList", () => ({
  SessionList: ({ onOpen, onRefresh, onSettings, onNew }: {
    onOpen: (id: string) => void;
    onRefresh: () => void;
    onSettings?: () => void;
    onNew?: () => void;
  }) => (
    <div data-testid="sessions">
      <button type="button" onClick={() => onOpen("r1")}>open</button>
      <button type="button" onClick={onRefresh}>refresh</button>
      {onNew ? <button type="button" onClick={onNew}>new-session</button> : null}
      {onSettings ? (
        <button type="button" onClick={onSettings}>settings</button>
      ) : null}
    </div>
  ),
}));
vi.mock("./ProjectSheet", () => ({
  ProjectSheet: ({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) => (
    <div data-testid="sheet">
      <button type="button" onClick={() => onOpened("r7")}>open-new</button>
      <button type="button" onClick={onClose}>close-sheet</button>
    </div>
  ),
}));
vi.mock("./ConnectScreen", () => ({
  ConnectScreen: ({ onConnected, onClose }: { onConnected: () => void; onClose?: () => void }) => (
    <div data-testid="connect">
      <button type="button" onClick={onConnected}>connected</button>
      {onClose ? <button type="button" onClick={onClose}>close</button> : <span>boot</span>}
    </div>
  ),
}));
vi.mock("../chat/ChatScreen", () => ({
  ChatScreen: ({ runtimeId, onBack }: { runtimeId: string; onBack: () => void }) => (
    <div data-testid="chat">
      {runtimeId}
      <button type="button" onClick={onBack}>back</button>
    </div>
  ),
}));

function lanConfig() {
  return {
    origin: "http://192.168.5.2:56789",
    candidates: ["http://192.168.5.2:56789"],
    paired: true,
    mode: "lan" as const,
    account: { signedIn: false },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  appMock.back = null;
  appMock.exitApp.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.clearAllMocks();
  connectionMock.current = { reach: { kind: "ok" }, runtimes: [], stream: { kind: "idle" } };
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(readProxyConfig).mockResolvedValue(lanConfig());
  vi.mocked(refreshProxy).mockResolvedValue(lanConfig());
  vi.mocked(configureProxy).mockResolvedValue(lanConfig());
  vi.mocked(connectRelay).mockResolvedValue({ close: vi.fn() } as unknown as Awaited<ReturnType<typeof connectRelay>>);
  vi.mocked(ensureRelay).mockResolvedValue({ close: vi.fn() } as unknown as Awaited<ReturnType<typeof ensureRelay>>);
  vi.mocked(markRelay).mockResolvedValue({ ...lanConfig(), mode: "relay", relayDevice: "saved-device" });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderApp(): Promise<void> {
  act(() => root?.unmount());
  root = createRoot(container);
  await act(async () => {
    root?.render(<App />);
  });
  await settle();
}

function text(): string {
  return container.textContent ?? "";
}

describe("App", () => {
  it("lands on the session list when the proxy remembers an origin", async () => {
    await renderApp();
    expect(container.querySelector('[data-testid="sessions"]')).toBeTruthy();
    expect(text()).not.toContain("boot");
    expect(readProxyConfig).toHaveBeenCalled();
  });

  it("treats an unreadable proxy as a browser session instead of trapping loading", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(null);
    await renderApp();
    expect(container.querySelector('[data-testid="sessions"]')).toBeTruthy();
  });

  it("asks for a connection when the proxy has no origin", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    await renderApp();
    expect(container.querySelector('[data-testid="connect"]')).toBeTruthy();
    expect(text()).toContain("boot");
  });

  it("opens a relay and reaches the list when the saved mode is relay", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue({
      ...lanConfig(),
      mode: "relay",
      relayDevice: "saved-device",
    });
    await renderApp();
    expect(connectRelay).toHaveBeenCalledWith("saved-device");
    expect(container.querySelector('[data-testid="sessions"]')).toBeTruthy();
  });

  it("falls back to the remembered LAN origin when the relay will not open", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue({
      ...lanConfig(),
      mode: "relay",
      relayDevice: "saved-device",
    });
    vi.mocked(connectRelay).mockRejectedValue(new Error("relay down"));
    await renderApp();
    expect(configureProxy).toHaveBeenCalledWith("http://192.168.5.2:56789");
    expect(container.querySelector('[data-testid="sessions"]')).toBeTruthy();
  });

  it("moves from the list into a chat and back", async () => {
    await renderApp();
    const open = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "open");
    act(() => open?.click());
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r1");

    const back = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "back");
    act(() => back?.click());
    expect(container.querySelector('[data-testid="sessions"]')).toBeTruthy();
  });

  it("opens settings over the list and closes them without losing the list", async () => {
    await renderApp();
    const settings = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "settings");
    act(() => settings?.click());
    expect(container.querySelector('[data-testid="connect"]')).toBeTruthy();

    const close = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "close");
    act(() => close?.click());
    expect(container.querySelector('[data-testid="sessions"]')).toBeTruthy();
  });

  it("uses Android back to close settings and chat, then exits", async () => {
    await renderApp();

    const settings = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "settings");
    act(() => settings?.click());
    await settle();
    expect(container.querySelector('[data-testid="connect"]')).toBeTruthy();
    act(() => appMock.back?.());
    await settle();
    expect(container.querySelector('[data-testid="sessions"]')).toBeTruthy();

    const open = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "open");
    act(() => open?.click());
    await settle();
    expect(container.querySelector('[data-testid="chat"]')).toBeTruthy();
    act(() => appMock.back?.());
    await settle();
    expect(container.querySelector('[data-testid="sessions"]')).toBeTruthy();

    act(() => appMock.back?.());
    expect(appMock.exitApp).toHaveBeenCalled();
  });

  it("opens the session/project sheet and then the fresh runtime", async () => {
    connectionMock.current = {
      reach: { kind: "ok" },
      runtimes: [{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }],
      stream: { kind: "idle" },
    };
    await renderApp();

    const newSession = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "new-session",
    );
    act(() => newSession?.click());
    expect(container.querySelector('[data-testid="sheet"]')).toBeTruthy();

    const openNew = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "open-new",
    );
    act(() => openNew?.click());
    await settle();

    expect(connectionMock.refresh).toHaveBeenCalled();
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r7");
    expect(container.querySelector('[data-testid="sheet"]')).toBeNull();
  });
});
