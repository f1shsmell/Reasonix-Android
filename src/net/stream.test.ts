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

  it("stops retrying once the caller closes it", () => {
    const { handlers, states } = makeHandlers();
    const stream = new RuntimeStream("/rt/r1/events", handlers);
    stream.start();
    stream.stop();

    FakeSource.latest?.fail();
    vi.advanceTimersByTime(20000);

    expect(states.at(-1)?.kind).toBe("closed");
  });
});
