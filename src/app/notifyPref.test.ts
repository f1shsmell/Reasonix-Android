import { beforeEach, describe, expect, it } from "vitest";
import {
  loadNotificationPref,
  loadNotificationPrefs,
  notificationDefaults,
  saveNotificationPref,
} from "./notifyPref";

/**
 * The defaults are the behaviour being tested, not an implementation detail:
 * `ongoing` ships off because a permanent status-bar icon is the one thing
 * nobody can dismiss, while a blocked turn is the one thing worth interrupting
 * for.
 */
describe("notification prefs", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to a silent ongoing row and an interrupting ask", () => {
    expect(loadNotificationPrefs()).toEqual({
      ongoing: false,
      ask: true,
      done: true,
      headsUp: true,
    });
    expect(notificationDefaults()).toEqual(loadNotificationPrefs());
  });

  it("stores only the difference from the default", () => {
    // Writing the default back must not leave a stored value behind, or a
    // later change to that default would never reach this phone.
    saveNotificationPref("ask", true);
    expect(localStorage.getItem("reasonix.notify.ask")).toBeNull();
    saveNotificationPref("ask", false);
    expect(localStorage.getItem("reasonix.notify.ask")).toBe("off");

    saveNotificationPref("ongoing", false);
    expect(localStorage.getItem("reasonix.notify.ongoing")).toBeNull();
    saveNotificationPref("ongoing", true);
    expect(localStorage.getItem("reasonix.notify.ongoing")).toBe("on");
  });

  it("reads one surface without disturbing the others", () => {
    saveNotificationPref("done", false);
    expect(loadNotificationPref("done")).toBe(false);
    expect(loadNotificationPref("ask")).toBe(true);
    expect(loadNotificationPrefs()).toEqual({
      ongoing: false,
      ask: true,
      done: false,
      headsUp: true,
    });
  });

  it("falls back to the default for an unreadable stored value", () => {
    localStorage.setItem("reasonix.notify.ask", "something else");
    expect(loadNotificationPref("ask")).toBe(false);
    // The fallback is still the default, not "off": anything that is not the
    // stored "on" is off, and the default is what an absent key means.
  });

  it("treats a blocked store as the defaults rather than failing", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });
    try {
      expect(loadNotificationPrefs()).toEqual({
        ongoing: false,
        ask: true,
        done: true,
        headsUp: true,
      });
      expect(() => saveNotificationPref("ask", false)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });
});
