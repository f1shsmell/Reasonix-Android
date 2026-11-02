import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLink } from "./useLink";
import type { Link } from "./useLink";
import type { Connection } from "../net/connection";
import type { NetworkStatus } from "../net/network";

const serverMock = vi.hoisted(() => ({
  refreshProxy: vi.fn(),
  readProxyConfig: vi.fn(),
  answeringOrigins: vi.fn(),
  readMachineIdentity: vi.fn(),
}));
vi.mock("../net/server", () => serverMock);

vi.mock("../net/savedConnections", () => ({
  loadConnections: vi.fn(() => []),
  latestConnection: vi.fn(() => null),
  rememberConnection: vi.fn(),
  learnConnectionMachine: vi.fn(),
  directDoorForMachine: vi.fn(() => null),
  originName: vi.fn((origin: string) => origin),
  normalizeTarget: vi.fn((_kind: string, target: string) => target.replace(/\/$/, "")),
  machineKey: vi.fn((name: string) => name.trim().toLowerCase()),
}));

vi.mock("../net/relayStore", () => ({
  loadRelayDevice: vi.fn(() => null),
  saveRelayDevice: vi.fn(),
  loadStandDown: vi.fn(() => false),
  saveStandDown: vi.fn(),
  clearStandDown: vi.fn(),
}));

vi.mock("../net/door", () => ({
  openDoor: vi.fn(async () => ({
    ok: false as const,
    error: { code: "client.offline", message: "offline", retryable: true },
  })),
  failureFromError: vi.fn(() => ({
    code: "client.offline",
    message: "offline",
    retryable: true,
  })),
}));

const LAN = {
  origin: "http://192.168.5.2:56789",
  candidates: ["http://192.168.5.2:56789"],
  paired: true,
  mode: "lan" as const,
  account: { signedIn: false },
};

function status(overrides: Partial<NetworkStatus> = {}): NetworkStatus {
  return {
    connected: true,
    connectionType: "wifi",
    validated: true,
    networkKey: "w1",
    ...overrides,
  };
}

function fakeConnection() {
  return {
    current: {
      reach: { kind: "ok" as const },
      runtimes: [],
      stream: { kind: "idle" as const },
    },
    lost: false,
    quickCheck: vi.fn(async () => true),
    refresh: vi.fn(async () => true),
    resetFailures: vi.fn(),
    wakeStream: vi.fn(),
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let latest: Link | null = null;
let fake: ReturnType<typeof fakeConnection>;

function Probe({ connection }: { connection: Connection }) {
  latest = useLink(connection);
  return null;
}

async function mount(): Promise<void> {
  await act(async () => {
    root?.render(<Probe connection={fake as unknown as Connection} />);
  });
  await act(async () => {
    await latest?.noteConnected();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  fake = fakeConnection();
  vi.clearAllMocks();
  serverMock.readProxyConfig.mockResolvedValue(LAN);
  serverMock.refreshProxy.mockResolvedValue(LAN);
  serverMock.answeringOrigins.mockResolvedValue([]);
  serverMock.readMachineIdentity.mockResolvedValue(null);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = null;
});

describe("useLink network changes", () => {
  it("probes a live route when the network changes without a dropout", async () => {
    await mount();
    expect(latest?.state.phase).toBe("connected");
    fake.wakeStream.mockClear();

    act(() => latest?.noteNetwork(status({ networkKey: "w2", connectionType: "wifi" }), true));
    await flush();

    expect(fake.quickCheck).toHaveBeenCalledTimes(1);
    expect(fake.wakeStream).toHaveBeenCalledTimes(1);
    expect(latest?.state.phase).toBe("connected");
  });

  it("reconnects immediately when the route no longer answers", async () => {
    await mount();
    fake.quickCheck.mockResolvedValue(false);
    fake.refresh.mockResolvedValue(false);

    act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
    await flush();

    expect(serverMock.refreshProxy).toHaveBeenCalled();
    expect(latest?.state.phase).not.toBe("connected");
  });

  it("keeps a live link through a dropout and reassesses when it returns", async () => {
    await mount();

    act(() =>
      latest?.noteNetwork(
        status({ connected: false, connectionType: "none", validated: false, networkKey: "" }),
        true,
      ),
    );
    expect(latest?.state.phase).toBe("connected");

    act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
    await flush();

    expect(fake.quickCheck).toHaveBeenCalledTimes(1);
    expect(latest?.state.phase).toBe("connected");
  });

  it("does nothing when neither the key nor the link changed", async () => {
    await mount();

    act(() => latest?.noteNetwork(status(), false));
    await flush();
    act(() => latest?.noteNetwork(status(), false));
    await flush();

    expect(fake.quickCheck).not.toHaveBeenCalled();
    expect(latest?.state.phase).toBe("connected");
  });
});
