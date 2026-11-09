import { beforeEach, describe, expect, it } from "vitest";
import { loadAutoHandover, saveAutoHandover } from "./handoverPref";

describe("automatic handover preference", () => {
  beforeEach(() => localStorage.clear());

  it("allows handovers until the person turns them off", () => {
    expect(loadAutoHandover()).toBe(true);
    saveAutoHandover(false);
    expect(loadAutoHandover()).toBe(false);
  });

  it("remembers turning it back on", () => {
    saveAutoHandover(false);
    saveAutoHandover(true);
    expect(loadAutoHandover()).toBe(true);
  });
});
