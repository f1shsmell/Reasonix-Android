import { beforeEach, describe, expect, it } from "vitest";
import {
  emptyTranscript,
  markAnswered,
  optimisticUser,
  reduce,
  reduceAll,
  removeLocalUser,
  resetIds,
} from "./transcript";
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
    // The kernel's shape: an ask holds questions, and each question holds its
    // own options. The flat shape this used to assert was never sent.
    const result = feed([
      {
        kind: "ask_request",
        ask: {
          id: "a1",
          questions: [
            { id: "q1", prompt: "which file?", options: [{ label: "a" }, { label: "b" }] },
          ],
        },
      },
    ]);
    const row = result.rows[0];
    expect(row?.kind).toBe("ask");
    if (row?.kind === "ask") {
      expect(row.pending).toBe(true);
      expect(row.ask.questions[0]?.options).toHaveLength(2);
    }
  });

  it("keeps every question of a multi-question ask", () => {
    const result = feed([
      {
        kind: "ask_request",
        ask: {
          id: "a1",
          questions: [
            { id: "q1", prompt: "one?", options: [{ label: "a" }] },
            { id: "q2", prompt: "two?", options: [{ label: "b" }], multi: true },
          ],
        },
      },
    ]);
    const row = result.rows[0];
    if (row?.kind === "ask") {
      expect(row.ask.questions.map((q) => q.id)).toEqual(["q1", "q2"]);
      expect(row.ask.questions[1]?.multi).toBe(true);
    }
  });

  it("ignores an ask that carries no questions", () => {
    // A prompt with no buttons is not a prompt. Drawing it would leave the
    // person with a question they cannot answer.
    const start = feed([{ kind: "text", text: "a" }]);
    const after = reduce(start, { kind: "ask_request", ask: { id: "a1", questions: [] } });
    expect(after).toBe(start);
  });

  it("closes a question a decision receipt says was settled elsewhere", () => {
    // The normal phone case: the desktop asked, the phone is looking at it, and
    // someone answers on the desktop. Without the receipt this row waits forever.
    const result = feed([
      {
        kind: "ask_request",
        ask: { id: "a1", questions: [{ id: "q1", prompt: "p", options: [] }] },
      },
      { kind: "notice", decisionReceipt: { id: "a1", kind: "ask", outcome: "answered" } },
    ]);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.kind === "ask" && row.pending).toBe(false);
  });

  it("leaves a receipt for another prompt alone", () => {
    const result = feed([
      {
        kind: "ask_request",
        ask: { id: "a1", questions: [{ id: "q1", prompt: "p", options: [] }] },
      },
      { kind: "notice", decisionReceipt: { id: "other", kind: "ask", outcome: "answered" } },
    ]);
    const row = result.rows[0];
    expect(row?.kind === "ask" && row.pending).toBe(true);
  });

  it("does not let a question outlive the turn that asked it", () => {
    // A lost receipt would otherwise leave a prompt that can never be answered.
    const result = feed([
      { kind: "turn_started", text: "q" },
      {
        kind: "ask_request",
        ask: { id: "a1", questions: [{ id: "q1", prompt: "p", options: [] }] },
      },
      { kind: "turn_done" },
    ]);
    const row = result.rows.find((candidate) => candidate.kind === "ask");
    expect(row?.kind === "ask" && row.pending).toBe(false);
  });

  it("records what was picked so the row can say it afterwards", () => {
    const asked = feed([
      {
        kind: "ask_request",
        ask: { id: "a1", questions: [{ id: "q1", prompt: "p", options: [] }] },
      },
    ]);
    const after = markAnswered(asked, "a1", { q1: ["茶"] });
    const row = after.rows[0];
    expect(row?.kind === "ask" && row.pending).toBe(false);
    expect(row?.kind === "ask" && row.selected?.q1).toEqual(["茶"]);
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

  it("confirms an optimistic message instead of drawing it twice", () => {
    const local = optimisticUser("hello");
    const pending: Transcript = { ...emptyTranscript, rows: [local] };

    const result = reduce(pending, { kind: "turn_started", text: "hello" });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.kind === "user" && row.local).toBe(false);
  });

  it("removes an optimistic message whose submit failed", () => {
    const local = optimisticUser("hello");
    const pending: Transcript = { ...emptyTranscript, rows: [local] };

    expect(removeLocalUser(pending, local.id).rows).toHaveLength(0);
  });

  it("does not draw a tool-call-only step as an empty bubble", () => {
    const result = feed([{ kind: "message", text: "", reasoning: "" }]);

    expect(result.rows).toHaveLength(0);
  });

  it("folds a reasoning-only step into the tool card it preceded", () => {
    const result = feed([
      { kind: "reasoning", reasoning: "think" },
      { kind: "tool_dispatch", tool: { id: "c1", name: "read_file" } },
    ]);

    // One row, not two: the step is one record. The thought is still there,
    // on the card, so the reason the tool ran is not lost.
    expect(result.rows.map((row) => row.kind)).toEqual(["tool"]);
    const tool = result.rows[0];
    expect(tool?.kind === "tool" ? tool.reasoning : undefined).toBe("think");
  });

  it("joins several thought deltas before folding them into the card", () => {
    const result = feed([
      { kind: "reasoning", reasoning: "first " },
      { kind: "reasoning", reasoning: "second" },
      { kind: "tool_dispatch", tool: { id: "c1", name: "read_file" } },
    ]);

    expect(result.rows).toHaveLength(1);
    const tool = result.rows[0];
    expect(tool?.kind === "tool" ? tool.reasoning : undefined).toBe("first second");
  });

  it("leaves an answer's own thinking on its bubble", () => {
    // Text and reasoning together is an answer, not a step: it must not be
    // folded into a tool card that may follow it.
    const result = feed([
      { kind: "reasoning", reasoning: "considering" },
      { kind: "message", text: "here is the answer", reasoning: "" },
      { kind: "tool_dispatch", tool: { id: "c1", name: "read_file" } },
    ]);

    expect(result.rows.map((row) => row.kind)).toEqual(["assistant", "tool"]);
    const tool = result.rows[1];
    expect(tool?.kind === "tool" ? tool.reasoning : undefined).toBeUndefined();
  });
});
