import { afterEach, describe, expect, it } from "vitest";
import { applyChatFont, isChatFont, loadChatFont, saveChatFont } from "./chatFont";

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-chat-font");
});

describe("chatFont", () => {
  it("defaults to standard", () => {
    expect(loadChatFont()).toBe("standard");
  });

  it("round-trips the larger sizes", () => {
    saveChatFont("lg");
    expect(loadChatFont()).toBe("lg");
    saveChatFont("xl");
    expect(loadChatFont()).toBe("xl");
  });

  it("returns to the default once the choice is cleared", () => {
    saveChatFont("lg");
    saveChatFont("standard");
    expect(localStorage.getItem("reasonix.chat-font.v1")).toBeNull();
    expect(loadChatFont()).toBe("standard");
  });

  it("rejects values that are not a size", () => {
    expect(isChatFont("lg")).toBe(true);
    expect(isChatFont("huge")).toBe(false);
    expect(isChatFont(null)).toBe(false);
  });

  it("applies the choice as a root attribute and clears it on default", () => {
    applyChatFont("lg");
    expect(document.documentElement.getAttribute("data-chat-font")).toBe("lg");
    applyChatFont("standard");
    expect(document.documentElement.getAttribute("data-chat-font")).toBeNull();
  });
});
