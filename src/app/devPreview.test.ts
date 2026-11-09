import { beforeEach, describe, expect, it } from "vitest";
import { devPreview } from "./devPreview";

/** The harness flags are dev-only; these pin the query parsing. */
describe("devPreview", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("answers nothing without the query flags", () => {
    expect(devPreview()).toBeNull();
  });

  it("draws native-only controls on request", () => {
    window.history.replaceState(null, "", "/?native=1");
    expect(devPreview()).toEqual({ native: true, session: null });
  });

  it("opens a session on request", () => {
    window.history.replaceState(null, "", "/?session=demo");
    expect(devPreview()).toEqual({ native: false, session: "demo" });
  });

  it("ignores blank session names", () => {
    window.history.replaceState(null, "", "/?session=%20%20");
    expect(devPreview()).toBeNull();
  });
});
