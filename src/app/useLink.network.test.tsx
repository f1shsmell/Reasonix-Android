import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLink } from "./useLink";
import type { Link } from "./useLink";
import { loadConnections } from "../net/savedConnections";
import type { Connection } from "../net/connection";
import type { NetworkStatus } from "../net/network";
import type { ProxyConfig } from "../net/server";

const serverMock = vi.hoisted(() => ({
  refreshProxy: vi.fn(),
  readProxyConfig: vi.fn(),
  answeringOrigins: vi.fn(),
  readMachineIdentity: vi.fn(),
}));
vi.mock("../net/server", () => serverMock);

const relayMock = vi.hoisted(() => ({
  prefetchGrant: vi.fn(),
  relayState: vi.fn(() => "none"),
}));
vi.mock("../net/relay", () => relayMock);

vi.mock("../net/savedConnections", () => ({
  loadConnections: vi.fn(() => []),
  latestConnection: vi.fn(() => null),
  rememberConnection: vi.fn(),
  learnConnectionMachine: vi.fn(),
  directDoorForMachine: vi.fn(() => null),
  originName: vi.fn((origin: string) => origin),
  normalizeTarget: vi.fn((_kind: string, target: string) => target.replace(/\/$/, "")),
  machineKey: vi.fn((name: string) => name.trim().toLowerCase()),
  originHost: vi.fn((origin: string) => {
    try {
      return new URL(origin).hostname.toLowerCase();
    } catch {
      return "";
    }
  }),
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
      reach: { kind: "ok" as "ok" | "unauthorized" },
      runtimes: [] as unknown[],
      stream: { kind: "idle" as const },
    },
    lost: false,
    quickCheck: vi.fn(async () => true),
    refresh: vi.fn(async () => true),
    resetFailures: vi.fn(),
    wakeStream: vi.fn(),
    subscribe: vi.fn((_listener: (snapshot: unknown) => void) => () => {}),
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
  // `clearAllMocks` clears calls, not implementations: a test that replaced
  // the saved rows would otherwise leak them into the next one.
  vi.mocked(loadConnections).mockReturnValue([]);
  relayMock.relayState.mockReturnValue("none");
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

  it("wakes the stream on a foreground, where no network change fires", async () => {
    // A resume is not a network change: the key is identical, so noteNetwork
    // returns early and never reaches the stream. Only reassess covers this,
    // which is the case that left a backgrounded phone stuck.
    await mount();
    fake.wakeStream.mockClear();
    fake.quickCheck.mockClear();

    act(() => latest?.reassess());
    await flush();

    expect(fake.quickCheck).toHaveBeenCalledTimes(1);
    expect(fake.wakeStream).toHaveBeenCalledTimes(1);
    expect(latest?.state.phase).toBe("connected");
  });

  it("does not probe on a foreground while a check is already running", async () => {
    // A burst of resumes must not stack probes.
    await mount();
    fake.quickCheck.mockClear();

    act(() => {
      latest?.reassess();
      latest?.reassess();
    });
    await flush();

    expect(fake.quickCheck).toHaveBeenCalledTimes(1);
  });

  it("asks for a cloud ticket while the LAN sweep is still running", async () => {
    // The walk cannot reach a cloud door until the probe has finished, so the
    // round trip that starts its handshake would otherwise run after it. The
    // request touches no proxy upstream and no socket, so it is safe to start
    // beside the sweep.
    const withCloud = { ...LAN, relayDevice: "dev-1", account: { signedIn: true } };
    serverMock.readProxyConfig.mockResolvedValue(withCloud);
    serverMock.refreshProxy.mockResolvedValue(withCloud);

    await mount();
    fake.quickCheck.mockResolvedValue(false);
    fake.refresh.mockResolvedValue(false);
    relayMock.prefetchGrant.mockClear();
    serverMock.answeringOrigins.mockClear();

    act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
    await flush();

    expect(relayMock.prefetchGrant).toHaveBeenCalledWith("dev-1");
    const asked = relayMock.prefetchGrant.mock.invocationCallOrder[0] ?? Infinity;
    const swept = serverMock.answeringOrigins.mock.invocationCallOrder[0] ?? Infinity;
    expect(asked).toBeLessThan(swept);
  });

  it("never hands a conversation to another computer", async () => {
    // A runtime id only means something on the kernel that minted it. The
    // account's recent device may be a different computer entirely, so a walk
    // that started on a LAN door must not open it.
    const saved = await import("../net/savedConnections");
    const door = await import("../net/door");
    // A second LAN address for the same computer: the first one is the
    // proxy's current origin, which the walk verifies before the door list
    // and therefore marks as already tried.
    const spare = "http://192.168.5.9:57074";
    vi.mocked(saved.loadConnections).mockReturnValue([
      { kind: "lan", target: LAN.origin, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 0 },
      { kind: "lan", target: spare, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 1 },
      { kind: "cloud", target: "dev-1", name: "Mac-B", machine: "Mac-B", usedAt: 0, order: 2 },
    ] as never);

    const withCloud = { ...LAN, relayDevice: "dev-1", account: { signedIn: true } };
    serverMock.readProxyConfig.mockResolvedValue(withCloud);
    serverMock.refreshProxy.mockResolvedValue(withCloud);
    serverMock.answeringOrigins.mockResolvedValue([spare]);

    await mount();
    fake.quickCheck.mockResolvedValue(false);
    fake.refresh.mockResolvedValue(false);
    vi.mocked(door.openDoor).mockClear();

    act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
    await flush();

    const kinds = vi.mocked(door.openDoor).mock.calls.map(([entry]) => entry.kind);
    // The LAN door is still tried; the other computer's cloud door is not.
    expect(kinds).toContain("lan");
    expect(kinds).not.toContain("cloud");
  });

  it("stays on its own door when automatic switching is off", async () => {
    // The switch is a person's choice: even the same computer must not be
    // reached through the other transport behind their back.
    const saved = await import("../net/savedConnections");
    const door = await import("../net/door");
    const spare = "http://192.168.5.9:57074";
    vi.mocked(saved.loadConnections).mockReturnValue([
      { kind: "lan", target: LAN.origin, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 0 },
      { kind: "lan", target: spare, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 1 },
      { kind: "cloud", target: "dev-1", name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 2 },
    ] as never);

    const withCloud = { ...LAN, relayDevice: "dev-1", account: { signedIn: true } };
    serverMock.readProxyConfig.mockResolvedValue(withCloud);
    serverMock.refreshProxy.mockResolvedValue(withCloud);
    serverMock.answeringOrigins.mockResolvedValue([spare]);
    localStorage.setItem("reasonix.auto-handover.v1", "off");

    try {
      await mount();
      fake.quickCheck.mockResolvedValue(false);
      fake.refresh.mockResolvedValue(false);
      vi.mocked(door.openDoor).mockClear();

      act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
      await flush();

      const kinds = vi.mocked(door.openDoor).mock.calls.map(([entry]) => entry.kind);
      expect(kinds).toContain("lan");
      expect(kinds).not.toContain("cloud");
    } finally {
      localStorage.removeItem("reasonix.auto-handover.v1");
    }
  });

  it("reacts to a dead LAN stream instead of waiting for the watch timer", async () => {
    // A retrying stream is an event; the 30 s poll is not. Two retries rule
    // out a kernel restarting a single pane, so one short probe decides
    // whether the route is gone — and a dead one walks the doors at once.
    const saved = await import("../net/savedConnections");
    const door = await import("../net/door");
    const spare = "http://192.168.5.9:57074";
    vi.mocked(saved.loadConnections).mockReturnValue([
      { kind: "lan", target: LAN.origin, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 0 },
      { kind: "lan", target: spare, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 1 },
    ] as never);

    const withCloud = { ...LAN, relayDevice: "dev-1", account: { signedIn: true } };
    serverMock.readProxyConfig.mockResolvedValue(withCloud);
    serverMock.refreshProxy.mockResolvedValue(withCloud);
    serverMock.answeringOrigins.mockResolvedValue([spare]);

    await mount();
    fake.quickCheck.mockResolvedValue(false);
    fake.refresh.mockResolvedValue(false);
    vi.mocked(door.openDoor).mockClear();

    const listener = vi.mocked(fake.subscribe).mock.calls[0]?.[0];
    expect(listener).toBeDefined();
    act(() => {
      listener?.({ stream: { kind: "retrying", attempt: 2, afterMs: 500 } });
    });
    await flush();

    expect(fake.quickCheck).toHaveBeenCalled();
    expect(vi.mocked(door.openDoor).mock.calls.length).toBeGreaterThan(0);
  });

  it("moves to the account when a LAN pairing has expired", async () => {
    // A refusal is about the door. The LAN cookie cannot be repaired by
    // retrying it, while the account still reaches the same machine.
    const saved = await import("../net/savedConnections");
    const door = await import("../net/door");
    vi.mocked(saved.loadConnections).mockReturnValue([
      { kind: "lan", target: LAN.origin, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 0 },
      { kind: "cloud", target: "dev-1", name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 1 },
    ] as never);

    const withCloud = { ...LAN, relayDevice: "dev-1", account: { signedIn: true } };
    serverMock.readProxyConfig.mockResolvedValue(withCloud);
    serverMock.refreshProxy.mockResolvedValue(withCloud);

    await mount();
    // The route now refuses every read: the LAN pairing expired.
    fake.current.reach = { kind: "unauthorized" };
    fake.refresh.mockResolvedValue(false);
    vi.mocked(door.openDoor).mockResolvedValue({ ok: true });

    act(() => latest?.check());
    await flush();

    const kinds = vi.mocked(door.openDoor).mock.calls.map(([entry]) => entry.kind);
    expect(kinds).not.toContain("lan");
    expect(kinds).toContain("cloud");
  });

  it("keeps a working link's face while it tries the next door", async () => {
    // The session is still on screen; only the transport is being repaired.
    // Blinking back to "finding the computer" is what made a hiccup look like
    // a disconnection.
    await mount();
    fake.quickCheck.mockResolvedValue(false);
    let release: () => void = () => {};
    serverMock.refreshProxy.mockImplementation(
      () => new Promise<ProxyConfig | null>((resolve) => (release = () => resolve(LAN))),
    );

    act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
    await flush();
    await flush();

    expect(latest?.state.phase).toBe("connected");
    expect(latest?.state.step).toBe("probe");

    release();
    await flush();
  });

  it("leaves a reconnecting relay alone on a resume", async () => {
    // The relay retries its own socket for up to a minute. Probing during that
    // window would time out against a link that is about to return, and the
    // walk that followed would tear it down.
    await mount();
    fake.quickCheck.mockClear();
    relayMock.relayState.mockReturnValue("reconnecting");

    act(() => latest?.reassess());
    await flush();

    expect(fake.quickCheck).not.toHaveBeenCalled();
    expect(latest?.state.phase).toBe("connected");
  });

  it("probes a missed door again before waiting out a backoff", async () => {
    // "The first address answered only after the second was already being
    // tried": the sweep at the start of the attempt is stale by the time the
    // walk has spent its budget. One more sweep before sleeping on the backoff
    // catches that, and costs one probe instead of a whole retry cycle.
    const second = "http://192.168.5.3:56789";
    const twoDoors = { ...LAN, candidates: [LAN.origin, second] };
    serverMock.readProxyConfig.mockResolvedValue(twoDoors);
    serverMock.refreshProxy.mockResolvedValue(twoDoors);

    await mount();
    fake.quickCheck.mockResolvedValue(false);
    fake.refresh.mockResolvedValue(false);
    // Nothing comes back on the second sweep either, so the attempt ends in a
    // backoff instead of starting over — otherwise the walk would loop and
    // every probe count would depend on how many rounds happened to run.
    serverMock.answeringOrigins.mockResolvedValue([]);
    serverMock.answeringOrigins.mockClear();

    act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
    await flush();

    // A sweep covering every door proves nothing on its own; what only the
    // extra check produces is a probe of the missed address alone, after the
    // walk had already spent its budget on the other one.
    const singleMiss = serverMock.answeringOrigins.mock.calls.filter(
      ([targets]) => Array.isArray(targets) && targets.length === 1 && targets[0] === second,
    );
    expect(singleMiss.length).toBeGreaterThanOrEqual(1);
  });

  it("restarts at most once when a door keeps flapping across the probe deadline", async () => {
    // A door missed by the sweep and caught by the re-probe restarts the
    // attempt. That restart has to spend one retry: with the count still at
    // zero the next attempt enters the same branch, and two answers that
    // alternate — sweep misses, re-probe catches — ran the pair for ever
    // instead of falling back to a backoff.
    const second = "http://192.168.5.3:56789";
    const twoDoors = { ...LAN, candidates: [LAN.origin, second] };
    serverMock.readProxyConfig.mockResolvedValue(twoDoors);
    serverMock.refreshProxy.mockResolvedValue(twoDoors);

    await mount();
    fake.quickCheck.mockResolvedValue(false);
    fake.refresh.mockResolvedValue(false);

    serverMock.answeringOrigins.mockClear();
    let probes = 0;
    serverMock.answeringOrigins.mockImplementation(async () => {
      probes += 1;
      // Odd calls are the sweep at the top of an attempt and answer nothing;
      // even calls are the re-probe at the bottom and catch the door.
      return probes % 2 === 0 ? [second] : [];
    });

    act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
    // `flush` alone does not reach the timer the restart is scheduled on.
    for (let round = 0; round < 10; round++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    // One restart is a sweep plus its re-probe. Anything past the second
    // attempt spending the retry means the loop is back.
    expect(probes).toBeLessThanOrEqual(4);
  });

  it("keeps refusing the other computer on the retry that follows", async () => {
    // The gate used to be read only while the link said `connected`. The walk
    // that fails moves to `reconnecting` and keeps its target, and the retry
    // that followed then took the account's other computer.
    const saved = await import("../net/savedConnections");
    const door = await import("../net/door");
    vi.mocked(saved.loadConnections).mockReturnValue([
      { kind: "lan", target: LAN.origin, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 0 },
      { kind: "cloud", target: "dev-1", name: "Mac-B", machine: "Mac-B", usedAt: 0, order: 1 },
    ] as never);
    const withCloud = { ...LAN, relayDevice: "dev-1", account: { signedIn: true } };
    serverMock.readProxyConfig.mockResolvedValue(withCloud);
    serverMock.refreshProxy.mockResolvedValue(withCloud);
    serverMock.answeringOrigins.mockResolvedValue([]);
    vi.mocked(door.openDoor).mockImplementation(async (entry) => {
      if (entry.kind === "cloud") return { ok: true as const };
      return {
        ok: false as const,
        error: { code: "client.offline", message: "offline", retryable: true },
      };
    });
    fake.quickCheck.mockResolvedValue(false);
    fake.refresh.mockResolvedValue(false);

    const cloudOpened = () =>
      vi.mocked(door.openDoor).mock.calls.some(([entry]) => entry.kind === "cloud");

    await mount();
    act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
    await flush();
    expect(cloudOpened()).toBe(false);

    // Let the backoff timer run the next walks; none may change computers.
    for (let round = 0; round < 40; round += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    }
    expect(cloudOpened()).toBe(false);
    expect(latest?.state.mode).not.toBe("cloud");
  });

  it("honours automatic switching off through a retry", async () => {
    // The setting is a person's answer, not a property of the first walk.
    const saved = await import("../net/savedConnections");
    const door = await import("../net/door");
    vi.mocked(saved.loadConnections).mockReturnValue([
      { kind: "lan", target: LAN.origin, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 0 },
      { kind: "cloud", target: "dev-1", name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 1 },
    ] as never);
    const withCloud = { ...LAN, relayDevice: "dev-1", account: { signedIn: true } };
    serverMock.readProxyConfig.mockResolvedValue(withCloud);
    serverMock.refreshProxy.mockResolvedValue(withCloud);
    serverMock.answeringOrigins.mockResolvedValue([]);
    vi.mocked(door.openDoor).mockImplementation(async (entry) => {
      if (entry.kind === "cloud") return { ok: true as const };
      return {
        ok: false as const,
        error: { code: "client.offline", message: "offline", retryable: true },
      };
    });
    fake.quickCheck.mockResolvedValue(false);
    fake.refresh.mockResolvedValue(false);
    localStorage.setItem("reasonix.auto-handover.v1", "off");

    try {
      const cloudOpened = () =>
        vi.mocked(door.openDoor).mock.calls.some(([entry]) => entry.kind === "cloud");

      await mount();
      act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
      await flush();
      expect(cloudOpened()).toBe(false);

      for (let round = 0; round < 40; round += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
      }
      expect(cloudOpened()).toBe(false);
    } finally {
      localStorage.removeItem("reasonix.auto-handover.v1");
    }
  });

  it("does not follow a LAN door the list proves is another computer", async () => {
    // The transport is not the only thing a handover must not change: the
    // saved list may hold a second computer's LAN address, and reaching it
    // would replace the project and transcript under the person.
    const saved = await import("../net/savedConnections");
    const door = await import("../net/door");
    const spare = "http://192.168.5.9:57074";
    vi.mocked(saved.loadConnections).mockReturnValue([
      { kind: "lan", target: LAN.origin, name: "Mac-A", machine: "Mac-A", usedAt: 0, order: 0 },
      { kind: "lan", target: spare, name: "Mac-B", machine: "Mac-B", usedAt: 0, order: 1 },
    ] as never);
    const twoDoors = { ...LAN, candidates: [LAN.origin, spare] };
    serverMock.readProxyConfig.mockResolvedValue(twoDoors);
    serverMock.refreshProxy.mockResolvedValue(twoDoors);
    serverMock.answeringOrigins.mockResolvedValue([spare]);
    fake.quickCheck.mockResolvedValue(false);
    fake.refresh.mockResolvedValue(false);

    await mount();
    act(() => latest?.noteNetwork(status({ networkKey: "w2" }), true));
    await flush();

    expect(
      vi.mocked(door.openDoor).mock.calls.some(([entry]) => entry.target === spare),
    ).toBe(false);
  });
});
