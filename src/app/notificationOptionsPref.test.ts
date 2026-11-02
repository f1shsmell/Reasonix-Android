import { beforeEach, describe, expect, it } from "vitest";
import { loadNotificationOptions, saveNotificationOptions } from "./notificationOptionsPref";

describe("notification options preference", () => {
  beforeEach(() => localStorage.clear());

  it("keeps 去回答 as the default", () => {
    expect(loadNotificationOptions()).toBe(false);
    saveNotificationOptions(true);
    expect(loadNotificationOptions()).toBe(true);
  });

  it("remembers turning inline options back off", () => {
    saveNotificationOptions(true);
    saveNotificationOptions(false);
    expect(loadNotificationOptions()).toBe(false);
  });
});
