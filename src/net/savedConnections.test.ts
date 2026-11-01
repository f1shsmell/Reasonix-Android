import { beforeEach, describe, expect, it } from "vitest";
import {
  connectionKey,
  forgetCloudConnections,
  forgetConnection,
  latestConnection,
  loadConnections,
  moveConnection,
  normalizeTarget,
  originName,
  rememberConnection,
} from "./savedConnections";

beforeEach(() => localStorage.clear());

describe("normalizeTarget", () => {
  it("drops the slash a person may have typed after a LAN origin", () => {
    expect(normalizeTarget("lan", " http://192.168.5.2:56789/ ")).toBe("http://192.168.5.2:56789");
  });

  it("refuses an origin that is not http(s)", () => {
    expect(normalizeTarget("lan", "ftp://192.168.5.2")).toBe("");
    expect(normalizeTarget("lan", "192.168.5.2:56789")).toBe("");
  });

  it("trims an opaque cloud id and nothing else", () => {
    expect(normalizeTarget("cloud", " dev-9 ")).toBe("dev-9");
    expect(normalizeTarget("cloud", "   ")).toBe("");
  });
});

describe("originName", () => {
  it("names a corner of the LAN by host and port", () => {
    expect(originName("http://192.168.5.2:56789")).toBe("192.168.5.2:56789");
  });

  it("falls back to the raw value when it is not a URL", () => {
    expect(originName("not a url")).toBe("not a url");
  });
});

describe("rememberConnection", () => {
  it("records a LAN computer under its host", () => {
    const rows = rememberConnection("lan", "http://192.168.5.2:56789/");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "lan",
      target: "http://192.168.5.2:56789",
      name: "192.168.5.2:56789",
    });
    expect(loadConnections()).toEqual(rows);
  });

  it("keeps a repeat where it sits instead of moving it", () => {
    rememberConnection("lan", "http://a:1");
    rememberConnection("cloud", "dev-1");
    rememberConnection("lan", "http://b:2");
    // The person arranged this list; reconnecting to the first computer must
    // not quietly reorder it.
    const rows = rememberConnection("lan", "http://a:1/");
    expect(rows.map((row) => row.target)).toEqual(["http://a:1", "dev-1", "http://b:2"]);
  });

  it("lets a later computer name replace an id", () => {
    rememberConnection("cloud", "dev-1");
    const rows = rememberConnection("cloud", "dev-1", "工作室的 Mac");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("工作室的 Mac");
  });

  it("appends a new computer and keeps the eight oldest slots", () => {
    for (let index = 0; index < 10; index += 1) rememberConnection("cloud", `dev-${index}`);
    const rows = loadConnections();
    // The order is the person's, so a new computer joins at the end and the
    // last slot is what gives way — never a row someone ranked higher.
    expect(rows).toHaveLength(8);
    expect(rows[0]?.target).toBe("dev-0");
    expect(rows[7]?.target).toBe("dev-9");
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("ignores a target that cannot be used", () => {
    expect(rememberConnection("lan", "")).toEqual([]);
    expect(rememberConnection("lan", "not a url")).toEqual([]);
  });
});

