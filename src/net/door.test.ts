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
});

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
});
