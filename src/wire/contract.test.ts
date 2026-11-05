import { describe, expect, it } from "vitest";
import { isRuntimeView } from "../net/connection";
import { parseRuntimeStatus } from "../net/status";
import runtimes from "../../fixtures/wire/runtimes.json";
import fleet from "../../fixtures/wire/fleet.json";
import statusAsk from "../../fixtures/wire/status-ask.json";
import type { RuntimeView } from "./runtime";

/**
 * The same JSON is read by `android/app/src/test/.../*Test.java`.
 *
 * The phone and the native watcher parse kernel answers independently; a
 * contract change that reaches only one side should fail here rather than on
 * a device.
 */
describe("wire fixtures", () => {
  it("keeps every runtime row addressable", () => {
    const rows = runtimes as RuntimeView[];

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(isRuntimeView(row)).toBe(true);
    expect(rows[0]?.base).toBe("/rt/r1");
    expect(rows[0]?.host).toBe("192.168.5.3:57074");
  });

  it("keeps the ask status the native watcher reads", () => {
    const status = parseRuntimeStatus(statusAsk);

    expect(status?.running).toBe(true);
    expect(status?.decisions.map((decision) => decision.id)).toEqual(["d1", "d2"]);
    expect(status?.decisions[0]?.questions?.[0]?.prompt).toBe("先做哪个");
    expect(status?.toolApprovalMode).toBe("ask");
  });

  it("keeps the fleet rows and their watchability", () => {
    expect(fleet.peers).toHaveLength(3);
    expect(fleet.peers[0]?.watchable).toBe(true);
    expect(fleet.peers[1]?.watchable).toBe(false);
    expect(fleet.peers[2]?.name).toBe("");
  });
});
