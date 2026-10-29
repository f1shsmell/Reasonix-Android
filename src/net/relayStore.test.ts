import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRelayDevice, loadRelayDevice, saveRelayDevice } from "./relayStore";

/**
 * The saved device is only a fallback hint. It must survive a LAN switch
 * (where the proxy drops `relayDevice`) and be cleared on sign-out, or a
 * later LAN failure would try to reconnect a device the account no longer
 * knows.
 */
describe("relay device hint", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("is absent until a cloud device has been used", () => {
    expect(loadRelayDevice()).toBeNull();
  });

  it("remembers and replaces the device", () => {
    saveRelayDevice("one");
    expect(loadRelayDevice()).toBe("one");
    saveRelayDevice("two");
    expect(loadRelayDevice()).toBe("two");
  });

  it("ignores an empty device and can be cleared on sign-out", () => {
    saveRelayDevice("one");
    saveRelayDevice("");
    expect(loadRelayDevice()).toBe("one");
    clearRelayDevice();
    expect(loadRelayDevice()).toBeNull();
  });
});
