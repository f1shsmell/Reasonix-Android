/**
 * Opening a LAN door without breaking the route that is already working.
 *
 * The switch is a local write, so the door is verified first. These cases pin
 * the two halves of that promise: a door that cannot answer must not reach
 * `configureProxy`, and a shell too old to answer the probe must still be
 * allowed to switch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const serverMock = vi.hoisted(() => ({
  configureProxy: vi.fn(),
  probeDoor: vi.fn(),
  probeUpstream: vi.fn(),
  readMachineIdentity: vi.fn(),
  readProxyConfig: vi.fn(),
  markRelay: vi.fn(),
  ProxyError: class ProxyError extends Error {},
}));
vi.mock("./server", () => serverMock);

const relayMock = vi.hoisted(() => ({
  ensureRelay: vi.fn(),
  clearRelayRouting: vi.fn(),
  RelayError: class RelayError extends Error {
    kind = "transient";
  },
}));
vi.mock("./relay", () => relayMock);

const savedMock = vi.hoisted(() => ({
  rememberConnection: vi.fn(),
  learnConnectionMachine: vi.fn(),
}));
vi.mock("./savedConnections", () => savedMock);

vi.mock("./fleet", () => ({ syncFleetPeer: vi.fn(async () => {}) }));

const { openDoor } = await import("./door");

const LAN = "http://192.168.5.3:57074";

beforeEach(() => {
  vi.resetAllMocks();
  serverMock.probeDoor.mockResolvedValue({ ok: true, machine: "Mac-A" });
  serverMock.configureProxy.mockResolvedValue({});
  serverMock.probeUpstream.mockResolvedValue({ ok: true });
  serverMock.readMachineIdentity.mockResolvedValue({ machine: "Mac-A" });
  // A fresh install has no route to restore.
  serverMock.readProxyConfig.mockResolvedValue(null);
});

/** A proxy config shaped like the one `/__reasonix/config` answers with. */
function proxyConfig(overrides: Record<string, unknown>) {
  return {
    origin: "",
    candidates: [],
    paired: false,
    account: { signedIn: false },
    ...overrides,
  };
}

