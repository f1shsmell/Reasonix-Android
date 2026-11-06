import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCloudWatchBridge, sweepCloud } from "./cloudWatch";

const relay = vi.hoisted(() => ({
  relayAlive: vi.fn(),
  relayDevice: vi.fn(),
  ensureRelay: vi.fn(),
}));
const http = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));

vi.mock("./relay", () => relay);
vi.mock("./http", () => http);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  relay.relayAlive.mockReturnValue(true);
  relay.relayDevice.mockReturnValue("dev1");
  relay.ensureRelay.mockResolvedValue(undefined);
});

/** One alias for the bridge so the tests below do not each dangle an underscore. */
const decide = (payload: string | { path: string; body: string }): void => {
  window.__reasonixCloudDecide?.(payload);
};

afterEach(() => vi.clearAllMocks());

describe("sweepCloud", () => {
  it("reads the pane list and each pane's status", async () => {
    http.fetchWithTimeout.mockImplementation(async (url: string) => {
      if (url === "/runtimes") {
        return json([
          { id: "r1", base: "/rt/r1", root: "/w", name: "app", readOnly: false },
        ]);
      }
      return json({ running: true, decisions: [] });
    });

    const snapshot = await sweepCloud();

    expect(snapshot.ok).toBe(true);
    expect(snapshot.runtimes).toHaveLength(1);
    expect(snapshot.statuses.r1).toMatchObject({ running: true });
  });

  it("reports offline when there is no relay and no remembered device", async () => {
    relay.relayAlive.mockReturnValue(false);
    relay.relayDevice.mockReturnValue(null);

    const snapshot = await sweepCloud();

    expect(snapshot).toEqual({
      ok: false,
      code: "relay.offline",
      runtimes: [],
      statuses: {},
    });
    expect(relay.ensureRelay).not.toHaveBeenCalled();
  });

  it("rebuilds the relay once when the device is known", async () => {
    relay.relayAlive.mockReturnValue(false);
    http.fetchWithTimeout.mockResolvedValue(json([]));

    await sweepCloud();

    expect(relay.ensureRelay).toHaveBeenCalledWith("dev1");
  });

  it("keeps the pane list when one status read fails", async () => {
    http.fetchWithTimeout.mockImplementation(async (url: string) => {
      if (url === "/runtimes") {
        return json([{ id: "r1", base: "/rt/r1", root: "/w", name: "app" }]);
      }
      return new Response(null, { status: 503 });
    });

    const snapshot = await sweepCloud();

    expect(snapshot.ok).toBe(true);
    expect(snapshot.runtimes).toHaveLength(1);
    expect(snapshot.statuses).toEqual({});
  });

  it("posts a notification decision through the same relay", async () => {
    installCloudWatchBridge();
    http.fetchWithTimeout.mockResolvedValue(new Response(null, { status: 204 }));

    decide({
      path: "/rt/r1/approve",
      body: "{\"id\":\"d1\",\"allow\":true}",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(http.fetchWithTimeout).toHaveBeenCalledWith(
      "/rt/r1/approve",
      expect.objectContaining({
        method: "POST",
        body: "{\"id\":\"d1\",\"allow\":true}",
      }),
      15_000,
    );
  });

  it("parses the quoted string payload the native side hands over", async () => {
    // MainActivity quotes the whole payload into a JS string literal; the
    // page side must JSON.parse it before validating.
    installCloudWatchBridge();
    http.fetchWithTimeout.mockResolvedValue(new Response(null, { status: 204 }));

    decide(JSON.stringify({ path: "/rt/r1/answer", body: "{\"id\":\"d2\",\"answers\":[]}" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(http.fetchWithTimeout).toHaveBeenCalledWith(
      "/rt/r1/answer",
      expect.objectContaining({
        method: "POST",
        body: "{\"id\":\"d2\",\"answers\":[]}",
      }),
      15_000,
    );
  });

  it("ignores a string payload that is not an object", async () => {
    installCloudWatchBridge();
    http.fetchWithTimeout.mockClear();

    decide("not json");
    decide(JSON.stringify("just a string"));
    await Promise.resolve();
    await Promise.resolve();

    expect(http.fetchWithTimeout).not.toHaveBeenCalled();
  });
});
