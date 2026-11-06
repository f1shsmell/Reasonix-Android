import { describe, expect, it } from "vitest";
import { clockText, compactCount, relativeTime } from "./format";

/** Fixed reference point: 2026-06-15 12:00 local time. */
const NOW = new Date(2026, 5, 15, 12, 0).getTime();

describe("compactCount", () => {
  it("leaves small numbers alone", () => {
    expect(compactCount(42)).toBe("42");
  });

  it("prints k below the round-up point", () => {
    expect(compactCount(999_499)).toBe("999.5k");
  });

  it("rounds up into M instead of printing 1000k", () => {
    expect(compactCount(999_500)).toBe("1.0M");
  });

  it("trims millions to one decimal", () => {
    expect(compactCount(1_234_567)).toBe("1.2M");
  });
});

describe("relativeTime", () => {
  it("says nothing for a stamp it does not have", () => {
    expect(relativeTime(undefined, NOW)).toBe("");
    expect(relativeTime(0, NOW)).toBe("");
  });

  it("reads anything under a minute as just now", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("刚刚");
  });

  it("counts minutes", () => {
    expect(relativeTime(NOW - 60_000, NOW)).toBe("1 分钟前");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
  });

  it("counts hours", () => {
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe("1 小时前");
    expect(relativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe("23 小时前");
  });

  it("counts days up to a week", () => {
    expect(relativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe("1 天前");
    expect(relativeTime(NOW - 6 * 24 * 60 * 60_000, NOW)).toBe("6 天前");
  });

  it("falls back to a date within the same year", () => {
    expect(relativeTime(new Date(2026, 5, 1, 12, 0).getTime(), NOW)).toBe("6 月 1 日");
  });

  it("names the year once the stamp is from another one", () => {
    expect(relativeTime(new Date(2025, 10, 30, 12, 0).getTime(), NOW)).toBe("2025 年 11 月 30 日");
  });
});

describe("clockText", () => {
  it("says nothing for a stamp it cannot read", () => {
    expect(clockText(Number.NaN)).toBe("");
  });

  it("renders a fixed timestamp as two-digit HH:MM", () => {
    const text = clockText(new Date(2026, 5, 15, 14, 30).getTime());
    // The clock follows the phone: a 12-hour locale shows "02:30 PM" and a
    // 24-hour one "14:30", so only the leading digits and the minute are
    // asserted — both begin with two digits, a colon, two more.
    expect(text).toMatch(/^\d{2}:\d{2}/);
    expect(text.slice(3, 5)).toBe("30");
  });
});
