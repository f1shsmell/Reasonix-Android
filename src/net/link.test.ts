import { describe, expect, it } from "vitest";
import {
  Backoff,
  connectingLink,
  idleLink,
  linkFailure,
  linkSummary,
  linkTone,
  stepLabel,
} from "./link";

describe("link steps and summary", () => {
  it("names the three stages", () => {
    expect(stepLabel("probe")).toContain("查找");
    expect(stepLabel("switch")).toContain("切换");
    expect(stepLabel("verify")).toContain("读取");
  });

  it("summarises every phase", () => {
    expect(linkSummary(idleLink)).toBe("未连接");
    expect(linkSummary({ ...idleLink, phase: "connecting", step: "verify" })).toContain("读取");
    expect(linkSummary({ ...idleLink, phase: "connected", mode: "lan" })).toBe("局域网已连接");
    expect(linkSummary({ ...idleLink, phase: "connected", mode: "cloud" })).toBe("云端已连接");
    expect(linkSummary({ ...idleLink, phase: "reconnecting", attempt: 3 })).toContain("第 3 次");
    expect(linkSummary({ ...idleLink, phase: "failed" })).toBe("连接失败");
  });

  it("colours a phase without making colour the only signal", () => {
    expect(linkTone({ ...idleLink, phase: "connected" })).toBe("ok");
    expect(linkTone({ ...idleLink, phase: "reconnecting" })).toBe("warn");
    expect(linkTone({ ...idleLink, phase: "failed" })).toBe("bad");
  });

  it("marks earlier steps done when an attempt moves on", () => {
    const next = connectingLink("switch", { ...idleLink, target: "http://a", name: "a" });
    expect(next.phase).toBe("connecting");
    expect(next.step).toBe("switch");
    expect(next.completed).toEqual(["probe"]);
    expect(next.target).toBe("http://a");
  });
});

describe("linkFailure", () => {
  it("does not retry an authorization failure", () => {
    for (const code of ["device.unauthorized", "http.401", "http.403", "account.signed_out"]) {
      expect(linkFailure(code).retryable).toBe(false);
    }
  });

  it("retries a network failure", () => {
    for (const code of ["client.offline", "client.timeout", "http.502", "proxy.upstream_unreachable"]) {
      expect(linkFailure(code).retryable).toBe(true);
    }
  });

  it("has nothing to retry when no door was ever recorded", () => {
    const error = linkFailure("no.doors");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("设置");
  });

  it("keeps the code and the detail for a disclosure", () => {
    const error = linkFailure("client.offline", "connect ECONNREFUSED");
    expect(error.code).toBe("client.offline");
    expect(error.detail).toBe("connect ECONNREFUSED");
  });
});

describe("Backoff", () => {
  it("grows, caps, and counts the attempts it handed out", () => {
    const backoff = new Backoff(1_000, 4_000, 3, () => 0.5);
    expect(backoff.next()).toBe(750);
    expect(backoff.next()).toBe(1_500);
    expect(backoff.next()).toBe(3_000);
    expect(backoff.exhausted).toBe(true);
    expect(backoff.next()).toBe(3_000);
  });

  it("never returns zero, even when the random half is zero", () => {
    const backoff = new Backoff(1_000, 30_000, 8, () => 0);
    expect(backoff.next()).toBe(500);
  });

  it("starts over after a success", () => {
    const backoff = new Backoff(1_000, 30_000, 2, () => 0.5);
    backoff.next();
    backoff.next();
    expect(backoff.exhausted).toBe(true);
    backoff.reset();
    expect(backoff.exhausted).toBe(false);
    expect(backoff.next()).toBe(750);
  });
});
