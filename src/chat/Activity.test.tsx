import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActivityRow,
  ProcessSheet,
  ProcessSummary,
  toolLabel,
  toolSummary,
} from "./Activity";
import type { ProcessStep } from "./process";
import type { ToolRow } from "./transcript";

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

function render(node: React.ReactElement): void {
  act(() => {
    root?.unmount();
    root = createRoot(container);
    root.render(node);
  });
}

function toolRow(overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    kind: "tool",
    id: "t1",
    name: "bash",
    outputDiff: false,
    readOnly: false,
    running: false,
    ...overrides,
  };
}

function toolStep(overrides: Partial<ToolRow> = {}): ProcessStep {
  return { kind: "tool", id: overrides.id ?? "t1", row: toolRow(overrides) };
}

function reasoning(text: string): ProcessStep {
  return { kind: "reasoning", id: "r1", text };
}

describe("tool labels and summaries", () => {
  it("names the common tools the way a person reads them", () => {
    expect(toolLabel("bash")).toBe("执行命令");
    expect(toolLabel("read_file")).toBe("读取文件");
    expect(toolLabel("something_new")).toBe("something_new");
  });

  it("shows the command rather than the JSON envelope", () => {
    expect(toolSummary(toolRow({ args: '{"command":"cd c:/dev","timeout":10}' }))).toBe(
      "cd c:/dev",
    );
    expect(toolSummary(toolRow({ args: '{"path":"a.ts"}' }))).toBe("a.ts");
    expect(toolSummary(toolRow({ args: "plain text", name: "x" }))).toBe("plain text");
  });

  it("answers an empty summary for a call with no arguments", () => {
    expect(toolSummary(toolRow())).toBe("");
  });
});

describe("ActivityRow", () => {
  it("draws one line and expands the detail under it", () => {
    render(
      <ActivityRow
        step={toolStep({ args: '{"command":"cd c:/dev"}', output: "done", outputDiff: false })}
        onOpenSheet={() => {}}
      />,
    );

    const row = container.querySelector(".activity-row") as HTMLButtonElement;
    expect(row.textContent).toContain("执行命令");
    expect(row.textContent).toContain("cd c:/dev");

    act(() => row.click());
    expect(container.querySelector(".activity-detail")?.textContent).toContain("done");
  });

  it("marks a running tool without calling it a card", () => {
    render(<ActivityRow step={toolStep({ running: true })} onOpenSheet={() => {}} />);
    expect(container.querySelector(".activity-flag")?.textContent).toBe("运行中");
  });

  it("marks a failed call", () => {
    render(<ActivityRow step={toolStep({ err: "boom" })} onOpenSheet={() => {}} />);
    expect(container.querySelector(".activity-flag.bad")?.textContent).toBe("失败");
  });

  it("expands a short thought in place", () => {
    render(<ActivityRow step={reasoning("先看一下目录")} onOpenSheet={() => {}} />);
    act(() => (container.querySelector(".activity-row") as HTMLButtonElement).click());
    expect(container.querySelector(".reasoning-text")?.textContent).toBe("先看一下目录");
  });

  it("sends a long thought to the sheet instead of an endless row", () => {
    const onOpenSheet = vi.fn();
    render(<ActivityRow step={reasoning("想".repeat(1_000))} onOpenSheet={onOpenSheet} />);
    act(() => (container.querySelector(".activity-row") as HTMLButtonElement).click());
    expect(onOpenSheet).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".reasoning-text")).toBeNull();
  });
});

describe("ProcessSummary", () => {
  it("names the count and opens the timeline", () => {
    const onOpen = vi.fn();
    render(<ProcessSummary steps={[toolStep(), toolStep({ id: "t2" })]} onOpen={onOpen} />);
    expect(container.querySelector(".process-row")?.textContent).toContain("已处理 2 个操作");
    act(() => (container.querySelector(".process-row") as HTMLButtonElement).click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("ProcessSheet", () => {
  it("lists every step as a timeline and expands one at a time", () => {
    render(
      <ProcessSheet
        title="已处理 2 个操作"
        steps={[reasoning("先想"), toolStep({ name: "read_file", args: '{"path":"a"}' })]}
        onClose={() => {}}
      />,
    );

    const rows = container.querySelectorAll(".timeline-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("深度思考");
    expect(rows[1]?.textContent).toContain("读取文件");

    act(() => (rows[0] as HTMLButtonElement).click());
    expect(container.querySelector(".reasoning-text")?.textContent).toBe("先想");
  });
});
