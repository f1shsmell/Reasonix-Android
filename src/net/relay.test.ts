import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceFingerprint, pinDevice } from "./deviceTrust";
import { RelayError, RelayEventSource, RelayLink, clearRelayRouting, connectRelay, isKernelPath } from "./relay";
import type { MuxFrameHandlers } from "./relayMux";

type Handler = (event: {
  data?: string;
  code?: number;
  reason?: string;
  message?: string;
}) => void;

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

  it("keeps a pending GET recoverable across an abnormal close", async () => {
    // What the reconnect will find: the grant refused with 401, which ends
    // the link for a reason a person can act on. It also keeps this test off
    // the network while the reconnect walks its delays.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const { socket, channel, listeners } = connection();
    const link = new RelayLink("device", {
      socket: socket as unknown as WebSocket,
      channel,
      features: [],
      instance: "",
    });

    const responsePromise = link.fetch(new Request("http://127.0.0.1:8788/runtimes"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.send).toHaveBeenCalledTimes(1);

    // What the transport now reports for a dead route: an error, then the
    // close the page bridges from it. Code 1006 is not fatal, so the loss
    // must not end the link or fail the read it still hopes to resend.
    const errorListener = listeners.get("error")?.[0];
    errorListener?.({ message: "timeout" });
    const closeListener = listeners.get("close")?.[0];
    closeListener?.({ code: 1006, reason: "abnormal" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(link.isEnded).toBe(false);

    // The reconnect then takes its first retry, finds the grant refused,
    // and ends the link with that reason.
    const ended = await responsePromise.catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(RelayError);
    expect((ended as RelayError).kind).toBe("ended");
    expect(link.isEnded).toBe(true);
  });

  it("fails a pending write on the close and leaves the link reconnecting", async () => {
    // The 401 also ends the link's own reconnect deterministically, so this
    // test leaves no retry loop behind.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const { socket, channel, listeners } = connection();
    const link = new RelayLink("device", {
      socket: socket as unknown as WebSocket,
      channel,
      features: [],
      instance: "",
    });

    const failurePromise = link
      .fetch(new Request("http://127.0.0.1:8788/submit", { method: "POST", body: "{}" }))
      .then(() => null, (error: unknown) => error);
    // The link's own condition, which a caller reads instead of guessing from
    // a request that timed out.
    const states: string[] = [];
    link.watch((state) => states.push(state));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closeListener = listeners.get("close")?.[0];
    closeListener?.({ code: 1006, reason: "abnormal" });

    // A write the kernel may already have run is not silently retried; the
    // person is asked to check. The loss itself is still not an end.
    const failure = await failurePromise;
    expect(failure).toBeInstanceOf(RelayError);
    expect((failure as RelayError).kind).toBe("transient");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(link.isEnded).toBe(false);
    expect(link.currentState).toBe("reconnecting");
    expect(states).toContain("reconnecting");

    // The reconnect then ends the link on the refused grant; a fetch after
    // that is refused at once instead of hanging.
    const ended = await link
      .fetch(new Request("http://127.0.0.1:8788/runtimes"))
      .catch((error: unknown) => error);
    expect(ended).toBeInstanceOf(RelayError);
    expect((ended as RelayError).kind).toBe("ended");
    expect(link.isEnded).toBe(true);
    expect(link.currentState).toBe("ended");
    expect(states).toContain("ended");
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
        // The account service names the relay as an https origin, the same
        // string it is configured with; the client turns it into wss.
        relay: "https://relay.example.com",
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

  it("ends the connection when the grant names a relay it cannot parse", async () => {
    // A malformed relay address must arrive as a decided answer, not a raw
    // TypeError: the reconnect loop treats non-RelayError as transient and
    // would burn its whole retry ladder on a string no retry can parse.
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            grant: { ticket: "ticket" },
            device: { id: "dev1", publicKey: KEY_A, capabilities: ["desktop"], revokedAt: null },
            relay: "not a relay address",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const failure = await connectRelay("dev1").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RelayError);
    expect((failure as RelayError).kind).toBe("ended");
    expect(socket).not.toHaveBeenCalled();
  });

  it("abandons a connect that was cleared while its grant was in flight", async () => {
    // A restore may be abandoned while its grant request is still running.
    // The late attempt must not ask the person to trust a key for a link
    // nobody wants, and must not install itself afterwards.
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const socket = vi.fn();
    vi.stubGlobal("WebSocket", socket);

    const pending = connectRelay("dev1").catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    clearRelayRouting();
    release(grant(KEY_A));

    const failure = await pending;
    expect(failure).toBeInstanceOf(RelayError);
    expect((failure as RelayError).kind).toBe("transient");
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

  it("routes the workbench's git and commit calls through the relay", () => {
    for (const path of [
      "/rt/r1/changes",
      "/rt/r1/changes/stage",
      "/rt/r1/workspace/git/log",
      "/rt/r1/git/repos",
      "/rt/r1/git/commit/diff",
      "/rt/r1/commit/propose",
      "/rt/r1/commit",
      "/rt/r1/workspace/files",
    ]) {
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
      supportsMux: () => false,
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
      supportsMux: () => false,
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

function muxLink() {
  let hooks: MuxFrameHandlers | null = null;
  let cursor: (() => number | null) | null = null;
  let runtime = "";
  const close = vi.fn();
  const link = {
    supportsMux: () => true,
    openEventStream: vi.fn(async (rt: string, cur: () => number | null, h: MuxFrameHandlers) => {
      runtime = rt;
      cursor = cur;
      hooks = h;
      return { close };
    }),
    fetch: vi.fn(),
  } as unknown as RelayLink;
  return { link, close, hooks: () => hooks, cursor: () => cursor, runtime: () => runtime };
}

describe("RelayEventSource over mux", () => {
  it("subscribes with the runtime and cursor the URL names", async () => {
    const rig = muxLink();
    const source = new RelayEventSource("http://127.0.0.1:8788/rt/r1/events?lastEventId=3", rig.link);
    const opened = vi.fn();
    source.onopen = opened;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rig.runtime()).toBe("r1");
    expect(rig.cursor()?.()).toBe(3);
    expect(opened).toHaveBeenCalledTimes(1);
    source.close();
    expect(rig.close).toHaveBeenCalledTimes(1);
  });

  it("reads the unprefixed events path as the default runtime with no cursor", async () => {
    const rig = muxLink();
    const source = new RelayEventSource("http://127.0.0.1:8788/events", rig.link);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rig.runtime()).toBe("");
    expect(rig.cursor()?.()).toBeNull();
    source.close();
  });

  it("hands pushed frames over with their numbered cursor", async () => {
    const rig = muxLink();
    const source = new RelayEventSource("http://127.0.0.1:8788/rt/r1/events", rig.link);
    const seen: Array<{ data: string; id: string }> = [];
    source.onmessage = (event) => seen.push({ data: event.data, id: event.lastEventId });
    await new Promise((resolve) => setTimeout(resolve, 0));

    rig.hooks()?.onFrame({ kind: "stream_watermark", seq: 9 });
    rig.hooks()?.onFrame({ kind: "text", text: "hi", seq: 10 });
    rig.hooks()?.onFrame({ kind: "text", text: "delta" });
    expect(seen).toEqual([
      { data: '{"kind":"stream_watermark","seq":9}', id: "9" },
      { data: '{"kind":"text","text":"hi","seq":10}', id: "10" },
      { data: '{"kind":"text","text":"delta"}', id: "" },
    ]);
    source.close();
  });

  it("surfaces an unsolicited close as an error and delivers nothing after", async () => {
    const rig = muxLink();
    const source = new RelayEventSource("http://127.0.0.1:8788/rt/r1/events", rig.link);
    const error = vi.fn();
    const message = vi.fn();
    source.onerror = error;
    source.onmessage = message;
    await new Promise((resolve) => setTimeout(resolve, 0));

    rig.hooks()?.onClosed("credit_timeout");
    rig.hooks()?.onFrame({ kind: "text", seq: 1 });
    expect(error).toHaveBeenCalledTimes(1);
    expect(message).not.toHaveBeenCalled();
  });

  it("falls back to polling when the kernel refuses the stream", async () => {
    const rig = muxLink();
    (rig.link.openEventStream as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("event push is unavailable"),
    );
    (rig.link.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      new Response(
        JSON.stringify({ frames: [{ kind: "text", text: "hi", seq: 1 }], watermark: 1, complete: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const source = new RelayEventSource("http://127.0.0.1:8788/rt/r1/events", rig.link);
    const opened = vi.fn();
    const seen: string[] = [];
    source.onopen = opened;
    source.onmessage = (event) => seen.push(event.data);
    await new Promise((resolve) => setTimeout(resolve, 20));
    source.close();

    expect(opened).toHaveBeenCalled();
    expect(seen).toEqual(['{"kind":"text","text":"hi","seq":1}']);
  });
});

describe("RelayLink mux dispatch", () => {
  it("advertises push only when the ready handshake named it", () => {
    const plain = connection();
    const without = new RelayLink("device", {
      socket: plain.socket as unknown as WebSocket,
      channel: plain.channel,
      features: [],
      instance: "",
    });
    expect(without.supportsMux()).toBe(false);
    const capable = connection();
    const withMux = new RelayLink("device", {
      socket: capable.socket as unknown as WebSocket,
      channel: capable.channel,
      features: [],
      instance: "",
      capabilities: { mux: 1 },
    });
    expect(withMux.supportsMux()).toBe(true);
  });

  it("opens a stream and delivers pushed frames beside desktop responses", async () => {
    const { socket, channel, listeners } = connection();
    const commands: Array<Record<string, unknown>> = [];
    channel.seal.mockImplementation(async (value: unknown) => {
      commands.push(value as Record<string, unknown>);
      return "sealed";
    });
    const link = new RelayLink("device", {
      socket: socket as unknown as WebSocket,
      channel,
      features: [],
      instance: "",
      capabilities: { mux: 1 },
    });
    const frames: Array<Record<string, unknown>> = [];
    const opening = link.openEventStream("r1", () => null, {
      onFrame: (frame) => frames.push(frame),
      onClosed: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const open = commands.find((item) => item.type === "mux.open");
    expect(open).toMatchObject({ runtime: "r1", attach: true });

    channel.open.mockResolvedValue({ type: "mux.opened", id: open?.id, stream: open?.id });
    listeners.get("message")?.[0]?.({ data: "sealed" });
    await opening;

    channel.open.mockResolvedValue({
      type: "mux.frame",
      stream: open?.id,
      seq: 1,
      index: 0,
      done: true,
      data: '{"kind":"text","seq":1}',
    });
    listeners.get("message")?.[0]?.({ data: "sealed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frames).toEqual([{ kind: "text", seq: 1 }]);
    link.close();
  });
});
