import { describe, expect, it } from "vitest";
import { MuxClient } from "./relayMux";
import type { MuxFrameHandlers } from "./relayMux";

function harness() {
  const sent: Array<Record<string, unknown>> = [];
  const client = new MuxClient({
    send: async (command) => {
      sent.push(command);
    },
  });
  return { client, sent };
}

function handlers() {
  const frames: Array<Record<string, unknown>> = [];
  const closed: string[] = [];
  const hooks: MuxFrameHandlers = {
    onFrame: (frame) => frames.push(frame),
    onClosed: (reason) => closed.push(reason),
  };
  return { frames, closed, hooks };
}

async function openStream(
  client: MuxClient,
  sent: Array<Record<string, unknown>>,
  hooks: MuxFrameHandlers,
  after: number | null = null,
) {
  const opening = client.open("r1", () => after, hooks);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const command = sent.find((item) => item.type === "mux.open");
  expect(command).toBeDefined();
  client.receive({ type: "mux.opened", id: command?.id, stream: command?.id });
  const handle = await opening;
  return { handle, id: String(command?.id) };
}

describe("MuxClient", () => {
  it("opens with a cursor and a byte budget, and delivers whole frames", async () => {
    const { client, sent } = harness();
    const { frames, hooks } = handlers();
    const { id } = await openStream(client, sent, hooks, 42);

    const open = sent.find((item) => item.type === "mux.open");
    expect(open).toMatchObject({ runtime: "r1", after: 42, attach: false });
    expect(open?.credit).toBeGreaterThan(0);

    client.receive({
      type: "mux.frame",
      stream: id,
      seq: 43,
      index: 0,
      done: true,
      data: '{"kind":"text","text":"hi","seq":43}',
    });
    expect(frames).toEqual([{ kind: "text", text: "hi", seq: 43 }]);
  });

  it("attaches when it holds no cursor", async () => {
    const { client, sent } = harness();
    const { hooks } = handlers();
    await openStream(client, sent, hooks, null);
    const open = sent.find((item) => item.type === "mux.open");
    expect(open).toMatchObject({ runtime: "r1", attach: true });
    expect(open?.after).toBeUndefined();
  });

  it("reassembles a chunked frame before delivering it", async () => {
    const { client, sent } = harness();
    const { frames, hooks } = handlers();
    const { id } = await openStream(client, sent, hooks);

    client.receive({ type: "mux.frame", stream: id, seq: 7, index: 0, done: false, data: '{"kind":"text",' });
    expect(frames).toHaveLength(0);
    client.receive({ type: "mux.frame", stream: id, seq: 7, index: 1, done: true, data: '"text":"hi","seq":7}' });
    expect(frames).toEqual([{ kind: "text", text: "hi", seq: 7 }]);
  });

  it("replenishes the budget once half of it is spent", async () => {
    const { client, sent } = harness();
    const { hooks } = handlers();
    const { id } = await openStream(client, sent, hooks);

    const data = "x".repeat(270_000);
    client.receive({ type: "mux.frame", stream: id, seq: 1, index: 0, done: true, data });
    const credit = sent.find((item) => item.type === "mux.credit");
    expect(credit).toMatchObject({ id });
    expect(credit?.credit).toBeGreaterThan(0);
  });

  it("counts budget in bytes, not UTF-16 units", async () => {
    const { client, sent } = harness();
    const { hooks } = handlers();
    const { id } = await openStream(client, sent, hooks);

    // 90_000 three-byte characters are 270_000 bytes but only 90_000 units;
    // counting units would never replenish and the stream would starve.
    const data = "汉".repeat(90_000);
    client.receive({ type: "mux.frame", stream: id, seq: 1, index: 0, done: true, data });
    expect(sent.some((item) => item.type === "mux.credit")).toBe(true);
  });

  it("closes on request and stops delivering afterwards", async () => {
    const { client, sent } = harness();
    const { frames, hooks } = handlers();
    const { handle, id } = await openStream(client, sent, hooks);

    handle.close();
    const close = sent.find((item) => item.type === "mux.close");
    expect(close).toMatchObject({ id });
    client.receive({ type: "mux.frame", stream: id, seq: 1, index: 0, done: true, data: '{"kind":"text"}' });
    expect(frames).toHaveLength(0);
  });

  it("reports an unsolicited close and holds nothing for it", async () => {
    const { client, sent } = harness();
    const { frames, closed, hooks } = handlers();
    const { id } = await openStream(client, sent, hooks);

    client.receive({ type: "mux.closed", stream: id, reason: "credit_timeout" });
    expect(closed).toEqual(["credit_timeout"]);
    client.receive({ type: "mux.frame", stream: id, seq: 1, index: 0, done: true, data: '{"kind":"text"}' });
    expect(frames).toHaveLength(0);
  });

  it("rejects an open the kernel refuses", async () => {
    const { client, sent } = harness();
    const { hooks } = handlers();
    const opening = client.open("r1", () => null, hooks);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const command = sent.find((item) => item.type === "mux.open");
    client.receive({ type: "error", id: command?.id, error: "event push is unavailable" });
    await expect(opening).rejects.toThrow("event push is unavailable");
  });

  it("leaves a desktop error for the request path", () => {
    const { client } = harness();
    expect(client.receive({ type: "error", id: "some-request", error: "no" })).toBe(false);
    expect(client.receive({ type: "desktop.response", id: "some-request" })).toBe(false);
  });

  it("drops a half-received frame on a lost connection and reopens from the cursor", async () => {
    const { client, sent } = harness();
    const { frames, hooks } = handlers();
    let cursor: number | null = 5;
    const watching: MuxFrameHandlers = {
      onFrame: hooks.onFrame,
      onClosed: hooks.onClosed,
    };
    const opening = client.open("r1", () => cursor, watching);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = sent.find((item) => item.type === "mux.open");
    client.receive({ type: "mux.opened", id: first?.id, stream: first?.id });
    await opening;
    // The cursor the source advances as frames land.
    cursor = 9;
    client.receive({ type: "mux.frame", stream: first?.id, seq: 10, index: 0, done: false, data: '{"kind":' });

    client.lost();
    client.reconnected();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const again = sent.filter((item) => item.type === "mux.open").at(-1);
    expect(again).toMatchObject({ runtime: "r1", after: 9, attach: false });
    client.receive({ type: "mux.opened", id: again?.id, stream: again?.id });
    // The stale half-frame must not merge into the next one.
    client.receive({
      type: "mux.frame",
      stream: again?.id,
      seq: 10,
      index: 0,
      done: true,
      data: '{"kind":"text","seq":10}',
    });
    expect(frames).toEqual([{ kind: "text", seq: 10 }]);
  });

  it("fails an open that was in flight when the connection dropped", async () => {
    const { client, sent } = harness();
    const { hooks } = handlers();
    const opening = client.open("r1", () => null, hooks);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.some((item) => item.type === "mux.open")).toBe(true);
    client.lost();
    await expect(opening).rejects.toThrow();
  });

  it("tells every open stream when the link ends", async () => {
    const { client, sent } = harness();
    const { closed, hooks } = handlers();
    await openStream(client, sent, hooks);
    client.ended("relay routing cleared");
    expect(closed).toEqual(["relay routing cleared"]);
  });

  it("rejects an open still in flight when the link ends", async () => {
    const { client } = harness();
    const { hooks } = handlers();
    const opening = client.open("r1", () => null, hooks).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.ended("relay routing cleared");
    const failure = await opening;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("relay routing cleared");
  });
});