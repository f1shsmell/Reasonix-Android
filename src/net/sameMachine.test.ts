/**
 * Whether two doors are the same computer.
 *
 * A handover is only safe when the far side is the kernel that minted the
 * runtime ids on screen. These cases pin the two answers that matter: one
 * computer behind two doors is allowed, and anything the app cannot prove is
 * refused.
 */

import { describe, expect, it } from "vitest";
import { sameMachine } from "./sameMachine";
import type { SavedConnection } from "./savedConnections";

function row(
  patch: Partial<SavedConnection> & Pick<SavedConnection, "kind" | "target">,
): SavedConnection {
  return { name: patch.target, usedAt: 0, order: 0, ...patch };
}

const LAN = "http://192.168.5.3:57074";
const CLOUD = "device-abc";

describe("sameMachine", () => {
  it("recognises one computer behind a LAN door and a cloud door", () => {
    const rows = [
      row({ kind: "lan", target: LAN, machine: "MacBook-Pro" }),
      row({ kind: "cloud", target: CLOUD, machine: "MacBook-Pro" }),
    ];

    expect(sameMachine(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD })).toBe(
      true,
    );
  });

  it("ignores case and repeated spaces in the machine name", () => {
    const rows = [
      row({ kind: "lan", target: LAN, machine: "  MacBook   Pro " }),
      row({ kind: "cloud", target: CLOUD, machine: "macbook pro" }),
    ];

    expect(sameMachine(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD })).toBe(
      true,
    );
  });

  it("refuses two different computers even when their labels look alike", () => {
    const rows = [
      row({ kind: "lan", target: LAN, name: "MacBook-Pro", machine: "MacBook-Pro" }),
      row({ kind: "cloud", target: CLOUD, name: "MacBook-Pro", machine: "MacBook-Pro-2" }),
    ];

    expect(sameMachine(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD })).toBe(
      false,
    );
  });

  it("falls back to the row's name when one side never learned an identity", () => {
    const rows = [
      row({ kind: "lan", target: LAN, name: "MacBook-Pro" }),
      row({ kind: "cloud", target: CLOUD, name: "MacBook-Pro", machine: "MacBook-Pro" }),
    ];

    expect(sameMachine(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD })).toBe(
      true,
    );
  });

  it("refuses a door the saved list has never seen", () => {
    const rows = [row({ kind: "cloud", target: CLOUD, machine: "MacBook-Pro" })];

    expect(sameMachine(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD })).toBe(
      false,
    );
  });

  it("refuses when a LAN row's label is only its address", () => {
    // The host:port a LAN door is named by says nothing about which machine
    // answers there, so it must never be read as an identity.
    const rows = [
      row({ kind: "lan", target: LAN, name: "192.168.5.3:57074" }),
      row({ kind: "cloud", target: CLOUD, name: "MacBook-Pro", machine: "MacBook-Pro" }),
    ];

    expect(sameMachine(rows, { kind: "lan", target: LAN }, { kind: "cloud", target: CLOUD })).toBe(
      false,
    );
  });

  it("matches a target spelled with a trailing slash", () => {
    const rows = [
      row({ kind: "lan", target: LAN, machine: "MacBook-Pro" }),
      row({ kind: "cloud", target: CLOUD, machine: "MacBook-Pro" }),
    ];

    expect(
      sameMachine(rows, { kind: "lan", target: `${LAN}/` }, { kind: "cloud", target: CLOUD }),
    ).toBe(true);
  });
});
