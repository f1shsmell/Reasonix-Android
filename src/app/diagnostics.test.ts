import { describe, expect, it, vi } from "vitest";
import { buildDiagnostics } from "./diagnostics";
import type { LinkState } from "../net/link";
import type { ConnectionSnapshot } from "../net/connection";

vi.mock("../native/turn", () => ({
  readNativeDiagnostics: vi.fn(async () => ({
    version: "0.2.2",
    build: 12,
    android: "14",
    sdk: 34,
    model: "Pixel 8",
    manufacturer: "Google",
    exempt: false,
    notifications: true,
    cloud: {
      active: true,
      cloud: true,
      visible: false,
      pending: false,
      misses: 0,
      watches: 1,
      code: "ok",
      runtimes: 1,
      statuses: 1,
      asks: 1,
    },
  })),
}));
vi.mock("../native/networkWatch", () => ({
  readNetworkStatus: vi.fn(async () => ({
    connected: true,
    connectionType: "wifi",
    validated: true,
    networkKey: "42",
  })),
}));

const link: LinkState = {
  phase: "connected",
  mode: "cloud",
  target: "dev1",
  name: "工作室的 Mac",
  completed: [],
  attempt: 0,
};

const snapshot: ConnectionSnapshot = {
  reach: { kind: "ok" },
  runtimes: [],
  stream: { kind: "open" },
};

describe("buildDiagnostics", () => {
  it("names the build, route, network and last error without chat data", async () => {
    const text = await buildDiagnostics({
      link: { ...link, error: { code: "client.offline", message: "offline", retryable: true } },
      snapshot,
      cloudWatch: true,
    });

    expect(text).toContain("Reasonix For Android");
    expect(text).toContain("Android 14 (API 34)");
    expect(text).toContain("connected · cloud · dev1 · 工作室的 Mac");
    expect(text).toContain("client.offline");
    expect(text).toContain("Reach: ok");
    expect(text).toContain("Stream: open");
    expect(text).toContain("wifi");
    expect(text).toContain("Cloud background reminders: on");
    expect(text).toContain("Cloud watch: active");
    expect(text).toContain("Cloud sweep: last=ok · runtimes=1 · statuses=1 · asks=1");
    expect(text).not.toContain("token");
    expect(text).not.toContain("cookie");
  });

  it("keeps an unreachable detail for the report", async () => {
    const text = await buildDiagnostics({
      link,
      snapshot: {
        ...snapshot,
        reach: { kind: "unreachable", detail: "connection refused" },
      },
      cloudWatch: false,
    });

    expect(text).toContain("Reach: unreachable · connection refused");
  });
});
