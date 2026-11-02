import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import { App } from "./App";
import {
  answeringOrigins,
  configureProxy,
  firstAnswering,
  fleetRead,
  loadFleet,
  markRelay,
  probeUpstream,
  readMachineIdentity,
  readProxyConfig,
  refreshProxy,
  saveFleet,
} from "../net/server";
import { connectRelay, ensureRelay } from "../net/relay";
import { openRuntime } from "../net/workspaces";
import { submit } from "../net/submit";
import { startTurnNotification } from "../native/turn";
import { loadTree } from "../net/tree";
import { rememberConnection } from "../net/savedConnections";
import type { NetworkStatus } from "../net/network";

/**
 * The shell has three jobs: choose the boot screen from the proxy config,
 * replace a failed relay with a remembered LAN origin, and move between the
 * project list, a project's conversations, the connect overlay and a chat.
 *
 * The three navigation levels are the point of the newest shape, so they are
 * exercised through the real components: a project row opens a conversation
 * list, and a conversation row opens a chat. The chat itself is a stub.
 */

const connectionMock = vi.hoisted(() => {
  const state = {
    current: {
      reach: { kind: "ok" as "ok" | "unauthorized" | "unreachable" },
      runtimes: [] as unknown[],
      stream: { kind: "idle" as const },
    },
    /** Whether the transport has failed enough times to count as gone. */
    lost: false,
    /** How many reads the next refresh should report as lost. */
    lostReads: 0,
    /** Failures in a row, mirroring the real class's tolerance of 2. */
    failures: 0,
    subscribe: vi.fn(() => () => {}),
    attach: vi.fn(),
    detach: vi.fn(),
    // Mirrors the real contract closely enough for the screens: the return
    // value is *this* read's answer, one lost read is tolerated and leaves the
    // snapshot alone, and a second one in a row is what flips `reach` to
    // unreachable and sets `lost`. A refusal is an answer: it reports false,
    // resets the count, and publishes at once.
    refresh: vi.fn(async () => {
      if (state.lostReads > 0) {
        state.lostReads -= 1;
        state.failures += 1;
        state.lost = state.failures >= 2;
        if (state.lost) {
          state.current = { ...state.current, reach: { kind: "unreachable" } };
        }
        return false;
      }
      state.failures = 0;
      state.lost = false;
      return state.current.reach.kind === "ok";
    }),
  };
  return state;
});

