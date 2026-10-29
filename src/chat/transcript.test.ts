import { beforeEach, describe, expect, it } from "vitest";
import { emptyTranscript, reduce, reduceAll, resetIds } from "./transcript";
import type { Transcript } from "./transcript";
import type { EventPayload } from "../wire/events";

function feed(events: EventPayload[], start: Transcript = emptyTranscript): Transcript {
  return reduceAll(start, events);
}

describe("transcript", () => {
  beforeEach(() => resetIds());

  it("folds a run of text deltas into one bubble", () => {
    const result = feed([
      { kind: "text", text: "Hello" },
      { kind: "text", text: ", " },
      { kind: "text", text: "world" },
    ]);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.kind).toBe("assistant");
    if (row?.kind === "assistant") {
      expect(row.text).toBe("Hello, world");
      expect(row.streaming).toBe(true);
    }
  });

  it("does not let one turn's text continue into the next", () => {
    const result = feed([
      { kind: "turn_started", text: "first question" },
      { kind: "text", text: "first answer" },
      { kind: "turn_done" },
      { kind: "turn_started", text: "second question" },
      { kind: "text", text: "second answer" },
    ]);

    const assistants = result.rows.filter((row) => row.kind === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants.map((row) => row.kind === "assistant" && row.text)).toEqual([
      "first answer",
      "second answer",
    ]);
  });

  it("closes a bubble a dead turn left open", () => {
    // A turn that never reported `turn_done` must not keep absorbing text.
    const result = feed([
      { kind: "turn_started", text: "q1" },
      { kind: "text", text: "partial" },
      { kind: "turn_started", text: "q2" },
      { kind: "text", text: "fresh" },
    ]);

    const first = result.rows.find((row) => row.kind === "assistant");
    expect(first?.kind === "assistant" && first.streaming).toBe(false);
  });

  it("keeps reasoning on the same row as the text it explains", () => {
    const result = feed([
      { kind: "reasoning", reasoning: "thinking..." },
      { kind: "text", text: "answer" },
    ]);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (row?.kind === "assistant") {
      expect(row.reasoning).toBe("thinking...");
      expect(row.text).toBe("answer");
    }
  });

  it("replaces the delta text with the final message", () => {
    const result = feed([
      { kind: "text", text: "incompl" },
      { kind: "message", text: "incomplete answer, corrected", thoughtMs: 1200 },
    ]);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (row?.kind === "assistant") {
      expect(row.text).toBe("incomplete answer, corrected");
      expect(row.streaming).toBe(false);
      expect(row.thoughtMs).toBe(1200);
    }
  });

  it("pairs a tool result with its dispatch by id", () => {
    const result = feed([
      { kind: "tool_dispatch", tool: { id: "c1", name: "read_file", args: '{"p":"a"}' } },
      { kind: "tool_result", tool: { id: "c1", name: "read_file", output: "contents" } },
    ]);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (row?.kind === "tool") {
      expect(row.running).toBe(false);
      expect(row.output).toBe("contents");
      expect(row.args).toBe('{"p":"a"}');
    }
  });

  it("keeps an unpaired result rather than dropping it", () => {
    // Nothing to pair against is not a reason to lose the host's own account.
    const result = feed([{ kind: "tool_result", tool: { name: "shell", output: "orphan" } }]);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    if (row?.kind === "tool") {
      expect(row.output).toBe("orphan");
      expect(row.running).toBe(false);
    }
  });

  it("marks a diff-shaped output so it can render as a diff", () => {
    const result = feed([
      { kind: "tool_result", tool: { name: "shell", output: "@@ -1 +1 @@", outputDiff: true } },
    ]);
    const row = result.rows[0];
    expect(row?.kind === "tool" && row.outputDiff).toBe(true);
  });

  it("keeps a refusal's code apart from its wording", () => {
    const result = feed([
      {
        kind: "tool_result",
        tool: { name: "shell", err: "no writes outside the workspace", refusalCode: "sandbox.denied" },
      },
    ]);
    const row = result.rows[0];
    if (row?.kind === "tool") {
      expect(row.refusalCode).toBe("sandbox.denied");
      expect(row.err).toContain("no writes");
    }
  });

  it("keeps operator notices out of the conversation", () => {
    const result = feed([
      { kind: "notice", text: "no API key set", audience: "operator", level: "info" },
      { kind: "notice", text: "context compacted", level: "info" },
    ]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.kind).toBe("notice");
  });

  it("shows a notice detail when the kernel sent one", () => {
    const result = feed([
      { kind: "notice", text: "compacted", detail: "12k tokens freed", level: "warn" },
    ]);
    const row = result.rows[0];
    if (row?.kind === "notice") {
      expect(row.detail).toBe("12k tokens freed");
      expect(row.level).toBe("warn");
    }
  });

  it("carries a pending question until something answers it", () => {
    const result = feed([
      {
        kind: "ask_request",
        ask: { id: "a1", prompt: "which file?", options: [{ label: "a" }, { label: "b" }] },
      },
    ]);
    const row = result.rows[0];
    expect(row?.kind === "ask");
    if (row?.kind === "ask") {
      expect(row.pending).toBe(true);
      expect(row.ask.options).toHaveLength(2);
    }
  });

  it("records a turn that failed rather than looking finished", () => {
    const result = feed([
      { kind: "turn_started", text: "q" },
      { kind: "turn_done", err: "provider returned 500" },
    ]);

    expect(result.running).toBe(false);
    expect(result.ended?.error).toContain("500");
  });

  it("records a cancelled turn as cancelled, not failed", () => {
    const result = feed([{ kind: "turn_started", text: "q" }, { kind: "turn_done", cancelled: true }]);
    expect(result.ended?.cancelled).toBe(true);
    expect(result.ended?.error).toBeUndefined();
  });

  it("returns the same object when an event changes nothing", () => {
    const start = feed([{ kind: "text", text: "a" }]);
    const after = reduce(start, { kind: "stream_watermark", seq: 9 });
    expect(after).toBe(start);
  });

  it("ignores a kind it has never heard of", () => {
    const start = feed([{ kind: "text", text: "a" }]);
    const after = reduce(start, { kind: "some_future_kind", text: "?" });
    expect(after).toBe(start);
  });

  it("shows a steer as the person's own message", () => {
    const result = feed([
      { kind: "turn_started", text: "first" },
      { kind: "steer", text: "actually, do it this way" },
    ]);

    const users = result.rows.filter((row) => row.kind === "user");
    expect(users.map((row) => row.kind === "user" && row.text)).toEqual([
      "first",
      "actually, do it this way",
    ]);
  });

  it("remembers the model each turn named", () => {
    const result = feed([
      { kind: "turn_started", text: "q", modelRef: "deepseek/deepseek-flash" },
    ]);
    expect(result.modelRef).toBe("deepseek/deepseek-flash");
  });
});
