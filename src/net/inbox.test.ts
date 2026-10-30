import { afterEach, describe, expect, it, vi } from "vitest";
import { inboxMessage, loadInbox, receiptText, sendToInbox } from "./inbox";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("sendToInbox", () => {
  it("sends a queued followup and reports its position", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({ itemId: "i1", disposition: "queued_followup", position: 2, paused: false }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendToInbox("/rt/r1", "  等一下再查日志 ", "followup");

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/inbox/items",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ input: "等一下再查日志", intent: "followup" }),
      }),
    );
    expect(result).toEqual({
      ok: true,
      receipt: { itemId: "i1", disposition: "queued_followup", position: 2, paused: false },
    });
  });

  it("sends a steer and keeps the accepted disposition", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        json({ itemId: "i2", disposition: "steer_accepted", position: 0, paused: false }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendToInbox("/rt/r1", "停，先看这个", "steer");

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/inbox/items",
      expect.objectContaining({ body: JSON.stringify({ input: "停，先看这个", intent: "steer" }) }),
    );
    expect(result.ok && result.receipt.disposition).toBe("steer_accepted");
  });

  it("does not post an empty message", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendToInbox("/rt/r1", "   ", "followup")).resolves.toEqual({
      ok: false,
      code: "client.empty_input",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the kernel's refusal code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "steer.already_applied" }, 409)));
    await expect(sendToInbox("/rt/r1", "x", "steer")).resolves.toEqual({
      ok: false,
      code: "steer.already_applied",
    });
  });

  it("reports a receipt it cannot read rather than a false success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ itemId: "i3" })));
    await expect(sendToInbox("/rt/r1", "x", "followup")).resolves.toEqual({
      ok: false,
      code: "inbox.shape",
    });
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(sendToInbox("/rt/r1", "x", "followup")).resolves.toEqual({
      ok: false,
      code: "client.offline",
    });
  });
});

describe("loadInbox", () => {
  it("reads the queue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          revision: 3,
          paused: false,
          items: [
            { id: "a", intent: "followup", state: "queued", preview: "看日志" },
            { id: "b", intent: "steer", state: "blocked", preview: "停", blockReason: "steer_unapplied" },
            { kind: "broken" },
          ],
        }),
      ),
    );

    const result = await loadInbox("/rt/r1");

    expect(result).toEqual({
      ok: true,
      snapshot: {
        revision: 3,
        paused: false,
        unrecovered: false,
        items: [
          { id: "a", intent: "followup", state: "queued", preview: "看日志" },
          {
            id: "b",
            intent: "steer",
            state: "blocked",
            preview: "停",
            blockReason: "steer_unapplied",
          },
        ],
      },
    });
  });

  it("tells an unreadable queue from an empty one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ revision: 1, paused: false, unrecovered: true, items: [] })),
    );
    const result = await loadInbox("/rt/r1");
    expect(result.ok && result.snapshot.unrecovered).toBe(true);
  });

  it("reports being offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    await expect(loadInbox("/rt/r1")).resolves.toEqual({ ok: false, code: "client.offline" });
  });
});

describe("receiptText", () => {
  it("says what actually happened, not just that it worked", () => {
    // A steer the kernel queued instead is not the same promise as one it
    // accepted into the running turn.
    expect(
      receiptText({ itemId: "i", disposition: "steer_accepted", position: 0, paused: false }),
    ).toContain("这一轮会看到");
    expect(
      receiptText({ itemId: "i", disposition: "queued_followup", position: 3, paused: false }),
    ).toContain("第 3 位");
  });

  it("explains a rejection rather than a silent no-op", () => {
    expect(
      receiptText({ itemId: "i", disposition: "rejected_capacity", position: 0, paused: false }),
    ).toContain("队列满了");
  });

  it("carries an unknown disposition through instead of claiming success", () => {
    expect(
      receiptText({ itemId: "i", disposition: "future_kind", position: 0, paused: false }),
    ).toContain("future_kind");
  });
});

describe("inboxMessage", () => {
  it("turns the stable codes into sentences", () => {
    expect(inboxMessage("client.offline")).toContain("连不上");
    expect(inboxMessage("inbox.capacity_items")).toContain("队列满了");
    expect(inboxMessage("inbox.paused")).toContain("暂停");
    expect(inboxMessage("steer.already_applied")).toContain("用过");
    expect(inboxMessage("something.new")).toContain("something.new");
  });
});
