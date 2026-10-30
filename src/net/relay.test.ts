import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceFingerprint, pinDevice } from "./deviceTrust";
import { RelayError, RelayEventSource, RelayLink, connectRelay, isKernelPath } from "./relay";

type Handler = (event: { data?: string; code?: number; reason?: string }) => void;

function connection() {
  const listeners = new Map<string, Handler[]>();
  const socket = {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: (type: string, handler: Handler) => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler]);
    },
  };
  const channel = {
    bind: vi.fn(),
    seal: vi.fn(async (value: unknown) => JSON.stringify(value)),
    open: vi.fn(),
  };
  return { socket, channel, listeners };
}

afterEach(() => vi.unstubAllGlobals());

describe("RelayLink", () => {
  it("sends one desktop.request and resolves the response body", async () => {
    const { socket, channel, listeners } = connection();
    let command: Record<string, unknown> = {};
    channel.seal.mockImplementation(async (value: unknown) => {
      command = value as Record<string, unknown>;
      return "sealed";
    });
    channel.open.mockResolvedValue({
      id: "id",
      type: "desktop.response",
      index: 0,
      body: "W10",
      done: true,
      status: 200,
      contentType: "application/json",
    });
    const link = new RelayLink("device", {
      socket: socket as unknown as WebSocket,
      channel,
      features: [],
      instance: "",
    });

    expect(link.device).toBe("device");
    expect(link.isEnded).toBe(false);

    const responsePromise = link.fetch(new Request("http://127.0.0.1:8788/runtimes"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(command.type).toBe("desktop.request");
    expect(command.path).toBe("/runtimes");
    expect(command.method).toBe("GET");
    expect(command.body).toBe("");

    channel.open.mockResolvedValue({
      id: command.id,
      type: "desktop.response",
      index: 0,
      body: "W10",
      done: true,
      status: 200,
      contentType: "application/json",
    });
    const handler = listeners.get("message")?.[0];
    handler?.({ data: "sealed" });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("[]");
  });
});

describe("connectRelay trust", () => {
  const KEY_A = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
  const KEY_B = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";

  function grant(publicKey: string): Response {
    return new Response(
      JSON.stringify({
        grant: { ticket: "ticket" },
        device: { id: "dev1", publicKey, capabilities: ["desktop"], revokedAt: null },
        relay: "wss://remote.reasonix.io",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  afterEach(() => localStorage.clear());

  it("refuses a changed key before any socket is opened", async () => {
    const print = await deviceFingerprint(KEY_A);
    pinDevice({ id: "dev1", publicKey: KEY_A, fingerprint: print?.full ?? "" });
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    vi.stubGlobal("fetch", vi.fn(async () => grant(KEY_B)));

    const failure = await connectRelay("dev1").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RelayError);
    expect((failure as RelayError).kind).toBe("trust_changed");
    expect(socket).not.toHaveBeenCalled();
  });

  it("asks for a decision rather than trusting an unpinned key on its own", async () => {
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    vi.stubGlobal("fetch", vi.fn(async () => grant(KEY_A)));

    const failure = await connectRelay("dev1").catch((error: unknown) => error);

    expect((failure as RelayError).kind).toBe("trust_required");
    expect(socket).not.toHaveBeenCalled();
  });

  it("opens the socket once the person approves the key", async () => {
    const attempted = new Error("socket attempted");
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw attempted;
        }
      },
    );
    vi.stubGlobal("fetch", vi.fn(async () => grant(KEY_A)));
    const confirm = vi.fn(async () => true);

    await expect(connectRelay("dev1", { confirm })).rejects.toBe(attempted);

    expect(confirm).toHaveBeenCalledWith({ id: "dev1", fingerprint: expect.any(String) });
    expect(localStorage.getItem("reasonix.devices.v1")).toContain("dev1");
  });
});

describe("isKernelPath", () => {
  it("routes the project tree and the runtime routes through the relay", () => {
    for (const path of ["/tree", "/tree/", "/runtimes", "/rt/r1/history", "/rt/r1/events"]) {
      expect(isKernelPath(path)).toBe(true);
    }
  });

  it("leaves the app's own bundle and the loopback control plane alone", () => {
    for (const path of ["/", "/assets/index.js", "/__reasonix/config", "/treeline"]) {
      expect(isKernelPath(path)).toBe(false);
    }
  });
});

describe("RelayEventSource", () => {
  it("polls the replay feed and hands frames to onmessage", async () => {
    const link = {
      fetch: vi.fn(async () =>
        new Response(
          JSON.stringify({
            frames: [{ kind: "text", text: "hi", seq: 1 }],
            watermark: 1,
            complete: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    } as unknown as RelayLink;
    const source = new RelayEventSource("http://127.0.0.1:8788/rt/r1/events", link);
    const opened = vi.fn();
    const seen: string[] = [];
    source.onopen = opened;
    source.onmessage = (event) => seen.push(event.data);

    await new Promise((resolve) => setTimeout(resolve, 20));
    source.close();

    expect(opened).toHaveBeenCalled();
    expect(seen).toEqual(['{"kind":"text","text":"hi","seq":1}']);
    expect(link.fetch).toHaveBeenCalled();
  });

  it("surfaces an error when an already-open feed dies", async () => {
    let calls = 0;
    const link = {
      fetch: vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw new Error("relay ended");
        return new Response(
          JSON.stringify({ frames: [{ kind: "text", text: "hi", seq: 1 }], watermark: 1, complete: true }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    } as unknown as RelayLink;
    const source = new RelayEventSource("http://127.0.0.1:8788/rt/r1/events", link);
    const error = vi.fn();
    source.onerror = error;

    await new Promise((resolve) => setTimeout(resolve, 260));
    source.close();

    expect(error).toHaveBeenCalledTimes(1);
  });
});
