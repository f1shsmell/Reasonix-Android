import { describe, expect, it } from "vitest";
import { buildDisplay, processCategories, processTitle } from "./process";
import type { AssistantRow, Row, ToolRow, UserRow } from "./transcript";

function user(id: string): UserRow {
  return { kind: "user", id, text: id };
}

function tool(id: string, overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    kind: "tool",
    id,
    name: "bash",
    outputDiff: false,
    readOnly: false,
    running: false,
    ...overrides,
  };
}

function assistant(id: string, text: string, reasoning = ""): AssistantRow {
  return { kind: "assistant", id, text, reasoning, streaming: false };
}

describe("buildDisplay", () => {
  it("keeps a single step as a row", () => {
    const display = buildDisplay([tool("t1")], false);
    expect(display).toHaveLength(1);
    const entry = display[0];
    expect(entry?.kind).toBe("steps");
    if (entry?.kind !== "steps") return;
    expect(entry.steps).toHaveLength(1);
    expect(entry.live).toBe(true);
  });

  it("groups a finished run and keeps the answer after it", () => {
    const display = buildDisplay(
      [tool("t1"), tool("t2"), assistant("a1", "完成了")],
      false,
    );
    expect(display.map((entry) => entry.kind)).toEqual(["steps", "assistant"]);
    const steps = display[0];
    expect(steps?.kind === "steps" && steps.live).toBe(false);
    expect(steps?.kind === "steps" && steps.steps).toHaveLength(2);
  });

  it("draws the trailing run live while the turn is running", () => {
    const display = buildDisplay([tool("t1"), tool("t2")], true);
    const entry = display[0];
    expect(entry?.kind === "steps" && entry.live).toBe(true);
  });

  it("groups an earlier run even while a later turn runs", () => {
    const rows: Row[] = [tool("t1"), tool("t2"), assistant("a1", "第一轮"), user("u1"), tool("t3")];
    const display = buildDisplay(rows, true);
    expect(display.map((entry) => entry.kind)).toEqual(["steps", "assistant", "user", "steps"]);
    expect(display[0]?.kind === "steps" && display[0].live).toBe(false);
    expect(display[3]?.kind === "steps" && display[3].live).toBe(true);
  });

  it("lifts an assistant's thinking out as its own step", () => {
    const display = buildDisplay([assistant("a1", "答案", "先想一下")], false);
    const first = display[0];
    expect(first?.kind).toBe("steps");
    if (first?.kind !== "steps") return;
    expect(first.steps[0]).toMatchObject({ kind: "reasoning", text: "先想一下" });
    expect(display[1]?.kind).toBe("assistant");
  });

  it("keeps a tool step's thinking before the call", () => {
    const display = buildDisplay([tool("t1", { reasoning: "看看目录" })], false);
    const entry = display[0];
    if (entry?.kind !== "steps") throw new Error("expected steps");
    expect(entry.steps.map((step) => step.kind)).toEqual(["reasoning", "tool"]);
  });

  it("ends a run at a prompt or a notice", () => {
    const display = buildDisplay(
      [
        tool("t1"),
        tool("t2"),
        { kind: "notice", id: "n1", level: "warn", text: "注意" },
        tool("t3"),
      ],
      false,
    );
    expect(display.map((entry) => entry.kind)).toEqual(["steps", "notice", "steps"]);
  });

  it("drops an assistant row that only carries thinking", () => {
    const display = buildDisplay([assistant("a1", "", "只在想")], false);
    expect(display.map((entry) => entry.kind)).toEqual(["steps"]);
    expect(display[0]?.kind === "steps" && display[0].steps[0]?.kind).toBe("reasoning");
  });

  it("folds a running run into a summary in compact mode", () => {
    const display = buildDisplay([tool("t1"), tool("t2")], true, "compact");
    const entry = display[0];
    if (entry?.kind !== "steps") throw new Error("expected steps");
    expect(entry.live).toBe(false);
    expect(entry.running).toBe(true);
    expect(entry.steps).toHaveLength(2);
  });

  it("leaves thinking out of a compact transcript", () => {
    const display = buildDisplay(
      [tool("t1", { reasoning: "看看目录" }), assistant("a1", "答案", "先想一下")],
      false,
      "compact",
    );
    expect(display.map((entry) => entry.kind)).toEqual(["steps", "assistant"]);
    const steps = display[0];
    if (steps?.kind !== "steps") throw new Error("expected steps");
    expect(steps.steps.map((step) => step.kind)).toEqual(["tool"]);
  });

  it("folds a one-step compact run too, unlike the standard mode", () => {
    const standard = buildDisplay([tool("t1")], false);
    expect(standard[0]?.kind === "steps" && standard[0].live).toBe(true);

    const compact = buildDisplay([tool("t1")], false, "compact");
    expect(compact[0]?.kind === "steps" && compact[0].live).toBe(false);
  });

  it("never groups in full mode, even after the turn ends", () => {
    const display = buildDisplay(
      [tool("t1"), assistant("a1", "第一轮"), user("u1"), tool("t2"), tool("t3")],
      false,
      "full",
    );
    const runs = display.filter((entry) => entry.kind === "steps");
    expect(runs).toHaveLength(2);
    expect(runs.every((entry) => entry.kind === "steps" && entry.live)).toBe(true);
  });

  it("marks only the trailing run as running", () => {
    const display = buildDisplay(
      [tool("t1"), tool("t2"), assistant("a1", "第一轮"), tool("t3")],
      true,
    );
    expect(display[0]?.kind === "steps" && display[0].running).toBe(false);
    expect(display[2]?.kind === "steps" && display[2].running).toBe(true);
  });
});

describe("process categories", () => {
  it("ranks the families a finished run was made of", () => {
    const steps = [
      { kind: "tool", id: "t1", row: tool("t1", { name: "read_file" }) },
      { kind: "tool", id: "t2", row: tool("t2", { name: "read_file" }) },
      { kind: "tool", id: "t3", row: tool("t3", { name: "grep" }) },
      { kind: "tool", id: "t4", row: tool("t4", { name: "bash" }) },
    ] as const;
    expect(processCategories([...steps]).map((entry) => entry.category)).toEqual([
      "read",
      "search",
      "command",
    ]);
    expect(processTitle([...steps])).toBe("读取、搜索、执行命令");
  });

  it("stops at three families and says there are more", () => {
    const steps = [
      { kind: "tool", id: "t1", row: tool("t1", { name: "read_file" }) },
      { kind: "tool", id: "t2", row: tool("t2", { name: "grep" }) },
      { kind: "tool", id: "t3", row: tool("t3", { name: "bash" }) },
      { kind: "tool", id: "t4", row: tool("t4", { name: "edit_file" }) },
    ] as const;
    expect(processTitle([...steps])).toBe("读取、搜索、执行命令等");
  });

  it("calls a run that only thought a thought", () => {
    expect(
      processTitle([{ kind: "reasoning", id: "r1", text: "先想一下" }]),
    ).toBe("深度思考");
  });
});
