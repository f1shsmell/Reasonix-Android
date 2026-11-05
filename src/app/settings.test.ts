import { beforeEach, describe, expect, it } from "vitest";
import {
  migrateSettings,
  readChoice,
  readFlag,
  readRaw,
  SETTINGS_KEYS,
  writeChoice,
  writeFlag,
} from "./settings";

describe("settings store", () => {
  beforeEach(() => localStorage.clear());

  it("reads only an allowed choice and falls back otherwise", () => {
    expect(readChoice("test.choice", ["a", "b"], "a")).toBe("a");
    localStorage.setItem("test.choice", "b");
    expect(readChoice("test.choice", ["a", "b"], "a")).toBe("b");
    localStorage.setItem("test.choice", "c");
    expect(readChoice("test.choice", ["a", "b"], "a")).toBe("a");
  });

  it("stores only a difference from the default", () => {
    writeChoice("test.choice", "a", "a");
    expect(localStorage.getItem("test.choice")).toBeNull();
    writeChoice("test.choice", "b", "a");
    expect(localStorage.getItem("test.choice")).toBe("b");
  });

  it("reads and writes flags with the same rule", () => {
    expect(readFlag("test.flag", true)).toBe(true);
    writeFlag("test.flag", true, true);
    expect(localStorage.getItem("test.flag")).toBeNull();
    writeFlag("test.flag", false, true);
    expect(readFlag("test.flag", true)).toBe(false);
    expect(readFlag("test.flag", false)).toBe(false);
  });

  it("keeps every setting key distinct", () => {
    const keys = [
      SETTINGS_KEYS.theme,
      SETTINGS_KEYS.enter,
      SETTINGS_KEYS.netPolicy,
      SETTINGS_KEYS.chatFont,
      SETTINGS_KEYS.folding,
      SETTINGS_KEYS.notificationOptions,
      SETTINGS_KEYS.cloudWatch,
      ...Object.values(SETTINGS_KEYS.notify),
      ...Object.values(SETTINGS_KEYS.haptics),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("records the layout version once", () => {
    migrateSettings();
    expect(readRaw("reasonix.settings.version")).toBe("1");
  });
});