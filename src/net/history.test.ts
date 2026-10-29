import { afterEach, describe, expect, it, vi } from "vitest";
import { foldHistory, loadHistory } from "./history";
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

  it("reads the runtime's history and folds it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([{ role: "user", content: "hi", msgIndex: 1 }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const result = await loadHistory("/rt/r1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(1);
  });

  it("reports a refusal as a code without failing the screen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
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

  it("refuses a body that is not a message list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const result = await loadHistory("/rt/r1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("history.shape");
  });
});