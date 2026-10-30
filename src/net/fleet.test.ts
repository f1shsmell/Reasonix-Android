import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyFleet, Fleet, forgetFleetPeer, peerTone, syncFleetPeer } from "./fleet";
import type { FleetSnapshot } from "./fleet";
import type { FleetEntry } from "./server";

const serverMock = vi.hoisted(() => ({
  loadFleet: vi.fn<() => Promise<FleetEntry[] | null>>(async () => []),
  saveFleet: vi.fn<(peers: FleetEntry[]) => Promise<void>>(async () => {}),
  fleetRead: vi.fn(),
}));

vi.mock("./server", () => serverMock);

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function lanPeer(name: string): FleetEntry {
  return { kind: "lan", target: `http://${name}:56789`, name, watchable: true };
}

function runtime(id: string, sessionPath?: string) {
  return {
    id,
    base: `/rt/${id}`,
    root: `C:\\work\\${id}`,
    name: `${id} 的项目`,
    ...(sessionPath ? { sessionPath } : {}),
  };
}

function status(body: Record<string, unknown>) {
  return { ok: true as const, body };
}

describe("Fleet sweep", () => {
  it("reads one peer's runtimes and each open pane's status", async () => {
    serverMock.loadFleet.mockResolvedValue([lanPeer("alpha")]);
    serverMock.fleetRead.mockImplementation(async (path: string) => {
      if (path === "/__reasonix/fleet/0/runtimes") {
        return { ok: true as const, body: [runtime("rt1", "C:\\s\\one.json"), runtime("rt2")] };
      }
      if (path === "/__reasonix/fleet/0/rt/rt1/status") {
        return status({ decisions: [{ id: "d1", kind: "ask", prompt: "继续吗?" }], running: true });
      }
      if (path === "/__reasonix/fleet/0/rt/rt2/status") {
        return status({ decisions: [], running: false });
      }
      return { ok: false as const, code: "http.404" };
    });

    const fleet = new Fleet();
    const seen: FleetSnapshot[] = [];
    fleet.subscribe((snapshot) => seen.push(snapshot));
    await fleet.refresh();

    expect(serverMock.fleetRead).toHaveBeenCalledWith("/__reasonix/fleet/0/runtimes");
    expect(serverMock.fleetRead).toHaveBeenCalledWith("/__reasonix/fleet/0/rt/rt1/status", 6_000);
    const last = seen[seen.length - 1];
    expect(last?.peers).toHaveLength(1);
    expect(last?.peers[0]?.state).toBe("online");
    expect(last?.pending).toHaveLength(1);
    expect(last?.pending[0]?.peerName).toBe("alpha");
    expect(last?.pending[0]?.sessionPath).toBe("C:\\s\\one.json");
    expect(last?.running).toHaveLength(1);
    expect(last?.running[0]?.runtimeId).toBe("rt1");
  });

  it("reports an expired pairing as unauthorized, not offline", async () => {
    serverMock.loadFleet.mockResolvedValue([lanPeer("alpha")]);
    serverMock.fleetRead.mockResolvedValue({ ok: false, code: "device.unauthorized" });

    const fleet = new Fleet();
    await fleet.refresh();

    expect(fleet.current.peers[0]?.state).toBe("unauthorized");
    expect(fleet.current.pending).toHaveLength(0);
  });

  it("reports an unreachable peer as offline", async () => {
    serverMock.loadFleet.mockResolvedValue([lanPeer("alpha")]);
    serverMock.fleetRead.mockResolvedValue({ ok: false, code: "client.offline" });

    const fleet = new Fleet();
    await fleet.refresh();

    expect(fleet.current.peers[0]?.state).toBe("offline");
  });

  it("lists a cloud peer but never dials it", async () => {
    serverMock.loadFleet.mockResolvedValue([
      { kind: "cloud", target: "dev-1", name: "工作室的 Mac", watchable: false },
    ]);

    const fleet = new Fleet();
    await fleet.refresh();

    expect(serverMock.fleetRead).not.toHaveBeenCalled();
    expect(fleet.current.peers[0]?.state).toBe("unwatchable");
  });

  it("names the active peer so its rows are not drawn twice", async () => {
    serverMock.loadFleet.mockResolvedValue([lanPeer("alpha"), lanPeer("beta")]);

    const fleet = new Fleet();
    await fleet.refresh();
    fleet.setActiveTarget("lan", "http://beta:56789");

    expect(fleet.current.active).toBe(1);
  });

  it("names the active peer whatever case the caller spells the host in", async () => {
    serverMock.loadFleet.mockResolvedValue([
      { kind: "lan", target: "http://mymac.local:56789", name: "Mac", watchable: true },
    ]);

    const fleet = new Fleet();
    await fleet.refresh();
    fleet.setActiveTarget("lan", "http://MyMac.local:56789");

    expect(fleet.current.active).toBe(0);
  });

  it("clears itself where there is no proxy to read", async () => {
    serverMock.loadFleet.mockResolvedValue([lanPeer("alpha")]);
    const fleet = new Fleet();
    await fleet.refresh();
    expect(fleet.current.peers).toHaveLength(1);

    serverMock.loadFleet.mockResolvedValue(null);
    await fleet.refresh();

    expect(fleet.current).toEqual(emptyFleet);
  });
});

