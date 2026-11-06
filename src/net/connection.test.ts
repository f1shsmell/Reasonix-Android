import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection } from "./connection";

interface FakeSource {
  onopen: (() => void) | null;
  onmessage: ((message: { data: string; lastEventId: string }) => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

/**
 * A connection attached to one runtime, with a source the test can drive.
 *
 * Every frame has to come through the stream: `onEvent` is the only door into
 * the queue, which is what makes these tests exercise the same path a phone
 * does rather than a shortcut the real code never takes.
 */
async function attached(): Promise<{ connection: Connection; source: FakeSource }> {
  let latest: FakeSource | null = null;
  class Source {
    onopen: (() => void) | null = null;
    onmessage: ((message: { data: string; lastEventId: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      latest = this as unknown as FakeSource;
    }
    close() {}
  }
  vi.stubGlobal("EventSource", Source);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );

  const connection = new Connection();
  await connection.refresh();
  connection.attach("r1");
  const source = latest;
  if (!source) throw new Error("attach did not open a source");
  return { connection, source };
}

/** Reachability and stream health are separate facts and must not merge. */
describe("Connection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports unauthorized rather than unreachable on a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("unauthorized");
  });

  it("reports unreachable when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const connection = new Connection();
    await connection.refresh();
    const reach = connection.current.reach;
    expect(reach.kind).toBe("unreachable");
    if (reach.kind === "unreachable") expect(reach.detail).toContain("refused");
  });

  it("does not call a live link dead after one lost request", async () => {
    // A Wi-Fi that drops one packet must not flip the chip to "reconnecting":
    // this is the path that ran on every foreground and every settings visit.
    const ok = () =>
      new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");

    await connection.refresh();
    // One failure: the last good answer stays, and so does the runtime list.
    expect(connection.current.reach.kind).toBe("ok");
    expect(connection.current.runtimes.map((runtime) => runtime.id)).toEqual(["r1"]);

    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");
  });

  it("reports unreachable once two requests in a row are lost", async () => {
    const ok = () =>
      new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const connection = new Connection();
    await connection.refresh();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");

    await connection.refresh();
    expect(connection.current.reach.kind).toBe("unreachable");
  });

  it("forgets earlier failures after a success", async () => {
    // The count is "in a row", not "ever": a link that recovers and then loses
    // one request is back to being tolerated, not one step from dead.
    const ok = () =>
      new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const connection = new Connection();
    await connection.refresh();
    await connection.refresh();
    await connection.refresh();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");
  });

