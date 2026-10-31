import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_PAGE_TIMEOUT_MS,
  HISTORY_TIMEOUT_MS,
  foldHistory,
  loadHistory,
} from "./history";
import type { HistoryMessage } from "../wire/history";

function message(partial: Partial<HistoryMessage> & { role: HistoryMessage["role"] }): HistoryMessage {
  return { content: "", msgIndex: 0, ...partial };
}

describe("foldHistory", () => {
  it("keeps a turn as the person and the answer that closed it", () => {
    const rows = foldHistory([
      message({ role: "user", content: "你好", msgIndex: 1 }),
      message({ role: "assistant", content: "你好，有什么可以帮你的？", msgIndex: 2 }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant"]);
    const answer = rows[1];
    expect(answer?.kind === "assistant" && answer.streaming).toBe(false);
  });

  it("drops the system prompt", () => {
    // It is the host's instruction to the model, not something the person read.
    const rows = foldHistory([
      message({ role: "system", content: "You are Reasonix", msgIndex: 0 }),
      message({ role: "user", content: "hi", msgIndex: 1 }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("drops a user line the host wrote on the person's behalf", () => {
    const rows = foldHistory([
      message({ role: "user", content: "The following tools are unavailable", hostAuthored: true, msgIndex: 1 }),
      message({ role: "user", content: "真的问题", msgIndex: 2 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "user" && rows[0].text).toBe("真的问题");
  });

  it("joins a tool result to its call by id, not by position", () => {
    const rows = foldHistory([
      message({
        role: "assistant",
        msgIndex: 1,
        toolCalls: [{ id: "call_a", name: "read_file", arguments: '{"p":"a"}' }],
      }),
      message({ role: "tool", content: "file contents", toolCallId: "call_a", msgIndex: 2 }),
    ]);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind === "tool") {
      expect(row.name).toBe("read_file");
      expect(row.args).toBe('{"p":"a"}');
      expect(row.output).toBe("file contents");
      expect(row.running).toBe(false);
    }
  });

  it("keeps a result whose call is missing", () => {
    const rows = foldHistory([
      message({ role: "tool", content: "orphan output", toolCallId: "gone", msgIndex: 3 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "tool" && rows[0].output).toBe("orphan output");
  });

  it("folds a step's thinking into the tool card it preceded", () => {
    const rows = foldHistory([
      message({
        role: "assistant",
        msgIndex: 1,
        reasoning: "look at the file first",
        toolCalls: [{ id: "call_a", name: "read_file" }],
      }),
      message({ role: "tool", content: "contents", toolCallId: "call_a", msgIndex: 2 }),
    ]);

    // One row: the step is one record, and the thought is on its card.
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind === "tool") {
      expect(row.reasoning).toBe("look at the file first");
      expect(row.output).toBe("contents");
    }
  });

  it("does not repeat the step's thinking on every call in it", () => {
    const rows = foldHistory([
      message({
        role: "assistant",
        msgIndex: 1,
        reasoning: "run both",
        toolCalls: [
          { id: "a", name: "bash" },
          { id: "b", name: "bash" },
        ],
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind === "tool" ? rows[0].reasoning : undefined).toBe("run both");
    expect(rows[1]?.kind === "tool" ? rows[1].reasoning : undefined).toBeUndefined();
  });

  it("leaves an answer's thinking on its bubble, not on a later tool", () => {
    const rows = foldHistory([
      message({ role: "assistant", msgIndex: 1, content: "an answer", reasoning: "considered" }),
      message({
        role: "assistant",
        msgIndex: 2,
        toolCalls: [{ id: "a", name: "bash" }],
      }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["assistant", "tool"]);
    expect(rows[0]?.kind === "assistant" ? rows[0].reasoning : undefined).toBe("considered");
    expect(rows[1]?.kind === "tool" ? rows[1].reasoning : undefined).toBeUndefined();
  });

  it("marks a stored failure with both its wording and its code", () => {
    const rows = foldHistory([
      message({
        role: "assistant",
        msgIndex: 1,
        toolCalls: [{ id: "c1", name: "bash" }],
      }),
      message({
        role: "tool",
        content: "no writes outside the workspace",
        toolCallId: "c1",
        toolFailed: true,
        toolRefusalCode: "sandbox.denied",
        msgIndex: 2,
      }),
    ]);
    const row = rows[0];
    if (row?.kind === "tool") {
      expect(row.err).toBe("no writes outside the workspace");
      expect(row.refusalCode).toBe("sandbox.denied");
    }
  });

  it("carries a stored diff flag so it renders as a diff", () => {
    const rows = foldHistory([
      message({ role: "assistant", msgIndex: 1, toolCalls: [{ id: "c1", name: "shell" }] }),
      message({
        role: "tool",
        content: "@@ -1 +1 @@",
        toolCallId: "c1",
        outputDiff: true,
        msgIndex: 2,
      }),
    ]);
    expect(rows[0]?.kind === "tool" && rows[0].outputDiff).toBe(true);
  });

  it("strips control characters rather than drawing them", () => {
    const rows = foldHistory([
      message({ role: "user", content: "a\u0000b\u001bc", msgIndex: 1 }),
    ]);
    expect(rows[0]?.kind === "user" && rows[0].text).toBe("abc");
  });

  it("keeps a reasoning-only turn", () => {
    // A turn that thought and then stopped still happened.
    const rows = foldHistory([
      message({ role: "assistant", content: "", reasoning: "想了很久", thoughtMs: 4000, msgIndex: 1 }),
    ]);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row?.kind === "assistant") {
      expect(row.reasoning).toBe("想了很久");
      expect(row.thoughtMs).toBe(4000);
    }
  });

  it("uses the tool card instead of a thought bubble for a tool step", () => {
    const rows = foldHistory([
      message({
        role: "assistant",
        content: "",
        reasoning: "先读文件",
        thoughtMs: 1200,
        toolCalls: [{ id: "c1", name: "read_file" }],
        msgIndex: 1,
      }),
      message({ role: "tool", content: "ok", toolCallId: "c1", msgIndex: 2 }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["tool"]);
  });

  it("gives history rows ids that cannot collide with live ones", () => {
    // Both folds feed one renderer keyed by id; a collision drops a row.
    const rows = foldHistory([
      message({ role: "user", content: "hi", msgIndex: 1 }),
      message({ role: "assistant", msgIndex: 2, toolCalls: [{ id: "c1", name: "bash" }] }),
    ]);
    for (const row of rows) expect(row.id.startsWith("h:")).toBe(true);
  });
});

describe("loadHistory", () => {
  afterEach(() => vi.unstubAllGlobals());

  function pageResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("reads the newest page and reports the cursor state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse({
        messages: [message({ role: "user", content: "hi", msgIndex: 1 })],
        total: 1886,
        hasMoreBefore: true,
        nextCursor: "c1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadHistory("/rt/r1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.read.rows).toHaveLength(1);
      expect(result.read.paged).toBe(true);
      expect(result.read.total).toBe(1886);
      expect(result.read.hasMoreBefore).toBe(true);
      expect(result.read.nextCursor).toBe("c1");
    }
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/rt/r1/history/page?limit=200");
  });

  it("passes the cursor back when reading older messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      pageResponse({ messages: [], total: 1886, hasMoreBefore: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await loadHistory("/rt/r1", "c1");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/rt/r1/history/page?limit=200&cursor=c1");
  });

  it("refetches the newest page when the conversation moved under a cursor", async () => {
    // 409 history.snapshot_changed on a cursor read: the newest page is the
    // answer the reader wants, so one retry follows and a second 409
    // surfaces as a code instead of looping.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse(null, 409))
      .mockResolvedValueOnce(
        pageResponse({ messages: [message({ role: "user", content: "fresh", msgIndex: 1 })], total: 1, hasMoreBefore: false }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadHistory("/rt/r1", "stale");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.read.rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a snapshot change that happens twice rather than looping", async () => {
    const fetchMock = vi.fn().mockResolvedValue(pageResponse(null, 409));
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadHistory("/rt/r1", "stale");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("history.snapshot_changed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the whole read on a kernel without the page route", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse(null, 404))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([message({ role: "user", content: "hi", msgIndex: 1 })]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await loadHistory("/rt/r1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.read.rows).toHaveLength(1);
      expect(result.read.paged).toBe(false);
    }
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("/rt/r1/history");
  });

  it("reports a refusal as a code without failing the screen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pageResponse(null, 404)));
    const result = await loadHistory("/rt/r1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("http.404");
  });

  it("reports a dead socket rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const result = await loadHistory("/rt/r1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("client.offline");
  });

  it("names a deadline, so a slow page is not mistaken for a dead link", async () => {
    // The screen tells the person whether retrying can help, and it can only
    // do that if a timeout is distinguishable from a socket that died.
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const pending = loadHistory("/rt/r1");
    await vi.advanceTimersByTimeAsync(HISTORY_PAGE_TIMEOUT_MS + 1000);
    const result = await pending;
    vi.useRealTimers();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("client.timeout");
  });

  it("keeps a long fallback budget under the proxy's read deadline", async () => {
    // The whole-transcript fallback still carries the full body, so its
    // budget must stay generous; the proxy gives up at 60s and going past
    // that would only move which side abandons first.
    expect(HISTORY_TIMEOUT_MS).toBeGreaterThan(15_000);
    expect(HISTORY_TIMEOUT_MS).toBeLessThan(60_000);
    // A page is small by construction; waiting minutes for one body is a
    // dead link wearing a timeout's clothes.
    expect(HISTORY_PAGE_TIMEOUT_MS).toBeLessThan(HISTORY_TIMEOUT_MS);
  });

  it("refuses a page without a message list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pageResponse({ total: 5 })));
    const result = await loadHistory("/rt/r1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("history.shape");
  });

  it("accepts an empty newest page", async () => {
    // A brand-new conversation: 200 with zero messages is a success the
    // screen answers with "还没有消息", not a failure.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(pageResponse({ messages: [], total: 0, hasMoreBefore: false })));
    const result = await loadHistory("/rt/r1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.read.rows).toHaveLength(0);
  });
});