import { beforeEach, describe, expect, it } from "vitest";
import { loadCloudWatch, saveCloudWatch } from "./cloudWatchPref";

describe("cloud watch preference", () => {
  beforeEach(() => localStorage.clear());

  it("is off until the person turns it on", () => {
    expect(loadCloudWatch()).toBe(false);
    saveCloudWatch(true);
    expect(loadCloudWatch()).toBe(true);
  });

  it("remembers turning it back off", () => {
    saveCloudWatch(true);
    saveCloudWatch(false);
    expect(loadCloudWatch()).toBe(false);
  });
});
