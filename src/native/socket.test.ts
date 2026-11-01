import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeWebSocket } from "./socket";

// The plugin is a singleton at module scope and Capacitor delivers an event
// to every listener ever registered, so the mock mirrors that broadcast and
// the tests exercise the page's own filtering.
const mocks = vi.hoisted(() => {
  const calls = {
    connect: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  };
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  return { calls, listeners };
});

vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({
    addListener: async (event: string, handler: (data: Record<string, unknown>) => void) => {
      const set = mocks.listeners.get(event) ?? new Set<(data: Record<string, unknown>) => void>();
      set.add(handler);
      mocks.listeners.set(event, set);
      return { remove: async () => set.delete(handler) };
    },
    connect: mocks.calls.connect,
    send: mocks.calls.send,
    close: mocks.calls.close,
  }),
}));

/** Deliver one plugin event to every listener, the way the bridge does. */
function fire(event: string, data: Record<string, unknown> = {}): void {
  for (const handler of [...(mocks.listeners.get(event) ?? [])]) handler(data);
}

/** The tag the plugin was handed for the n-th dialled socket. */
function tagOf(order: number): number {
  const options = mocks.calls.connect.mock.calls[order]?.[0] as { tag?: number } | undefined;
  return options?.tag ?? 0;
}

interface CloseEvent {
  code: number;
  reason: string;
}

/** A socket whose listeners the page has already attached. */
function opened(): { socket: NativeWebSocket; closes: CloseEvent[] } {
  const socket = new NativeWebSocket("wss://relay.test/v1/sessions/connect", ["reasonix.remote.v1"]);
  const closes: CloseEvent[] = [];
  socket.addEventListener("close", (event) =>
    closes.push({ code: Number(event.code ?? 0), reason: String(event.reason ?? "") }),
  );
  return { socket, closes };
}

/** The native side registers its listeners before it dials; wait for that. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mocks.listeners.clear();
  mocks.calls.connect.mockReset().mockResolvedValue(undefined);
  mocks.calls.send.mockReset().mockResolvedValue(undefined);
  mocks.calls.close.mockReset().mockResolvedValue(undefined);
});

describe("NativeWebSocket close bridging", () => {
  it("bridges an error into a close the page can act on", async () => {
    const { closes } = opened();
    await settled();

    fire("error", { message: "Software caused connection abort" });

    // A close is the only event RelayLink reconnects on; without the bridge
    // this failure would strand every pending request.
    expect(closes).toEqual([{ code: 1006, reason: "abnormal" }]);

    fire("error", { message: "again" });
    expect(closes).toHaveLength(1);
  });

  it("does not duplicate a close the plugin already delivered", async () => {
    const { closes } = opened();
    await settled();

    // A real close arrives after onOpen; nothing else produces onClosed.
    fire("open");
    fire("close", { code: 1011, reason: "server error" });
    fire("error", { message: "late" });

    expect(closes).toEqual([{ code: 1011, reason: "server error" }]);
  });

  it("bridges a refused dial into a close", async () => {
    mocks.calls.connect.mockRejectedValue(new Error("origin rejected"));
    const { closes } = opened();

    await settled();

    expect(closes).toEqual([{ code: 1006, reason: "abnormal" }]);
  });

  it("bridges a failed send into a close", async () => {
    const { socket, closes } = opened();
    await settled();

    mocks.calls.send.mockRejectedValue(new Error("socket is not open"));
    socket.send("hello");
    await settled();

    expect(closes).toEqual([{ code: 1006, reason: "abnormal" }]);
  });

  it("stays quiet after the page closed the socket itself", async () => {
    const { socket, closes } = opened();
    await settled();

    socket.close();
    mocks.calls.send.mockRejectedValue(new Error("socket is not open"));
    socket.send("hello");
    await settled();

    expect(closes).toEqual([]);
  });
});

describe("NativeWebSocket event addressing", () => {
  it("ignores a close that arrives before its own connection opened", async () => {
    // A replaced socket's close handshake can outlive it and arrive while
    // the new socket is still dialling. OkHttp reports its own handshake
    // failures as errors, so a close in that window is never ours; taking
    // it would pin `finished` and disarm the failure bridge.
    const { socket, closes } = opened();
    await settled();

    fire("close", { code: 1000, reason: "replaced" });
    expect(closes).toEqual([]);

    fire("open");
    fire("close", { code: 1000, reason: "server closed" });
    expect(closes).toEqual([{ code: 1000, reason: "server closed" }]);
    expect(socket.readyState).toBe(3);
  });

  it("drops events tagged for another connection", async () => {
    // The reconnect path is exactly two live sockets: the dead one still
    // delivering its failure while the replacement dials. Each must only
    // hear its own events.
    const first = opened();
    await settled();
    const second = opened();
    await settled();
    const firstTag = tagOf(0);
    const secondTag = tagOf(1);
    expect(firstTag).not.toBe(secondTag);

    fire("close", { tag: firstTag, code: 1006, reason: "old socket died" });
    expect(first.closes).toEqual([]);
    expect(second.closes).toEqual([]);

    fire("open", { tag: firstTag });
    fire("close", { tag: firstTag, code: 1006, reason: "old socket died" });
    expect(first.closes).toEqual([{ code: 1006, reason: "old socket died" }]);
    expect(second.closes).toEqual([]);
  });
});