vi.mock("../net/connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../net/connection")>()),
  Connection: class {
    get current() {
      return connectionMock.current;
    }
    get lost() {
      return connectionMock.lost;
    }
    resetFailures = () => {
      connectionMock.lost = false;
      connectionMock.lostReads = 0;
      connectionMock.failures = 0;
    };
    subscribe = connectionMock.subscribe;
    refresh = connectionMock.refresh;
    attach = connectionMock.attach;
    detach = connectionMock.detach;
    quickCheck = vi.fn(async () => true);
    wakeStream = vi.fn();
  },
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: vi.fn(() => true) } }));
const appMock = vi.hoisted(() => ({
  back: null as (() => void) | null,
  exitApp: vi.fn(),
  launchUrl: null as string | null,
  networkWatch: null as ((status: NetworkStatus) => void) | null,
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (event: string, handler: () => void) => {
      if (event === "backButton") appMock.back = handler;
      return { remove: vi.fn() };
    }),
    exitApp: appMock.exitApp,
    getLaunchUrl: vi.fn(async () =>
      appMock.launchUrl ? { url: appMock.launchUrl } : null,
    ),
  },
}));
vi.mock("../native/networkWatch", () => ({
  readNetworkStatus: vi.fn(async () => ({
    connected: true,
    connectionType: "wifi",
    validated: true,
    networkKey: "w1",
  })),
  onNetworkChange: vi.fn(async (handler: (status: NetworkStatus) => void) => {
    appMock.networkWatch = handler;
    return { remove: vi.fn() };
  }),
}));
vi.mock("../net/token", () => ({ bootstrap: vi.fn(async () => {}) }));
const relayStoreMock = vi.hoisted(() => ({
  loadRelayDevice: vi.fn<() => string | null>(() => null),
  saveRelayDevice: vi.fn(),
  loadStandDown: vi.fn<() => boolean>(() => false),
  saveStandDown: vi.fn(),
  clearStandDown: vi.fn(),
}));
vi.mock("../net/relayStore", () => relayStoreMock);
vi.mock("../net/relay", () => ({
  connectRelay: vi.fn(),
  ensureRelay: vi.fn(),
  clearRelayRouting: vi.fn(),
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
  refreshProxy: vi.fn(),
  configureProxy: vi.fn(),
  markRelay: vi.fn(),
  firstAnswering: vi.fn(),
  answeringOrigins: vi.fn(),
  probeUpstream: vi.fn(),
  readMachineIdentity: vi.fn(async () => null),
  loadFleet: vi.fn(async () => null),
  saveFleet: vi.fn(async () => {}),
  fleetRead: vi.fn(async () => ({ ok: false as const, code: "client.offline" })),
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
vi.mock("../net/tree", () => ({ loadTree: vi.fn(), DEFAULT_TREE_LIMIT: 60 }));
vi.mock("../net/workspaces", () => ({ openRuntime: vi.fn() }));
vi.mock("../net/submit", () => ({ submit: vi.fn() }));
vi.mock("../native/turn", () => ({
  startTurnNotification: vi.fn(),
  stopTurnNotification: vi.fn(),
  startCloudWatch: vi.fn(),
  setNotificationOptions: vi.fn(),
  readNativeDiagnostics: vi.fn(async () => null),
  stopCloudWatch: vi.fn(),
  loadBackgroundStatus: vi.fn(async () => null),
  openBatterySettings: vi.fn(),
  openNotificationSettings: vi.fn(),
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
  ChatScreen: ({
    runtimeId,
    onBack,
    onNewSession,
  }: {
    runtimeId: string;
    onBack: () => void;
    onNewSession?: () => void;
  }) => (
    <div data-testid="chat">
      {runtimeId}
      <button type="button" onClick={onBack}>back</button>
      {onNewSession ? <button type="button" onClick={onNewSession}>new-in-project</button> : null}
    </div>
  ),
}));

function lanConfig() {
  return {
    origin: "http://192.168.5.2:56789",
    candidates: ["http://192.168.5.2:56789"],
    paired: true,
    mode: "lan" as const,
    account: { signedIn: true },
  };
}

function networkStatus(overrides: Partial<NetworkStatus> = {}): NetworkStatus {
  return {
    connected: true,
    connectionType: "wifi",
    validated: true,
    networkKey: "w1",
    ...overrides,
  };
}

function treeBody() {
  return {
    ok: true as const,
    projects: [
      {
        root: "/work/app",
        name: "app",
        open: true,
        remembered: true,
        total: 2,
        remaining: 0,
        sessions: [
          { path: "/work/app/a.jsonl", name: "a", title: "修一下登录" },
          { path: "/work/app/b.jsonl", name: "b", runtimeId: "r2" },
        ],
      },
      {
        root: "/work/docs",
        name: "docs",
        remembered: true,
        total: 0,
        remaining: 0,
        sessions: [],
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  relayStoreMock.loadRelayDevice.mockReturnValue(null);
  appMock.back = null;
  appMock.exitApp.mockClear();
  appMock.launchUrl = null;
  appMock.networkWatch = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  connectionMock.current = {
    reach: { kind: "ok" },
    runtimes: [{ id: "r2", base: "/rt/r2", root: "/work/app", name: "app" }],
    stream: { kind: "idle" },
  };
  connectionMock.lost = false;
  connectionMock.lostReads = 0;
  connectionMock.failures = 0;
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  vi.mocked(readProxyConfig).mockResolvedValue(lanConfig());
  vi.mocked(refreshProxy).mockResolvedValue(lanConfig());
  vi.mocked(configureProxy).mockResolvedValue(lanConfig());
  vi.mocked(firstAnswering).mockResolvedValue(null);
  vi.mocked(answeringOrigins).mockResolvedValue([]);
  vi.mocked(probeUpstream).mockResolvedValue({ ok: true });
  vi.mocked(readMachineIdentity).mockResolvedValue(null);
  vi.mocked(loadFleet).mockReset();
  vi.mocked(loadFleet).mockResolvedValue(null);
  vi.mocked(saveFleet).mockReset();
  vi.mocked(saveFleet).mockResolvedValue(undefined);
  vi.mocked(fleetRead).mockReset();
  vi.mocked(fleetRead).mockResolvedValue({ ok: false, code: "client.offline" });
  vi.mocked(connectRelay).mockResolvedValue({ close: vi.fn() } as unknown as Awaited<ReturnType<typeof connectRelay>>);
  vi.mocked(ensureRelay).mockResolvedValue({ close: vi.fn() } as unknown as Awaited<ReturnType<typeof ensureRelay>>);
  vi.mocked(markRelay).mockResolvedValue({ ...lanConfig(), mode: "relay", relayDevice: "saved-device" });
  vi.mocked(loadTree).mockResolvedValue(treeBody());
  vi.mocked(openRuntime).mockResolvedValue({
    ok: true,
    runtime: { id: "r9", base: "/rt/r9", root: "/work/app", name: "app" },
  });
  vi.mocked(submit).mockReset();
  vi.mocked(submit).mockResolvedValue({ ok: true });
  vi.mocked(startTurnNotification).mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
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

function typeIntoArea(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function text(): string {
  return container.textContent ?? "";
}

function click(label: string): void {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  act(() => found.click());
}

describe("App", () => {
  it("lands on the recent conversations when the proxy remembers an origin", async () => {
    await renderApp();
    expect(container.querySelectorAll(".session")).toHaveLength(2);
    expect(text()).toContain("最近");
    expect(readProxyConfig).toHaveBeenCalled();
    expect(loadTree).toHaveBeenCalled();
  });

  it("treats an unreadable proxy as a browser session instead of trapping loading", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue(null);
    await renderApp();
    expect(container.querySelectorAll(".session")).toHaveLength(2);
  });

  it("asks for a connection when the proxy has no origin", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    await renderApp();
    expect(container.querySelector('[data-testid="connect"]')).toBeTruthy();
    expect(text()).toContain("boot");
  });

  it("keeps walking to a later door when an earlier one refuses", async () => {
    // Two saved LAN computers. The first answers the reachability probe but
    // refuses when the proxy actually switches to it; the second is fine. The
    // attempt must not stop at the refusal — that was the whole bug this
    // rework fixes.
    rememberConnection("lan", "http://192.168.9.9:51234");
    rememberConnection("lan", "http://192.168.5.2:56789");
    vi.mocked(readProxyConfig).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    vi.mocked(refreshProxy).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    vi.mocked(answeringOrigins).mockResolvedValue([
      "http://192.168.9.9:51234",
      "http://192.168.5.2:56789",
    ]);
    vi.mocked(configureProxy).mockImplementation(async (origin: string) => {
      if (origin === "http://192.168.9.9:51234") throw new Error("refused");
      return lanConfig();
    });
    await renderApp();

    expect(configureProxy).toHaveBeenCalledWith("http://192.168.9.9:51234");
    expect(configureProxy).toHaveBeenCalledWith("http://192.168.5.2:56789");
    expect(container.querySelector(".linkbar")?.textContent).toContain("局域网已连接");
  });

  it("does not open a cloud door while the account is signed out", async () => {
    rememberConnection("cloud", "dev-1", "工作室的电脑");
    vi.mocked(readProxyConfig).mockResolvedValue({
      ...lanConfig(),
      origin: "",
      candidates: [],
      account: { signedIn: false },
    });
    vi.mocked(refreshProxy).mockResolvedValue({
      ...lanConfig(),
      origin: "",
      candidates: [],
      account: { signedIn: false },
    });
    await renderApp();

    expect(ensureRelay).not.toHaveBeenCalled();
  });

  it("keeps a live link when a foreground probe is lost", async () => {
    // The reported symptom: coming back to the app fired a probe, one lost
    // request tore the link down. Drive the real trigger — visibilitychange
    // calls link.kick() — and let the transport read fail.
    //
    // What this asserts is the *delegation*: kick on a live link verifies and
    // decides nothing. The tolerance itself (one lost read absorbed, two in a
    // row meaning lost) is `Connection`'s contract and is covered against the
    // real class in connection.test.ts; this mock is not the place that can
    // discriminate that.
    await renderApp();
    expect(container.querySelector(".linkbar")?.textContent).toContain("局域网已连接");

    connectionMock.lostReads = 1;
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();

    expect(container.querySelector(".linkbar")?.textContent).toContain("局域网已连接");
    expect(container.querySelector(".linkbar")?.textContent).not.toContain("正在重连");
    // The read ran and failed, and the machine was not told to reconnect.
    expect(connectionMock.lostReads).toBe(0);
    expect(connectionMock.failures).toBe(1);
  });

  it("does not tear the link down when a screen mounts", async () => {
    // The settings screen mounts and unmounts around a live link. Neither the
    // visit nor the return may change the connection on its own.
    await renderApp();
    click("连接与账号");
    await settle();
    expect(container.querySelector('[data-testid="connect"]')).toBeTruthy();

    click("close");
    await settle();

    expect(container.querySelector(".linkbar")?.textContent).toContain("局域网已连接");
  });

  it("opens a relay and reaches the home screen when the saved mode is relay", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue({
      ...lanConfig(),
      mode: "relay",
      relayDevice: "saved-device",
    });
    await renderApp();
    expect(connectRelay).toHaveBeenCalledWith("saved-device");
    expect(container.querySelectorAll(".session")).toHaveLength(2);
  });

  it("falls back to the remembered LAN origin when the relay will not open", async () => {
    vi.mocked(readProxyConfig).mockResolvedValue({
      ...lanConfig(),
      mode: "relay",
      relayDevice: "saved-device",
    });
    vi.mocked(connectRelay).mockRejectedValue(new Error("relay down"));
    vi.mocked(firstAnswering).mockResolvedValue("http://192.168.5.2:56789");
    await renderApp();
    expect(configureProxy).toHaveBeenCalledWith("http://192.168.5.2:56789");
    expect(container.querySelectorAll(".session")).toHaveLength(2);
  });

  it("prefers a LAN door even while the relay still works", async () => {
    const relayed = { ...lanConfig(), mode: "relay" as const, relayDevice: "saved-device" };
    vi.mocked(readProxyConfig).mockResolvedValue(relayed);
    vi.mocked(refreshProxy).mockResolvedValue(relayed);
    vi.mocked(firstAnswering).mockResolvedValue("http://192.168.5.2:56789");
    vi.mocked(answeringOrigins).mockResolvedValue(["http://192.168.5.2:56789"]);
    await renderApp();

    expect(configureProxy).toHaveBeenCalledWith("http://192.168.5.2:56789");
    expect(container.querySelectorAll(".session")).toHaveLength(2);
  });

  it("upgrades a live cloud link to the LAN door of the same computer", async () => {
    // The computer is reachable both ways. The boot walk takes the relay
    // first (the direct sweep found nothing yet); once the cloud link is up,
    // the identity match lets the app move to the neighbour by itself.
    const relayed = {
      ...lanConfig(),
      mode: "relay" as const,
      relayDevice: "saved-device",
      direct: ["http://192.168.5.2:56789"],
    };
    rememberConnection("cloud", "saved-device", "Home Mac", "Home Mac");
    rememberConnection("lan", "http://192.168.5.2:56789", "Home Mac", "Home Mac");
    vi.mocked(readProxyConfig).mockResolvedValue(relayed);
    vi.mocked(refreshProxy).mockResolvedValue(relayed);
    vi.mocked(markRelay).mockResolvedValue(relayed);
    vi.mocked(answeringOrigins).mockResolvedValue([]);
    vi.mocked(readMachineIdentity).mockResolvedValue({ machine: "Home Mac" });
    await renderApp();

    expect(configureProxy).toHaveBeenCalledWith("http://192.168.5.2:56789");
    expect(container.querySelector(".linkbar")?.textContent).toContain("局域网已连接");
  });

  it("does not upgrade to a LAN door that names another computer", async () => {
    const relayed = {
      ...lanConfig(),
      mode: "relay" as const,
      relayDevice: "saved-device",
      direct: ["http://192.168.5.2:56789"],
    };
    rememberConnection("cloud", "saved-device", "Home Mac", "Home Mac");
    rememberConnection("lan", "http://192.168.5.2:56789", "Office PC", "Office PC");
    vi.mocked(readProxyConfig).mockResolvedValue(relayed);
    vi.mocked(refreshProxy).mockResolvedValue(relayed);
    vi.mocked(markRelay).mockResolvedValue(relayed);
    vi.mocked(answeringOrigins).mockResolvedValue([]);
    vi.mocked(readMachineIdentity).mockResolvedValue({ machine: "Office PC" });
    await renderApp();

    expect(configureProxy).not.toHaveBeenCalledWith("http://192.168.5.2:56789");
    expect(container.querySelector(".linkbar")?.textContent).toContain("云端已连接");
  });

  it("stays on the relay when no LAN address answers", async () => {
    const relayed = { ...lanConfig(), mode: "relay" as const, relayDevice: "saved-device" };
    vi.mocked(readProxyConfig).mockResolvedValue(relayed);
    vi.mocked(refreshProxy).mockResolvedValue(relayed);
    vi.mocked(firstAnswering).mockResolvedValue(null);
    vi.mocked(answeringOrigins).mockResolvedValue([]);
    await renderApp();

    expect(configureProxy).not.toHaveBeenCalled();
    expect(ensureRelay).toHaveBeenCalledWith("saved-device");
    expect(container.querySelectorAll(".session")).toHaveLength(2);
  });

  it("boots to the app from a saved LAN record when the proxy lost its origin", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    vi.mocked(readProxyConfig).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    await renderApp();

    expect(container.querySelector('[data-testid="connect"]')).toBeNull();
    expect(container.querySelectorAll(".session")).toHaveLength(2);
  });

  it("reports a retrying link instead of showing a connected home", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    vi.mocked(readProxyConfig).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    vi.mocked(refreshProxy).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    vi.mocked(firstAnswering).mockResolvedValue(null);
    await renderApp();

    expect(container.querySelector(".linkbar")?.textContent).toContain("正在重连");
  });

  it("stops retrying when the pairing is gone and names the fix", async () => {
    connectionMock.current.reach = { kind: "unauthorized" };
    vi.mocked(firstAnswering).mockResolvedValue("http://192.168.5.2:56789");
    vi.mocked(probeUpstream).mockResolvedValue({ ok: false, code: "device.unauthorized" });
    await renderApp();

    expect(container.querySelector(".linkbar")?.textContent).toContain("连接失败");
    act(() => (container.querySelector(".linkbar") as HTMLButtonElement).click());
    expect(container.textContent).toContain("配对或登录已失效");
  });

  it("ends a live link the moment the pairing expires mid-session", async () => {
    // The kernel answered with 401 — that is an answer, not a hiccup, so the
    // tolerance must not keep the chip on 已连接 with a dead session.
    await renderApp();
    expect(container.querySelector(".linkbar")?.textContent).toContain("局域网已连接");

    connectionMock.current.reach = { kind: "unauthorized" };
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();

    expect(container.querySelector(".linkbar")?.textContent).toContain("连接失败");
    // The chip already carried the reason (device.unauthorized); opening the
    // switch sheet names it for the person.
    act(() => (container.querySelector(".linkbar") as HTMLButtonElement).click());
    expect(container.querySelector(".switch-sheet")?.textContent).toContain("配对或登录已失效");
  });

  it("waits for the network instead of retrying into a dead one", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    vi.mocked(readProxyConfig).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    vi.mocked(refreshProxy).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    vi.mocked(firstAnswering).mockResolvedValue(null);
    vi.mocked(answeringOrigins).mockResolvedValue([]);
    await renderApp();

    // The first attempt failed and scheduled a retry; losing the network now
    // must replace that wait with the offline state.
    act(() => appMock.networkWatch?.(networkStatus({ connected: false, connectionType: "none", validated: false, networkKey: "" })));

    expect(container.querySelector(".linkbar")?.textContent).toContain("等待网络");
  });

  it("walks the saved doors again as soon as the network is back", async () => {
    rememberConnection("lan", "http://192.168.9.9:51234");
    vi.mocked(readProxyConfig).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    vi.mocked(refreshProxy).mockResolvedValue({ ...lanConfig(), origin: "", candidates: [] });
    vi.mocked(firstAnswering).mockResolvedValue(null);
    vi.mocked(answeringOrigins).mockResolvedValue([]);
    await renderApp();
    act(() => appMock.networkWatch?.(networkStatus({ connected: false, connectionType: "none", validated: false, networkKey: "" })));
    expect(container.querySelector(".linkbar")?.textContent).toContain("等待网络");

    vi.mocked(answeringOrigins).mockResolvedValue(["http://192.168.9.9:51234"]);
    vi.mocked(configureProxy).mockResolvedValue({
      ...lanConfig(),
      origin: "http://192.168.9.9:51234",
      candidates: ["http://192.168.9.9:51234"],
    });
    await act(async () => {
      appMock.networkWatch?.(networkStatus({ networkKey: "w2" }));
      await Promise.resolve();
    });
    await settle();

    // The saved list is the retry order: the address it holds is the one the
    // machine opens once the phone has a network again.
    expect(configureProxy).toHaveBeenCalledWith("http://192.168.9.9:51234");
    expect(container.querySelector(".linkbar")?.textContent).toContain("局域网已连接");
  });

  it("opens the conversation a decision notification names", async () => {
    appMock.launchUrl =
      "reasonix://chat?runtime=r2&root=%2Fwork%2Fapp&title=%E8%BF%9E%E6%8E%A5";
    await renderApp();

    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r2");
  });

  it("switches to the computer a peer notification names", async () => {
    rememberConnection("lan", "http://192.168.7.7:56789", "studio");
    appMock.launchUrl =
      "reasonix://chat?runtime=r9&root=%2Fwork%2Fapp&peer=http%3A%2F%2F192.168.7.7%3A56789&peerName=studio";
    await renderApp();
    await settle();

    expect(configureProxy).toHaveBeenCalledWith("http://192.168.7.7:56789");
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r9");
  });

  it("refuses a peer notification for a computer it has never saved", async () => {
    appMock.launchUrl =
      "reasonix://chat?runtime=r9&peer=http%3A%2F%2F10.0.0.9%3A1&peerName=elsewhere";
    await renderApp();
    await settle();

    expect(configureProxy).not.toHaveBeenCalledWith("http://10.0.0.9:1");
    expect(container.querySelector('[data-testid="chat"]')).toBeNull();
    expect(text()).toContain("不在连接列表里");
  });

  it("opens a stored conversation straight from the recent list", async () => {
    await renderApp();

    await act(async () => {
      const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
        candidate.textContent?.includes("修一下登录"),
      );
      (row as HTMLButtonElement).click();
    });
    await settle();

    expect(openRuntime).toHaveBeenCalledWith("/work/app", "/work/app/a.jsonl");
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r9");
  });

  it("adds the computer it connects to to the watch list", async () => {
    vi.mocked(loadFleet).mockResolvedValue([]);

    await renderApp();

    const written = vi.mocked(saveFleet).mock.calls.at(-1)?.[0] ?? [];
    expect(
      written.some(
        (peer) => peer.kind === "lan" && peer.target === "http://192.168.5.2:56789",
      ),
    ).toBe(true);
  });

  it("starts the watcher when only another computer has work", async () => {
    vi.mocked(loadFleet).mockResolvedValue([
      { kind: "lan", target: "http://192.168.7.7:56789", name: "studio", watchable: true },
    ]);
    vi.mocked(fleetRead).mockImplementation(async (path: string) => {
      if (path === "/__reasonix/fleet/0/runtimes") {
        return {
          ok: true as const,
          body: [{ id: "r2", base: "/rt/r2", root: "/work/app", name: "app", sessionPath: "/work/app/b.jsonl" }],
        };
      }
      if (path === "/__reasonix/fleet/0/rt/r2/status") {
        return {
          ok: true as const,
          body: { decisions: [{ id: "d1", kind: "ask", questions: [{ prompt: "继续?" }] }], running: false },
        };
      }
      return { ok: false as const, code: "http.404" };
    });

    await renderApp();
    await settle();

    expect(startTurnNotification).toHaveBeenCalledWith({ mode: "lan" });
  });

  it("opens another computer's blocked conversation by switching to it", async () => {
    vi.mocked(loadFleet).mockResolvedValue([
      { kind: "lan", target: "http://192.168.7.7:56789", name: "studio", watchable: true },
    ]);
    vi.mocked(fleetRead).mockImplementation(async (path: string) => {
      if (path === "/__reasonix/fleet/0/runtimes") {
        return {
          ok: true as const,
          body: [{ id: "r2", base: "/rt/r2", root: "/work/app", name: "app", sessionPath: "/work/app/b.jsonl" }],
        };
      }
      if (path === "/__reasonix/fleet/0/rt/r2/status") {
        return {
          ok: true as const,
          body: { decisions: [{ id: "d1", kind: "ask", prompt: "继续吗?" }], running: false },
        };
      }
      return { ok: false as const, code: "http.404" };
    });

    await renderApp();

    const row = Array.from(container.querySelectorAll(".fleet-row")).find((candidate) =>
      candidate.textContent?.includes("studio"),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      (row as HTMLButtonElement).click();
    });
    await settle();

    expect(configureProxy).toHaveBeenCalledWith("http://192.168.7.7:56789");
    // The pane is still open on that computer, so this is navigation only.
    expect(openRuntime).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r2");
  });

  it("binds a conversation whose pane closed since the sweep", async () => {
    vi.mocked(loadFleet).mockResolvedValue([
      { kind: "lan", target: "http://192.168.7.7:56789", name: "studio", watchable: true },
    ]);
    vi.mocked(fleetRead).mockImplementation(async (path: string) => {
      if (path === "/__reasonix/fleet/0/runtimes") {
        return {
          ok: true as const,
          body: [{ id: "rx", base: "/rt/rx", root: "/work/app", name: "app", sessionPath: "/work/app/a.jsonl" }],
        };
      }
      if (path === "/__reasonix/fleet/0/rt/rx/status") {
        return {
          ok: true as const,
          body: { decisions: [{ id: "d1", kind: "tool_approval", prompt: "批准?" }], running: false },
        };
      }
      return { ok: false as const, code: "http.404" };
    });

    await renderApp();

    const row = Array.from(container.querySelectorAll(".fleet-row")).find((candidate) =>
      candidate.textContent?.includes("studio"),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      (row as HTMLButtonElement).click();
    });
    await settle();

    expect(openRuntime).toHaveBeenCalledWith("/work/app", "/work/app/a.jsonl");
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r9");
  });

  it("walks projects → conversations → chat and back to each level", async () => {
    await renderApp();

    click("项目");
    expect(container.querySelectorAll(".project")).toHaveLength(2);

    act(() => (container.querySelector(".project") as HTMLButtonElement).click());
    expect(container.querySelectorAll(".session")).toHaveLength(2);
    expect(text()).toContain("修一下登录");

    await act(async () => {
      const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
        candidate.textContent?.includes("修一下登录"),
      );
      (row as HTMLButtonElement).click();
    });
    await settle();
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r9");

    click("back");
    await settle();
    expect(container.querySelectorAll(".session")).toHaveLength(2);
    expect(container.querySelector('[data-testid="chat"]')).toBeNull();

    click("←");
    expect(container.querySelectorAll(".project")).toHaveLength(2);
    expect(container.querySelectorAll(".session")).toHaveLength(0);
    expect(container.querySelector('button[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "项目",
    );
  });

  it("opens a fresh conversation in the project from its list", async () => {
    await renderApp();
    click("项目");
    act(() => (container.querySelector(".project") as HTMLButtonElement).click());

    await act(async () => {
      click("新会话");
    });
    await settle();

    expect(openRuntime).toHaveBeenCalledWith("/work/app", undefined);
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r9");
  });

  it("dispatches a task from home and watches it in the background", async () => {
    await renderApp();

    act(() => {
      (container.querySelector('[aria-label="派任务"]') as HTMLButtonElement).click();
    });
    const sheet = container.querySelector(".dispatch-sheet");
    expect(sheet).toBeTruthy();
    const prompt = sheet?.querySelector(".dispatch-prompt") as HTMLTextAreaElement;
    act(() => typeIntoArea(prompt, "修复登录白屏\n顺便跑测试"));
    act(() => click("派发"));
    await settle();

    expect(openRuntime).toHaveBeenCalledWith("/work/app");
    expect(submit).toHaveBeenCalledWith("/rt/r9", "修复登录白屏\n顺便跑测试");
    expect(startTurnNotification).toHaveBeenCalledWith({
      title: "修复登录白屏",
      base: "/rt/r9",
      root: "/work/app",
      runtimeId: "r9",
      mode: "lan",
    });
    expect(container.querySelector(".dispatch-sheet")).toBeNull();
    expect(container.querySelector('[data-testid="chat"]')).toBeNull();
  });

  it("starts a new conversation from the home plus after choosing a project", async () => {
    await renderApp();
    click("新建会话");
    const sheet = container.querySelector(".sheet");
    expect(sheet).toBeTruthy();
    expect(sheet?.textContent).toContain("在哪个项目新建");

    await act(async () => {
      const pick = Array.from(sheet?.querySelectorAll(".project") ?? []).find((candidate) =>
        candidate.textContent?.includes("app"),
      );
      (pick as HTMLButtonElement).click();
    });
    await settle();

    expect(openRuntime).toHaveBeenCalledWith("/work/app");
    expect(container.querySelector('[data-testid="chat"]')?.textContent).toContain("r9");
  });

  it("starts a new conversation in the chat's own project", async () => {
    await renderApp();
    await act(async () => {
      const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
        candidate.textContent?.includes("修一下登录"),
      );
      (row as HTMLButtonElement).click();
    });
    await settle();

    await act(async () => {
      click("new-in-project");
    });
    await settle();

    expect(openRuntime).toHaveBeenLastCalledWith("/work/app");
  });

  it("opens settings over the list and closes them without losing the list", async () => {
    await renderApp();
    click("连接与账号");
    expect(container.querySelector('[data-testid="connect"]')).toBeTruthy();

    click("close");
    expect(container.querySelectorAll(".session")).toHaveLength(2);
  });

  it("uses Android back to close settings, then a chat, then a project, then exits", async () => {
    await renderApp();

    click("连接与账号");
    await settle();
    expect(container.querySelector('[data-testid="connect"]')).toBeTruthy();
    act(() => appMock.back?.());
    await settle();
    expect(container.querySelectorAll(".session")).toHaveLength(2);

    click("项目");
    act(() => (container.querySelector(".project") as HTMLButtonElement).click());
    await act(async () => {
      const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
        candidate.textContent?.includes("修一下登录"),
      );
      (row as HTMLButtonElement).click();
    });
    await settle();
    expect(container.querySelector('[data-testid="chat"]')).toBeTruthy();

    act(() => appMock.back?.());
    await settle();
    expect(container.querySelectorAll(".session")).toHaveLength(2);

    act(() => appMock.back?.());
    await settle();
    expect(container.querySelectorAll(".project")).toHaveLength(2);
    expect(container.querySelectorAll(".session")).toHaveLength(0);

    act(() => appMock.back?.());
    expect(appMock.exitApp).toHaveBeenCalled();
  });

  it("keeps the home screen reachable when the tree cannot be read", async () => {
    vi.mocked(loadTree).mockResolvedValue({ ok: false, code: "client.offline" });
    await renderApp();
    expect(text()).toContain("读不到项目列表");
    expect(text()).toContain("client.offline");
  });

  it("shows a refusal when a conversation will not open", async () => {
    vi.mocked(openRuntime).mockResolvedValue({ ok: false, code: "session.running" });
    await renderApp();

    await act(async () => {
      const row = Array.from(container.querySelectorAll(".session")).find((candidate) =>
        candidate.textContent?.includes("修一下登录"),
      );
      (row as HTMLButtonElement).click();
    });
    await settle();

    expect(text()).toContain("这个会话正在桌面端跑");
    expect(container.querySelector('[data-testid="chat"]')).toBeNull();
  });
});
