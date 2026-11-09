/**
 * What the saved list can say about two doors.
 *
 * Three answers, because two of them lead to different fixes: a proven other
 * computer is never opened automatically, while an unnamed one is only kept
 * out of a transport switch. These cases pin both, plus the fallbacks that
 * must not invent an identity.
 */

import { describe, expect, it } from "vitest";
import { machineRelation } from "./sameMachine";
import type { SavedConnection } from "./savedConnections";

function row(
  patch: Partial<SavedConnection> & Pick<SavedConnection, "kind" | "target">,
): SavedConnection {
  return { name: patch.target, usedAt: 0, order: 0, ...patch };
}

const LAN = "http://192.168.5.3:57074";
const CLOUD = "device-abc";

describe("machineRelation", () => {
  it("recognises one computer behind a LAN door and a cloud door", () => {
    const rows = [
      row({ kind: "lan", target: LAN, machine: "MacBook-Pro" }),
      row({ kind: "cloud", target: CLOUD, machine: "MacBook-Pro" }),
    ];

    expect(
      machineRelation(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD }),
    ).toBe("same");
  });

  it("ignores case and repeated spaces in the machine name", () => {
    const rows = [
      row({ kind: "lan", target: LAN, machine: "  MacBook   Pro " }),
      row({ kind: "cloud", target: CLOUD, machine: "macbook pro" }),
    ];

    expect(
      machineRelation(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD }),
    ).toBe("same");
  });

  it("proves another computer even when their labels look alike", () => {
    const rows = [
      row({ kind: "lan", target: LAN, name: "MacBook-Pro", machine: "MacBook-Pro" }),
      row({ kind: "cloud", target: CLOUD, name: "MacBook-Pro", machine: "MacBook-Pro-2" }),
    ];

    expect(
      machineRelation(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD }),
    ).toBe("different");
  });

  it("treats a cloud row's account name as its identity without a learned machine", () => {
    // Cloud rows written before the identity field existed were named by the
    // account's device list, which is the computer's own name.
    const rows = [
      row({ kind: "lan", target: LAN, machine: "MacBook-Pro" }),
      row({ kind: "cloud", target: CLOUD, name: "MacBook-Pro" }),
    ];

    expect(
      machineRelation(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD }),
    ).toBe("same");
  });

  it("is unknown when the saved list has never seen a door", () => {
    const rows = [row({ kind: "cloud", target: CLOUD, machine: "MacBook-Pro" })];

    expect(
      machineRelation(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD }),
    ).toBe("unknown");
  });

  it("does not read a LAN row's address as a machine name", () => {
    // A LAN row is named by its host:port, which says nothing about which
    // computer answers there. Calling that "different" would refuse a door
    // that may well be the same machine.
    const rows = [
      row({ kind: "lan", target: LAN, name: "192.168.5.3:57074" }),
      row({ kind: "cloud", target: CLOUD, name: "MacBook-Pro", machine: "MacBook-Pro" }),
    ];

    expect(
      machineRelation(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD }),
    ).toBe("unknown");
  });

  it("does not read a cloud row's device id as a machine name", () => {
    // A cloud row saved without the account's name is labelled by its device
    // id; that is not an identity, and calling it one would refuse a door the
    // app has simply not named yet.
    const rows = [
      row({ kind: "lan", target: LAN, machine: "MacBook-Pro" }),
      row({ kind: "cloud", target: CLOUD, name: CLOUD }),
    ];

    expect(
      machineRelation(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD }),
    ).toBe("unknown");
  });

  it("matches a target spelled with a trailing slash", () => {
    const rows = [
      row({ kind: "lan", target: LAN, machine: "MacBook-Pro" }),
      row({ kind: "cloud", target: CLOUD, machine: "MacBook-Pro" }),
    ];

    expect(
      machineRelation(
        rows,
        { kind: "lan", target: `${LAN}/` },
        { kind: "cloud", target: CLOUD },
      ),
    ).toBe("same");
  });
});
