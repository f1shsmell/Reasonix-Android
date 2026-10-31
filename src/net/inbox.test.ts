import { afterEach, describe, expect, it, vi } from "vitest";
import { inboxMessage, loadInbox, loadInboxItem, receiptText, sendToInbox } from "./inbox";

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

  it("keeps the metadata the list row needs to say when and how big", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          revision: 1,
          paused: false,
          items: [
            {
              id: "a",
              intent: "followup",
              state: "blocked",
              preview: "看日志",
              blockCode: "steer_unapplied",
              blockReason: "the turn moved on",
              createdAt: "2026-10-31T01:00:00Z",
              byteSize: 2048,
              refs: [
                { kind: "clean_git", path: "src/a.ts", displayPath: "src/a.ts", bytes: 12 },
                { path: "/tmp/no-kind" },
                { kind: "external", path: "/tmp/x" },
              ],
            },
          ],
        }),
      ),
    );

    const result = await loadInbox("/rt/r1");

    expect(result.ok && result.snapshot.items[0]).toEqual({
      id: "a",
      intent: "followup",
      state: "blocked",
      preview: "看日志",
      blockCode: "steer_unapplied",
      blockReason: "the turn moved on",
      createdAt: "2026-10-31T01:00:00Z",
      byteSize: 2048,
      // A ref with no kind is dropped rather than drawn as a blank line.
      refs: [
        { kind: "clean_git", path: "src/a.ts", displayPath: "src/a.ts", bytes: 12 },
        { kind: "external", path: "/tmp/x" },
      ],
    });
  });
});

describe("loadInboxItem", () => {
  it("reads the full body the list only previewed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        meta: { id: "a", intent: "followup", state: "queued", preview: "看日志" },
        envelope: {
          displayText: "看日志 /review",
          rawText: "看日志 /review",
          submitText: "看日志",
          refs: [{ kind: "clean_git", path: "src/a.ts", displayPath: "src/a.ts" }],
          frozenImages: ["data:image/png;base64,AAA"],
          referenceErrors: ["src/gone.ts 已经不在了"],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadInboxItem("/rt/r1", "a");

    expect(fetchMock).toHaveBeenCalledWith(
      "/rt/r1/inbox/items/a",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(result).toEqual({
      ok: true,
      detail: {
        item: { id: "a", intent: "followup", state: "queued", preview: "看日志" },
        displayText: "看日志 /review",
        submitText: "看日志",
        refs: [{ kind: "clean_git", path: "src/a.ts", displayPath: "src/a.ts" }],
        images: ["data:image/png;base64,AAA"],
        referenceErrors: ["src/gone.ts 已经不在了"],
      },
    });
  });

  it("falls back to whichever spelling an older writer stored", async () => {
    // A schema-v1 item has no displayText; the sheet must still show its text.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          meta: { id: "a", intent: "followup", state: "queued", preview: "旧" },
          envelope: { submitText: "旧的内容" },
        }),
      ),
    );

    const result = await loadInboxItem("/rt/r1", "a");

    expect(result.ok && result.detail.displayText).toBe("旧的内容");
    expect(result.ok && result.detail.submitText).toBe("旧的内容");
    // The two are the same string here, so the sheet draws one body, not two.
    expect(result.ok && result.detail.images).toBeUndefined();
    expect(result.ok && result.detail.refs).toBeUndefined();
  });

  it("refuses a body it cannot identify", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ meta: { state: "queued" }, envelope: {} })),
    );
    await expect(loadInboxItem("/rt/r1", "a")).resolves.toEqual({
      ok: false,
      code: "inbox.shape",
    });
  });

  it("carries the kernel's refusal through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ code: "inbox.not_found" }, 409)),
    );
    await expect(loadInboxItem("/rt/r1", "gone")).resolves.toEqual({
      ok: false,
      code: "inbox.not_found",
    });
  });

  it("does not ask for an item it cannot name", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadInboxItem("/rt/r1", "")).resolves.toEqual({
      ok: false,
      code: "inbox.shape",
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
