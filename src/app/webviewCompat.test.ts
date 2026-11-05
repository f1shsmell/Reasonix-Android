import { describe, expect, it } from "vitest";
import { STUDIO_MIN_CHROME, chromeMajor, needsStudioUpgrade } from "./webviewCompat";

describe("webviewCompat", () => {
  it("reads the Chrome major from a real WebView agent", () => {
    // The agent the reported Android 12 phone sent before its WebView was
    // updated: 96 is far below anything the Studio page can use.
    const webView =
      "Mozilla/5.0 (Linux; Android 12; Redmi K30 Pro Zoom Edition Build/SKQ1.211006.001; wv) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/96.0.4664.104 Mobile Safari/537.36";
    expect(chromeMajor(webView)).toBe(96);
  });

  it("reads a modern agent, including the app's own marker", () => {
    const modern =
      "Mozilla/5.0 (Linux; Android 12; Redmi K30 Pro Zoom Edition) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/158.0.8127.2 Mobile Safari/537.36 reasonix-studio/1";
    expect(chromeMajor(modern)).toBe(158);
  });

  it("reports unknown as 0 instead of guessing", () => {
    // The app's own outbound UA carries no Chrome token. Treating that as
    // "ancient" would nag every user of a modern phone.
    expect(chromeMajor("reasonix-android/0.2.7 (Redmi K30 Pro Zoom Edition)")).toBe(0);
    expect(chromeMajor("")).toBe(0);
    expect(chromeMajor(null)).toBe(0);
    expect(chromeMajor(undefined)).toBe(0);
    expect(chromeMajor("Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/131.0")).toBe(0);
    expect(chromeMajor("Chrome/")).toBe(0);
    expect(chromeMajor("Chrome/abc")).toBe(0);
  });

  it("only flags an engine known to be older than the page needs", () => {
    expect(needsStudioUpgrade(96)).toBe(true);
    expect(needsStudioUpgrade(STUDIO_MIN_CHROME - 1)).toBe(true);
    // oklch() and color-mix() arrived in 111; nothing to warn about from there.
    expect(needsStudioUpgrade(STUDIO_MIN_CHROME)).toBe(false);
    expect(needsStudioUpgrade(158)).toBe(false);
    // Unknown is not old.
    expect(needsStudioUpgrade(0)).toBe(false);
  });
});