describe("openDoor over LAN", () => {
  it("refuses a door that cannot answer without touching the route", async () => {
    serverMock.probeDoor.mockResolvedValue({ ok: false, code: "device.unauthorized" });

    const result = await openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {});

    expect(result).toMatchObject({ ok: false, error: { code: "device.unauthorized" } });
    expect(serverMock.configureProxy).not.toHaveBeenCalled();
    expect(relayMock.clearRelayRouting).not.toHaveBeenCalled();
  });

  it("switches once the door answers", async () => {
    const result = await openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {});

    expect(result.ok).toBe(true);
    expect(serverMock.configureProxy).toHaveBeenCalledWith(LAN);
    expect(relayMock.clearRelayRouting).toHaveBeenCalled();
  });

  it("still switches for a shell that cannot answer the probe", async () => {
    // An older proxy has no `/__reasonix/device`; `probeDoor` reports it as
    // verified-without-identity so an app upgrade does not brick every door.
    serverMock.probeDoor.mockResolvedValue({ ok: true, machine: "" });

    const result = await openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {});

    expect(result.ok).toBe(true);
    expect(serverMock.configureProxy).toHaveBeenCalledWith(LAN);
  });

  it("records the machine the probe named without asking again", async () => {
    await openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {});

    expect(savedMock.learnConnectionMachine).toHaveBeenCalledWith("lan", LAN, "Mac-A");
    expect(serverMock.readMachineIdentity).not.toHaveBeenCalled();
  });

  it("asks for the identity only when the probe could not name it", async () => {
    serverMock.probeDoor.mockResolvedValue({ ok: true, machine: "" });

    await openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {});

    expect(serverMock.readMachineIdentity).toHaveBeenCalledWith(LAN);
  });

  it("reports a route that answers the probe but not the kernel", async () => {
    // The door answered its own `/device` but the switched upstream cannot
    // serve `/runtimes`; the caller has to see that rather than a false ok.
    serverMock.probeUpstream.mockResolvedValue({ ok: false, code: "client.offline" });

    const result = await openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {});

    expect(result).toMatchObject({ ok: false, error: { code: "client.offline" } });
    expect(savedMock.rememberConnection).not.toHaveBeenCalled();
  });

  it("puts the previous LAN origin back when the new door cannot serve the kernel", async () => {
    // The switch is two writes: the door's own probe passed, so the proxy was
    // already pointed at it and the relay (if any) already dropped. A door
    // that answers `/device` but not `/runtimes` must not leave the app on a
    // dead address.
    const previous = "http://192.168.5.1:5000";
    serverMock.readProxyConfig.mockResolvedValue(
      proxyConfig({ mode: "lan", origin: previous, candidates: [previous] }),
    );
    serverMock.probeUpstream.mockResolvedValue({ ok: false, code: "client.offline" });

    const result = await openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {});

    expect(result).toMatchObject({ ok: false, error: { code: "client.offline" } });
    expect(serverMock.configureProxy.mock.calls.map(([origin]) => origin)).toEqual([LAN, previous]);
  });

  it("reopens the relay when a LAN switch fails under a cloud link", async () => {
    // The route being left was the account relay, so that is what has to come
    // back — not whichever LAN origin the proxy happened to remember.
    const previous = "http://192.168.5.1:5000";
    serverMock.readProxyConfig.mockResolvedValue(
      proxyConfig({ mode: "relay", relayDevice: "dev-1", origin: previous }),
    );
    serverMock.probeUpstream.mockResolvedValue({ ok: false, code: "client.timeout" });

    const result = await openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {});

    expect(result.ok).toBe(false);
    expect(relayMock.ensureRelay).toHaveBeenCalledWith("dev-1");
    expect(serverMock.markRelay).toHaveBeenCalledWith("dev-1");
    // The LAN origin is only a fallback; it must not win over a live relay.
    expect(serverMock.configureProxy).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for a relay restore that outlives its budget", async () => {
    // The grant and the handshake have long timeouts of their own. A restore
    // that is still sleeping must not hold the failed switch's error back,
    // and it must not start a second network write once the budget is gone.
    vi.useFakeTimers();
    try {
      const previous = "http://192.168.5.1:5000";
      serverMock.readProxyConfig.mockResolvedValue(
        proxyConfig({ mode: "relay", relayDevice: "dev-1", origin: previous }),
      );
      serverMock.probeUpstream.mockResolvedValue({ ok: false, code: "client.timeout" });
      relayMock.ensureRelay.mockImplementation(() => new Promise(() => {}));

      let settled = false;
      const pending = openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {}).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      expect(relayMock.clearRelayRouting).toHaveBeenCalled();
      expect(serverMock.markRelay).not.toHaveBeenCalled();
      // One switch write; the timed-out restore did not add another.
      expect(serverMock.configureProxy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a relay that opened but could not be adopted", async () => {
    // `ensureRelay` installs routing before `markRelay` writes the mode. If
    // the second write fails, the page would keep sending kernel requests
    // through a relay the proxy no longer calls the route — the two halves
    // would disagree about the transport. The link has to go before the LAN
    // fallback is named.
    const previous = "http://192.168.5.1:5000";
    serverMock.readProxyConfig.mockResolvedValue(
      proxyConfig({ mode: "relay", relayDevice: "dev-1", origin: previous }),
    );
    serverMock.probeUpstream.mockResolvedValue({ ok: false, code: "client.offline" });
    serverMock.markRelay.mockRejectedValueOnce(new Error("proxy refused"));

    const result = await openDoor({ kind: "lan", target: LAN, name: "Mac-A" }, () => {});

    expect(result.ok).toBe(false);
    // Once for the failed switch, once for the half-open restore.
    expect(relayMock.clearRelayRouting).toHaveBeenCalledTimes(2);
    expect(serverMock.configureProxy).toHaveBeenCalledWith(previous);
  });

  it("puts the previous LAN route back when a cloud switch fails", async () => {
    serverMock.readProxyConfig.mockResolvedValue(
      proxyConfig({ mode: "lan", origin: LAN, candidates: [LAN] }),
    );
    serverMock.probeUpstream.mockResolvedValue({ ok: false, code: "client.offline" });

    const result = await openDoor({ kind: "cloud", target: "dev-1" }, () => {});

    expect(result).toMatchObject({ ok: false, error: { code: "client.offline" } });
    expect(serverMock.configureProxy).toHaveBeenCalledWith(LAN);
  });
});
