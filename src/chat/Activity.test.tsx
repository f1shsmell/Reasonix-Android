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
import { toolCategory } from "./toolMeta";

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
    expect(toolLabel("spawn_agents")).toBe("派发子任务");
    expect(toolLabel("read_subagent_result")).toBe("读取子任务结果");
    expect(toolLabel("something_new")).toBe("something_new");
  });

  it("names background jobs and on-demand tools instead of their wire ids", () => {
    expect(toolLabel("bash_output")).toBe("读取后台输出");
    expect(toolLabel("kill_shell")).toBe("结束后台任务");
    expect(toolLabel("wait")).toBe("等待后台任务");
    expect(toolLabel("use_capability")).toBe("按需调用工具");
    expect(toolLabel("submit_plan")).toBe("提交计划");
    expect(toolLabel("view_image")).toBe("查看图片");
    expect(toolLabel("present_files")).toBe("交付文件");
  });

  it("keeps background jobs with commands and plan work with tasks", () => {
    expect(toolCategory("bash_output")).toBe("command");
    expect(toolCategory("kill_shell")).toBe("command");
    expect(toolCategory("wait")).toBe("command");
    expect(toolCategory("submit_plan")).toBe("task");
    expect(toolCategory("view_image")).toBe("read");
    expect(toolCategory("browser_read")).toBe("fetch");
  });

  it("shows the command rather than the JSON envelope", () => {
    expect(toolSummary(toolRow({ args: '{"command":"cd c:/dev","timeout":10}' }))).toBe(
      "cd c:/dev",
    );
    expect(toolSummary(toolRow({ args: '{"path":"a.ts"}' }))).toBe("a.ts");
    expect(toolSummary(toolRow({ args: "plain text", name: "x" }))).toBe("plain text");
  });

  it("reads a spawned task list as the first task's own title", () => {
    expect(
      toolSummary(
        toolRow({
          name: "spawn_agents",
          args: '{"tasks":[{"title":"调研缓存层","task":"阅读 internal/cache 并总结"}]}',
        }),
      ),
    ).toBe("调研缓存层");
    expect(
      toolSummary(toolRow({ name: "spawn_agents", args: '{"tasks":[{"task":"只有正文"}]}' })),
    ).toBe("只有正文");
  });

  it("reads a proxied call's own arguments, not the envelope's action", () => {
    expect(
      toolSummary(
        toolRow({
          name: "use_capability",
          args: '{"action":"call","capability_id":"tool:browser","arguments":{"url":"https://example.com"}}',
        }),
      ),
    ).toBe("https://example.com");
    expect(
      toolSummary(
        toolRow({
          name: "use_capability",
          args: '{"action":"inspect","capability_id":"mcp-tool:db/read"}',
        }),
      ),
    ).toBe("mcp-tool:db/read");
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
    const row = container.querySelector(".process-row")?.textContent ?? "";
    expect(row).toContain("执行命令");
    expect(row).toContain("2 个操作");
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
