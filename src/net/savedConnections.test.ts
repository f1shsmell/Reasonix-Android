import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetCloudConnections,
  forgetConnection,
  latestConnection,
  loadConnections,
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

  it("moves a repeat to the front instead of adding a second row", () => {
    rememberConnection("lan", "http://a:1");
    rememberConnection("cloud", "dev-1");
    const rows = rememberConnection("lan", "http://a:1/");
    expect(rows.map((row) => row.target)).toEqual(["http://a:1", "dev-1"]);
  });

  it("lets a later computer name replace an id", () => {
    rememberConnection("cloud", "dev-1");
    const rows = rememberConnection("cloud", "dev-1", "工作室的 Mac");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("工作室的 Mac");
  });

  it("keeps the eight most recent and drops the rest", () => {
    for (let index = 0; index < 10; index += 1) rememberConnection("cloud", `dev-${index}`);
    const rows = loadConnections();
    expect(rows).toHaveLength(8);
    expect(rows[0]?.target).toBe("dev-9");
    expect(rows.some((row) => row.target === "dev-0")).toBe(false);
  });

  it("ignores a target that cannot be used", () => {
    expect(rememberConnection("lan", "")).toEqual([]);
    expect(rememberConnection("lan", "not a url")).toEqual([]);
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
