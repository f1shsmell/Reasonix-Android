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

const savedRows = vi.hoisted(() => ({ current: [] as { kind: string; target: string }[] }));

vi.mock("../net/savedConnections", () => ({
  loadConnections: () => savedRows.current,
  latestConnection: () => null,
  originName: (origin: string) => origin,
  rememberConnection: () => [],
}));

const { lanDoorsOf } = await import("./useLink");

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
    savedRows.current = [{ kind: "lan", target: "http://10.0.0.9:8791" }];

    const doors = lanDoorsOf(
      config({ candidates: ["http://192.168.5.3:57074"], preferred: ["http://192.168.5.3:57074"] }),
    );

    // The proxy's order wins for what it knows; a row only the app remembers
    // is still a door, at the end.
    expect(doors).toEqual(["http://192.168.5.3:57074", "http://10.0.0.9:8791"]);
  });

  it("does not list the same address twice", () => {
    savedRows.current = [{ kind: "lan", target: "http://192.168.5.3:57074" }];

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
