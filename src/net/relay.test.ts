import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayEventSource, RelayLink } from "./relay";

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