describe("ordering", () => {
  function seed(): void {
    rememberConnection("lan", "http://home:1", "家里");
    rememberConnection("lan", "http://office:2", "公司");
    rememberConnection("cloud", "dev-1", "云端电脑");
  }

  it("places a new computer after the ones already ranked", () => {
    seed();
    const rows = loadConnections();
    expect(rows.map((row) => row.name)).toEqual(["家里", "公司", "云端电脑"]);
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2]);
  });

  it("moves a row to a slot and renumbers the rest", () => {
    seed();
    const rows = moveConnection(connectionKey("cloud", "dev-1"), 0);
    expect(rows.map((row) => row.name)).toEqual(["云端电脑", "家里", "公司"]);
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2]);
    // The write is what a later read sees, not just the returned value.
    expect(loadConnections().map((row) => row.name)).toEqual(["云端电脑", "家里", "公司"]);
  });

  it("lands a row dropped one slot down before the row it passed", () => {
    seed();
    // `insertAt` answers 2 when the finger is below the second row's middle;
    // the row was at 0, so it must end up second rather than third.
    const rows = moveConnection(connectionKey("lan", "http://home:1"), 2);
    expect(rows.map((row) => row.name)).toEqual(["公司", "家里", "云端电脑"]);
  });

  it("writes nothing when a drop lands where the row already sat", () => {
    seed();
    const before = localStorage.getItem("reasonix.connections.v1");
    const rows = moveConnection(connectionKey("lan", "http://home:1"), 0);
    expect(rows.map((row) => row.name)).toEqual(["家里", "公司", "云端电脑"]);
    expect(localStorage.getItem("reasonix.connections.v1")).toBe(before);
  });

  it("ignores a key that is not in the list", () => {
    seed();
    const rows = moveConnection(connectionKey("lan", "http://nowhere:9"), 0);
    expect(rows.map((row) => row.name)).toEqual(["家里", "公司", "云端电脑"]);
  });

  it("clamps a drop past the end to the last slot", () => {
    seed();
    const rows = moveConnection(connectionKey("lan", "http://home:1"), 99);
    expect(rows.map((row) => row.name)).toEqual(["公司", "云端电脑", "家里"]);
  });

  it("migrates rows written before the order existed, by recency", () => {
    localStorage.setItem(
      "reasonix.connections.v1",
      JSON.stringify([
        { kind: "lan", target: "http://old:1", name: "旧", usedAt: 10 },
        { kind: "cloud", target: "dev-1", name: "新", usedAt: 30 },
        { kind: "lan", target: "http://mid:2", name: "中", usedAt: 20 },
      ]),
    );
    const rows = loadConnections();
    // Newest first is exactly what this list meant before it had an order.
    expect(rows.map((row) => row.name)).toEqual(["新", "中", "旧"]);
    expect(rows.map((row) => row.order)).toEqual([0, 1, 2]);
  });

  it("keeps an explicit order ahead of an unnumbered row", () => {
    localStorage.setItem(
      "reasonix.connections.v1",
      JSON.stringify([
        { kind: "cloud", target: "dev-1", name: "没序号", usedAt: 99 },
        { kind: "lan", target: "http://a:1", name: "排第一", usedAt: 1, order: 0 },
        { kind: "lan", target: "http://b:2", name: "排第二", usedAt: 2, order: 1 },
      ]),
    );
    expect(loadConnections().map((row) => row.name)).toEqual(["排第一", "排第二", "没序号"]);
  });

  it("keeps the ranking when the same computer is reached again", () => {
    seed();
    moveConnection(connectionKey("cloud", "dev-1"), 0);
    // Reaching a computer is not a statement about where it belongs.
    const rows = rememberConnection("lan", "http://office:2", "公司");
    expect(rows.map((row) => row.name)).toEqual(["云端电脑", "家里", "公司"]);
  });
});

describe("forgetting", () => {
  it("forgets one target and leaves the others", () => {
    rememberConnection("lan", "http://a:1");
    rememberConnection("lan", "http://b:2");
    const rows = forgetConnection("lan", "http://a:1/");
    expect(rows.map((row) => row.target)).toEqual(["http://b:2"]);
  });

  it("forgets every cloud row on sign-out but keeps the LAN ones", () => {
    rememberConnection("lan", "http://a:1");
    rememberConnection("cloud", "dev-1");
    const rows = forgetCloudConnections();
    expect(rows.map((row) => row.kind)).toEqual(["lan"]);
  });
});

describe("reading", () => {
  it("survives storage that is not a list", () => {
    localStorage.setItem("reasonix.connections.v1", "{\"nope\":true}");
    expect(loadConnections()).toEqual([]);
  });

  it("skips a row whose target is gone and coalesces duplicates", () => {
    localStorage.setItem(
      "reasonix.connections.v1",
      JSON.stringify([
        { kind: "lan", target: "http://a:1", name: "a", usedAt: 2 },
        { kind: "lan", target: "http://a:1/", name: "a again", usedAt: 1 },
        { kind: "cloud", target: "", name: "x", usedAt: 3 },
        { kind: "weird", target: "http://c:3", name: "c", usedAt: 4 },
      ]),
    );
    const rows = loadConnections();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "lan", target: "http://a:1", usedAt: 2 });
  });

  it("answers the most recent row of one kind", () => {
    rememberConnection("lan", "http://a:1");
    rememberConnection("cloud", "dev-1");
    expect(latestConnection("lan")?.target).toBe("http://a:1");
    expect(latestConnection("cloud")?.target).toBe("dev-1");
    expect(latestConnection("cloud")?.kind).toBe("cloud");
  });

  it("answers nothing for a kind that was never recorded", () => {
    expect(latestConnection("lan")).toBeNull();
  });
});