  it("still reports a refusal at once, because that is an answer", async () => {
    // 401 is the kernel talking, not the network dropping; waiting for a
    // second read would delay the "配对失效" message the person needs.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 })),
    );
    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("unauthorized");
  });

  it("answers whether this read reached the kernel, not what the chip shows", async () => {
    // The return value and the snapshot diverge on purpose: a caller that is
    // verifying a door must not read a kept "ok" as evidence.
    const ok = () =>
      new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    const connection = new Connection();
    await expect(connection.refresh()).resolves.toBe(true);

    // The snapshot still says ok, but the read itself did not answer.
    await expect(connection.refresh()).resolves.toBe(false);
    expect(connection.current.reach.kind).toBe("ok");
  });

  it("counts a refusal as a reset, not as a lost route", async () => {
    // Two refusals in a row must never add up to `lost`: the kernel is
    // answering, so the watch timer must not start reconnecting.
    const refused = () => new Response(null, { status: 503 });
    vi.stubGlobal("fetch", vi.fn(refused));
    const connection = new Connection();
    await connection.refresh();
    await connection.refresh();
    expect(connection.lost).toBe(false);
  });

  it("reports lost once the tolerated failures run out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const connection = new Connection();
    await connection.refresh();
    expect(connection.lost).toBe(false);
    await connection.refresh();
    expect(connection.lost).toBe(true);
  });

  it("forgets the count when the route is replaced", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const connection = new Connection();
    await connection.refresh();
    expect(connection.lost).toBe(false);

    // A deliberate switch starts from zero: the earlier hiccup was measured
    // on a route this phone no longer uses.
    connection.resetFailures();
    expect(connection.lost).toBe(false);
    await connection.refresh();
    expect(connection.lost).toBe(false);
  });

  it("keeps the runtime list it was given", async () => {
    const runtimes = [{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(runtimes), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const connection = new Connection();
    await connection.refresh();
    expect(connection.current.reach.kind).toBe("ok");
    expect(connection.current.runtimes).toEqual(runtimes);
  });

  it("refuses to attach to a runtime it does not know", () => {
    const connection = new Connection();
    connection.attach("nope");
    const stream = connection.current.stream;
    expect(stream.kind).toBe("closed");
  });

  it("notifies subscribers on every change", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const connection = new Connection();
    const seen: string[] = [];
    connection.subscribe((snapshot) => seen.push(snapshot.reach.kind));
    await connection.refresh();
    expect(seen).toEqual(["unknown", "ok"]);
  });

  it("does not let a slow refresh overwrite a newer one", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    );
    const connection = new Connection();
    const older = connection.refresh();
    const newer = connection.refresh();

    const body = (id: string) =>
      new Response(JSON.stringify([{ id, base: `/rt/${id}`, root: `/${id}`, name: id }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    resolvers[1]?.(body("newer"));
    await newer;
    resolvers[0]?.(body("older"));
    await older;

    expect(connection.current.runtimes.map((runtime) => runtime.id)).toEqual(["newer"]);
  });

  it("does not let a slow refresh overwrite a newer quickCheck", async () => {
    // The handover probe and the watch's refresh race for one snapshot, so
    // the probe takes the same ordering token: the read that started later
    // wins, whichever kind it is.
    const resolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    );
    const connection = new Connection();
    const older = connection.refresh();
    const newer = connection.quickCheck(10);

    const body = (id: string) =>
      new Response(JSON.stringify([{ id, base: `/rt/${id}`, root: `/${id}`, name: id }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    resolvers[1]?.(body("newer"));
    await expect(newer).resolves.toBe(true);
    resolvers[0]?.(body("older"));
    await expect(older).resolves.toBe(false);

    expect(connection.current.runtimes.map((runtime) => runtime.id)).toEqual(["newer"]);
  });

  it("drops the previous pane's last event when the screen detaches", async () => {
    class Source {
      static latest: Source | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((message: { data: string; lastEventId: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        Source.latest = this;
      }
      close() {}
    }
    vi.stubGlobal("EventSource", Source);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const connection = new Connection();
    await connection.refresh();
    connection.attach("r1");
    Source.latest?.onmessage?.({
      data: JSON.stringify({ kind: "text", text: "from A" }),
      lastEventId: "1",
    });
    expect(connection.current.lastEvent).toEqual({ kind: "text", text: "from A" });

    connection.detach();
    expect(connection.current.lastEvent).toBeUndefined();
  });

  it("quick-checks without counting a lost probe as a lost route", async () => {
    // A network change asks once and acts; it must not add to the watch's
    // tolerated-failure count, or the next change would look like a dead link.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const connection = new Connection();

    await expect(connection.quickCheck(10)).resolves.toBe(false);
    expect(connection.lost).toBe(false);
    expect(connection.current.reach.kind).toBe("unknown");
  });

  it("quick-checks a live route and restores the reachable answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const connection = new Connection();

    await expect(connection.quickCheck(10)).resolves.toBe(true);
    expect(connection.current.reach.kind).toBe("ok");
    expect(connection.current.runtimes.map((runtime) => runtime.id)).toEqual(["r1"]);
  });

  it("quick-checks a refusal as unauthorized, not as a dead route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const connection = new Connection();

    await expect(connection.quickCheck(10)).resolves.toBe(false);
    expect(connection.current.reach.kind).toBe("unauthorized");
    expect(connection.lost).toBe(false);
  });

  it("rebuilds an open stream instead of leaving it alone", async () => {
    // The bug this covers: a phone frozen in the background comes back to a
    // connection whose peer already closed it. No error fired, so the state
    // still reads "open" — and the old wakeStream returned early exactly for
    // that case, which is why the conversation stopped updating.
    class Source {
      static latest: Source | null = null;
      url: string;
      onopen: (() => void) | null = null;
      onmessage: ((message: { data: string; lastEventId: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(url: string) {
        this.url = url;
        Source.latest = this;
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", Source);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ id: "r1", base: "/rt/r1", root: "/w", name: "w" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const connection = new Connection();
    await connection.refresh();
    connection.attach("r1");
    const first = Source.latest;
    first?.onopen?.();
    expect(connection.current.stream.kind).toBe("open");

    connection.wakeStream();

    expect(Source.latest).not.toBe(first);
    expect(first?.closed).toBe(true);
    expect(connection.current.stream.kind).toBe("open");
  });

  it("leaves a stream alone when it is neither open nor retrying", async () => {
    // Detached, the connection has no stream to rebuild: waking must not throw
    // or invent one.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    const connection = new Connection();

    expect(connection.current.stream.kind).toBe("idle");
    expect(() => connection.wakeStream()).not.toThrow();
    expect(connection.current.stream.kind).toBe("idle");
  });

  it("keeps every frame of a burst, not just the last", async () => {
    // One relay poll answers with a whole backlog and hands each frame over
    // synchronously, so a burst commits as a single render. Keeping only the
    // newest frame made every delta but the last vanish, and a droppable
    // `text` frame is never replayed.
    const { connection, source } = await attached();

    for (const [at, text] of ["A", "B", "C"].entries()) {
      source.onmessage?.({
        data: JSON.stringify({ kind: "text", text }),
        lastEventId: String(at + 1),
      });
    }

    expect(connection.current.events.map((entry) => entry.event)).toEqual([
      { kind: "text", text: "A" },
      { kind: "text", text: "B" },
      { kind: "text", text: "C" },
    ]);
    expect(connection.current.events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    // The newest frame is still readable on its own for consumers that only
    // want a notification.
    expect(connection.current.lastEvent).toEqual({ kind: "text", text: "C" });
  });

  it("numbers frames across the whole connection, not per burst", async () => {
    // A consumer decides what is new by comparing against the last number it
    // folded, so the numbering must never go backwards or restart.
    const { connection, source } = await attached();

    source.onmessage?.({ data: JSON.stringify({ kind: "text", text: "A" }), lastEventId: "1" });
    expect(connection.current.eventSeq).toBe(1);

    connection.drainEvents(1);
    source.onmessage?.({ data: JSON.stringify({ kind: "text", text: "B" }), lastEventId: "2" });

    expect(connection.current.eventSeq).toBe(2);
    expect(connection.current.events.map((entry) => entry.seq)).toEqual([2]);
  });

  it("holds the queue to its bound, dropping the oldest frames", async () => {
    // A screen that stops reading must not grow this without end. The loss is
    // the same one the kernel already makes for deltas.
    const { connection, source } = await attached();

    for (let at = 0; at < 600; at += 1) {
      source.onmessage?.({
        data: JSON.stringify({ kind: "text", text: `d${at}` }),
        lastEventId: String(at + 1),
      });
    }

    expect(connection.current.events).toHaveLength(512);
    // The newest frame is still the newest.
    expect(connection.current.eventSeq).toBe(600);
    expect(connection.current.events.at(-1)?.seq).toBe(600);
    // The oldest kept frame follows the dropped ones.
    expect(connection.current.events[0]?.seq).toBe(600 - 512 + 1);
  });

  it("clears the queue on detach but keeps the numbering", async () => {
    // A new pane must not fold the previous pane's frames, and rewinding the
    // number would make frames already folded look fresh again.
    const { connection, source } = await attached();

    source.onmessage?.({ data: JSON.stringify({ kind: "text", text: "A" }), lastEventId: "1" });
    source.onmessage?.({ data: JSON.stringify({ kind: "text", text: "B" }), lastEventId: "2" });
    expect(connection.current.events).toHaveLength(2);

    connection.detach();

    expect(connection.current.events).toEqual([]);
    expect(connection.current.lastEvent).toBeUndefined();
    expect(connection.current.eventSeq).toBe(2);
  });

  it("drains only the frames a consumer has folded", async () => {
    const { connection, source } = await attached();

    for (let at = 0; at < 4; at += 1) {
      source.onmessage?.({
        data: JSON.stringify({ kind: "text", text: `d${at}` }),
        lastEventId: String(at + 1),
      });
    }

    connection.drainEvents(2);

    expect(connection.current.events.map((entry) => entry.seq)).toEqual([3, 4]);
  });

  it("drains everything without raising the event number", async () => {
    // Draining is a read, not a frame: it must not look like new input to a
    // listener, or the fold would run again on the same frames.
    const { connection, source } = await attached();
    source.onmessage?.({ data: JSON.stringify({ kind: "text", text: "A" }), lastEventId: "1" });

    let notified = 0;
    connection.subscribe(() => {
      notified += 1;
    });

    connection.drainEvents(1);

    expect(connection.current.events).toEqual([]);
    expect(connection.current.eventSeq).toBe(1);
    expect(notified).toBe(1); // subscribe's own immediate call, nothing more
  });
});