describe("Fleet cadence", () => {
  it("sweeps while visible and holds still in the background", async () => {
    vi.useFakeTimers();
    serverMock.loadFleet.mockResolvedValue([lanPeer("alpha")]);
    serverMock.fleetRead.mockResolvedValue({ ok: true, body: [] });

    const fleet = new Fleet();
    await fleet.refresh();
    const readsAfterBoot = serverMock.fleetRead.mock.calls.length;
    fleet.start();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(serverMock.fleetRead.mock.calls.length).toBeGreaterThan(readsAfterBoot);

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    const readsBeforeHidden = serverMock.fleetRead.mock.calls.length;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(serverMock.fleetRead.mock.calls.length).toBe(readsBeforeHidden);

    fleet.stop();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
});

describe("syncFleetPeer", () => {
  it("records a verified computer by appending it", async () => {
    serverMock.loadFleet.mockResolvedValue([
      lanPeer("old"),
      { kind: "cloud", target: "dev-1", name: "Mac", watchable: false },
    ]);

    await syncFleetPeer("lan", "http://new:56789", "new");

    const written = serverMock.saveFleet.mock.calls[0]?.[0] ?? [];
    // The cloud placeholder is dropped: it cannot answer a sweep and would
    // spend one of the four rows a LAN computer needs.
    expect(written).toHaveLength(2);
    expect(written[0]?.target).toBe("http://old:56789");
    expect(written[1]).toMatchObject({ kind: "lan", target: "http://new:56789", name: "new" });
  });

  it("cleans cloud placeholders even when the computer is already watched", async () => {
    serverMock.loadFleet.mockResolvedValue([
      lanPeer("alpha"),
      { kind: "cloud", target: "dev-1", name: "Mac", watchable: false },
    ]);

    await syncFleetPeer("lan", "http://alpha:56789", "alpha");

    const written = serverMock.saveFleet.mock.calls[0]?.[0] ?? [];
    expect(written).toEqual([lanPeer("alpha")]);
  });

  it("removes cloud placeholders when a cloud computer connects", async () => {
    serverMock.loadFleet.mockResolvedValue([
      lanPeer("alpha"),
      { kind: "cloud", target: "dev-1", name: "Mac", watchable: false },
    ]);

    await syncFleetPeer("cloud", "dev-2", "Laptop");

    const written = serverMock.saveFleet.mock.calls[0]?.[0] ?? [];
    expect(written).toEqual([lanPeer("alpha")]);
  });

  it("does not rewrite a watched computer on a reconnect", async () => {
    serverMock.loadFleet.mockResolvedValue([lanPeer("alpha")]);

    await syncFleetPeer("lan", "http://alpha:56789", "alpha");

    expect(serverMock.saveFleet).not.toHaveBeenCalled();
  });

  it("updates a watched computer in place instead of reordering the list", async () => {
    serverMock.loadFleet.mockResolvedValue([lanPeer("alpha"), lanPeer("beta")]);

    await syncFleetPeer("lan", "http://beta:56789", "beta renamed");

    const written = serverMock.saveFleet.mock.calls[0]?.[0] ?? [];
    expect(written.map((entry) => entry.target)).toEqual([
      "http://alpha:56789",
      "http://beta:56789",
    ]);
    expect(written[1]?.name).toBe("beta renamed");
  });

  it("leaves a full list alone rather than dropping a watched computer", async () => {
    serverMock.loadFleet.mockResolvedValue([
      lanPeer("a"),
      lanPeer("b"),
      lanPeer("c"),
      lanPeer("d"),
    ]);

    await syncFleetPeer("lan", "http://e:56789", "e");

    expect(serverMock.saveFleet).not.toHaveBeenCalled();
  });

  it("recognises a watched computer whatever case its host was spelled in", async () => {
    serverMock.loadFleet.mockResolvedValue([
      { kind: "lan", target: "http://mymac.local:56789", name: "Mac", watchable: true },
    ]);

    await syncFleetPeer("lan", "http://MyMac.local:56789", "Mac");

    // The existing row is the same computer, so nothing is appended.
    expect(serverMock.saveFleet).not.toHaveBeenCalled();
  });

  it("recognises a watched computer that omitted its default port", async () => {
    serverMock.loadFleet.mockResolvedValue([
      { kind: "lan", target: "http://mymac.local:80", name: "Mac", watchable: true },
    ]);

    await syncFleetPeer("lan", "http://mymac.local", "Mac");

    expect(serverMock.saveFleet).not.toHaveBeenCalled();
  });
});

describe("forgetFleetPeer", () => {
  it("removes the computer wherever its row sits", async () => {
    serverMock.loadFleet.mockResolvedValue([
      lanPeer("alpha"),
      lanPeer("beta"),
      lanPeer("gamma"),
    ]);

    await forgetFleetPeer("lan", "http://beta:56789");

    const written = serverMock.saveFleet.mock.calls[0]?.[0] ?? [];
    expect(written.map((entry) => entry.target)).toEqual([
      "http://alpha:56789",
      "http://gamma:56789",
    ]);
  });

  it("does nothing for a computer that is not watched", async () => {
    serverMock.loadFleet.mockResolvedValue([lanPeer("alpha")]);

    await forgetFleetPeer("lan", "http://other:56789");

    expect(serverMock.saveFleet).not.toHaveBeenCalled();
  });

  it("recognises the forgotten computer whatever case its host was spelled in", async () => {
    serverMock.loadFleet.mockResolvedValue([
      { kind: "lan", target: "http://mymac.local:80", name: "Mac", watchable: true },
    ]);

    await forgetFleetPeer("lan", "http://MyMac.local");

    expect(serverMock.saveFleet).toHaveBeenCalledWith([]);
  });
});

describe("peerTone", () => {
  it("matches the app's status dots", () => {
    expect(peerTone("online")).toBe("ok");
    expect(peerTone("unauthorized")).toBe("warn");
    expect(peerTone("offline")).toBe("bad");
    expect(peerTone("unwatchable")).toBe("idle");
    expect(peerTone("unknown")).toBe("idle");
  });
});
