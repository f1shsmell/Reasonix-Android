import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeStream } from "./stream";
import type { StreamState } from "./stream";

/** A stand-in for EventSource that a test drives frame by frame. */
class FakeSource {
  static latest: FakeSource | null = null;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeSource.latest = this;
  }

  close() {
    this.closed = true;
  }

  emit(data: unknown, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(data), lastEventId });
  }

  fail() {
    this.onerror?.();
  }
}

function makeHandlers() {
  const events: unknown[] = [];
  const states: StreamState[] = [];
  const cursors: number[] = [];
  return {
    events,
    states,
    cursors,
    handlers: {
      onEvent: (event: unknown) => events.push(event),
      onState: (state: StreamState) => states.push(state),
      onCursor: (seq: number) => cursors.push(seq),
    },
  };
}

describe("RuntimeStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeSource);
    FakeSource.latest = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("delivers parsed frames and remembers the last numbered id", () => {
    const { events, handlers, cursors } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();

    FakeSource.latest?.emit({ kind: "text", text: "hi" }, "7");

    expect(events).toEqual([{ kind: "text", text: "hi" }]);
    expect(cursors).toEqual([7]);
    expect(stream.cursor).toBe(7);
  });

  it("ignores the id of an unnumbered frame", () => {
    const { handlers, cursors } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();

    FakeSource.latest?.emit({ kind: "text", text: "delta" });

    expect(cursors).toEqual([]);
    expect(stream.cursor).toBe(0);
  });

  it("survives a frame it cannot parse", () => {
    const { events, handlers } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();

    FakeSource.latest?.onmessage?.({ data: "not json", lastEventId: "3" });
    FakeSource.latest?.emit({ kind: "text", text: "after" }, "4");

    expect(events).toEqual([{ kind: "text", text: "after" }]);
  });

  it("reconnects with backoff and resumes from the last cursor", () => {
    const { handlers, states } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();

    FakeSource.latest?.emit({ kind: "text", text: "a" }, "12");
    FakeSource.latest?.fail();

    expect(states.some((state) => state.kind === "retrying")).toBe(true);

    vi.advanceTimersByTime(600);
    expect(FakeSource.latest?.url).toContain("lastEventId=12");
  });

  it("retries now, keeping the cursor, when the network is back", () => {
    const { handlers, states } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();

    FakeSource.latest?.emit({ kind: "text", text: "a" }, "5");
    const failed = FakeSource.latest;
    failed?.fail();
    expect(states.at(-1)?.kind).toBe("retrying");

    stream.retryNow();

    expect(FakeSource.latest).not.toBe(failed);
    expect(FakeSource.latest?.url).toContain("lastEventId=5");
  });

  it("stops retrying once the caller closes it", () => {
    const { handlers, states } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();
    stream.stop();

    FakeSource.latest?.fail();
    vi.advanceTimersByTime(20000);

    expect(states.at(-1)?.kind).toBe("closed");
  });

  it("retries instead of throwing when the transport cannot construct a source", () => {
    vi.stubGlobal(
      "EventSource",
      class {
        constructor() {
          throw new Error("relay is not connected");
        }
      },
    );
    const { states, handlers } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();

    expect(states.at(-1)?.kind).toBe("retrying");
    stream.stop();
  });

  it("reopens with the cursor it holds, without reporting a teardown", () => {
    // A frozen phone comes back to a connection whose peer is gone and whose
    // readyState still says OPEN, so nothing but a rebuild recovers it. The
    // cursor must come from this instance: storage is throttled, and falling
    // back to it would replay frames already shown.
    const { handlers, states, cursors } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();
    FakeSource.latest?.emit({ kind: "text", text: "a" }, "9");

    const before = states.length;
    const previous = FakeSource.latest;
    stream.reopen();

    expect(previous?.closed).toBe(true);
    expect(FakeSource.latest).not.toBe(previous);
    expect(FakeSource.latest?.url).toContain("lastEventId=9");
    expect(stream.cursor).toBe(9);
    // A repair is not a stop and not a fresh connect: the pane's status dot
    // must not blink to "not connected" on every foreground.
    expect(states.slice(before).some((state) => state.kind === "closed")).toBe(false);
    expect(states.slice(before).some((state) => state.kind === "connecting")).toBe(false);
    expect(cursors).toEqual([9]);
  });

  it("reports how long an open connection has been silent", () => {
    // Silence is the only evidence left when a peer closes the socket and the
    // browser never sees an error, so the caller needs to be able to measure it.
    const { handlers } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);

    // Not open yet: there is nothing to measure.
    expect(stream.idleFor(1_000_000)).toBe(0);

    stream.start();
    FakeSource.latest?.onopen?.();
    const opened = Date.now();

    // Nothing has arrived since opening, so the clock runs from the open.
    expect(stream.idleFor(opened + 1_000)).toBeGreaterThanOrEqual(900);
    expect(stream.idleFor(opened + 20_000)).toBeGreaterThanOrEqual(19_000);
  });

  it("measures silence from the last frame, not from the open", () => {
    const { handlers } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();
    FakeSource.latest?.onopen?.();
    FakeSource.latest?.emit({ kind: "text", text: "a" }, "1");

    const after = Date.now();
    // A frame just landed, so the connection is not idle yet.
    expect(stream.idleFor(after)).toBeLessThan(1_000);
    expect(stream.idleFor(after + 30_000)).toBeGreaterThanOrEqual(29_000);
  });

  it("stops measuring once the connection is replaced", () => {
    // A reopen closes the old source; until the new one opens there is no
    // connection to measure, and reporting idleness for a replaced socket would
    // have the caller rebuild a stream that was just rebuilt.
    const { handlers } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();
    FakeSource.latest?.onopen?.();

    const later = Date.now() + 60_000;
    expect(stream.idleFor(later)).toBeGreaterThan(0);

    stream.stop();
    expect(stream.idleFor(later)).toBe(0);
  });

  it("measures from the new open, not the one it replaced", () => {
    // A reconnect is not a fresh silence: the old connection's clock must not
    // carry over, or the idle check would tear down a stream that had just
    // been rebuilt.
    const { handlers } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();
    FakeSource.latest?.onopen?.();

    const longAfter = Date.now() + 120_000;
    expect(stream.idleFor(longAfter)).toBeGreaterThan(100_000);

    stream.reopen();
    // The replacement has not opened yet: nothing to measure.
    expect(stream.idleFor(longAfter)).toBe(0);

    FakeSource.latest?.onopen?.();
    expect(stream.idleFor(Date.now())).toBeLessThan(1_000);
  });

  it("ignores a late error from a connection it already replaced", () => {
    // `close()` does not cancel an error already queued on the old source. If
    // that handler ran it would null the *new* source and leak the connection,
    // which a reopen makes far more likely by replacing it immediately.
    const { handlers, states } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();

    const old = FakeSource.latest;
    stream.reopen();
    const current = FakeSource.latest;
    expect(current).not.toBe(old);

    old?.fail();

    expect(states.some((state) => state.kind === "retrying")).toBe(false);
    current?.emit({ kind: "text", text: "still here" }, "10");
    expect(stream.cursor).toBe(10);
  });

  it("ignores frames from a connection it already replaced", () => {
    const { events, handlers } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();

    const old = FakeSource.latest;
    stream.reopen();

    old?.emit({ kind: "text", text: "stale" }, "3");

    expect(events).toEqual([]);
    expect(stream.cursor).toBe(0);
  });

  it("does not reopen a stream the caller stopped", () => {
    const { handlers } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();
    stream.stop();

    const stopped = FakeSource.latest;
    stream.reopen();

    expect(FakeSource.latest).toBe(stopped);
  });
});
