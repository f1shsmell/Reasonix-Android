/**
 * The order the app tries remembered LAN addresses in.
 *
 * A computer can be behind two doors at once — its Wi-Fi address and a mesh
 * VPN one — and they are not equal: the direct door costs no tunnel. The
 * proxy orders them (it is the side that can see the interfaces); this checks
 * the app spends that order instead of inventing its own.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "../net/server";

const savedRows = vi.hoisted(() => ({
  current: [] as {
    kind: "lan" | "cloud";
    target: string;
    name: string;
    usedAt: number;
    order: number;
  }[],
}));

vi.mock("../net/savedConnections", () => ({
  loadConnections: () => savedRows.current,
  latestConnection: (kind: string) =>
    savedRows.current.find((row) => row.kind === kind) ?? null,
  originName: (origin: string) => origin,
  normalizeTarget: (_kind: string, target: string) => target.trim().replace(/\/+$/, ""),
  rememberConnection: () => [],
}));

const { lanDoorsOf, orderedDoors } = await import("./useLink");

function config(patch: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    origin: "",
    candidates: [],
    paired: true,
    account: { signedIn: false },
    ...patch,
  };
}

afterEach(() => {
  savedRows.current = [];
});

describe("lanDoorsOf", () => {
  it("follows the proxy's direct-first order", () => {
    // The tunnel address was paired later, so it heads `candidates`.
    const doors = lanDoorsOf(
      config({
        candidates: ["http://172.16.2.59:57074", "http://192.168.5.3:57074"],
        preferred: ["http://192.168.5.3:57074", "http://172.16.2.59:57074"],
      }),
    );

    expect(doors).toEqual(["http://192.168.5.3:57074", "http://172.16.2.59:57074"]);
  });

  it("still tries every door when the proxy named no order", () => {
    // A browser dev session, or a build older than `preferred`.
    const doors = lanDoorsOf(
      config({
        origin: "http://172.16.2.59:57074",
        candidates: ["http://172.16.2.59:57074", "http://192.168.5.3:57074"],
      }),
    );

    expect(doors).toEqual(["http://172.16.2.59:57074", "http://192.168.5.3:57074"]);
  });

  it("keeps a saved address the proxy never heard of", () => {
    savedRows.current = [
      { kind: "lan", target: "http://10.0.0.9:8791", name: "10.0.0.9", usedAt: 0, order: 0 },
    ];

    const doors = lanDoorsOf(
      config({ candidates: ["http://192.168.5.3:57074"], preferred: ["http://192.168.5.3:57074"] }),
    );

    // The proxy's order wins for what it knows; a row only the app remembers
    // is still a door, at the end.
    expect(doors).toEqual(["http://192.168.5.3:57074", "http://10.0.0.9:8791"]);
  });

  it("does not list the same address twice", () => {
    savedRows.current = [
      {
        kind: "lan",
        target: "http://192.168.5.3:57074",
        name: "192.168.5.3",
        usedAt: 0,
        order: 0,
      },
    ];

    const doors = lanDoorsOf(
      config({
        origin: "http://192.168.5.3:57074",
        candidates: ["http://192.168.5.3:57074"],
        preferred: ["http://192.168.5.3:57074"],
      }),
    );

    expect(doors).toEqual(["http://192.168.5.3:57074"]);
  });

  it("has nothing to try without a proxy or a saved row", () => {
    expect(lanDoorsOf(null)).toEqual([]);
    expect(lanDoorsOf(config())).toEqual([]);
  });
});

describe("orderedDoors", () => {
  function row(kind: "lan" | "cloud", target: string, order: number) {
    return { kind, target, name: target, usedAt: 0, order };
  }

  it("walks the saved list in the order the person arranged", () => {
    savedRows.current = [
      row("lan", "http://home:1", 0),
      row("lan", "http://office:2", 1),
      row("cloud", "dev-1", 2),
    ];

    // Not "LAN first, account last": the list is the order, so a cloud door
    // may sit wherever it was dragged to.
    expect(orderedDoors(config(), savedRows.current)).toEqual([
      { kind: "lan", target: "http://home:1", name: "http://home:1" },
      { kind: "lan", target: "http://office:2", name: "http://office:2" },
      { kind: "cloud", target: "dev-1", name: "dev-1" },
    ]);
  });

  it("puts a proxy address the app never recorded after the saved ones", () => {
    savedRows.current = [row("lan", "http://home:1", 0)];

    const doors = orderedDoors(
      config({
        origin: "http://proxy:9",
        candidates: ["http://proxy:9", "http://other:8"],
        preferred: ["http://other:8", "http://proxy:9"],
      }),
      savedRows.current,
    );

    // An address somebody ranked must not be overtaken by one only the proxy
    // remembers; among those, the proxy's own order still decides.
    expect(doors.map((door) => door.target)).toEqual([
      "http://home:1",
      "http://proxy:9",
      "http://other:8",
    ]);
  });

  it("does not repeat a target the proxy and the saved list share", () => {
    savedRows.current = [row("lan", "http://home:1", 0)];

    const doors = orderedDoors(
      config({ origin: "http://home:1", candidates: ["http://home:1"] }),
      savedRows.current,
    );

    expect(doors).toEqual([{ kind: "lan", target: "http://home:1", name: "http://home:1" }]);
  });

  it("leaves out what this attempt already tried", () => {
    savedRows.current = [row("lan", "http://home:1", 0), row("lan", "http://office:2", 1)];

    const doors = orderedDoors(config(), savedRows.current, ["lan:http://home:1"]);

    expect(doors.map((door) => door.target)).toEqual(["http://office:2"]);
  });

  it("keeps the relay device as the last cloud door", () => {
    savedRows.current = [row("lan", "http://home:1", 0)];

    const doors = orderedDoors(
      config({ mode: "relay", relayDevice: "dev-7", account: { signedIn: true } }),
      savedRows.current,
    );

    expect(doors).toEqual([
      { kind: "lan", target: "http://home:1", name: "http://home:1" },
      { kind: "cloud", target: "dev-7" },
    ]);
  });

  it("has nothing to walk when neither the app nor the proxy knows a door", () => {
    expect(orderedDoors(config(), [])).toEqual([]);
    expect(orderedDoors(null, [])).toEqual([]);
  });
});
