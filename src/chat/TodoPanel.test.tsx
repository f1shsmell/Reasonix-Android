import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TodoPanel } from "./TodoPanel";
import type { TodosState } from "./TodoPanel";
import type { WireTodo } from "../wire/todos";

/**
 * The panel is the only surface that says what the agent is working through.
 * A count with no rows, or a row that looks done when it is not, is a claim
 * about work nobody can check from the chat.
 */

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

function render(todos: WireTodo[], state: TodosState = "loaded"): void {
  root = createRoot(container);
  act(() => root?.render(<TodoPanel todos={todos} state={state} />));
}

const list: WireTodo[] = [
  { content: "读契约", status: "completed" },
  { content: "写测试", status: "in_progress", activeForm: "正在写测试" },
  { content: "跑验证", status: "pending", level: 1 },
];

describe("TodoPanel", () => {
  it("is absent when the kernel holds no list", () => {
    render([]);
    expect(container.innerHTML).toBe("");
  });

  it("counts completed rows and names the current one while collapsed", () => {
    render(list);
    const summary = container.querySelector("summary");
    expect(summary?.textContent).toContain("1/3");
    // The present-continuous form is what the agent is doing, not the plan's
    // imperative label.
    expect(summary?.textContent).toContain("正在写测试");
    expect(summary?.textContent).not.toContain("全部完成");
  });

  it("draws every row with its own status", () => {
    render(list);
    const rows = Array.from(container.querySelectorAll("li"));
    expect(rows.map((row) => row.className)).toEqual([
      "todo completed",
      "todo in_progress",
      "todo pending",
    ]);
    expect(rows.map((row) => row.querySelector(".mark")?.textContent)).toEqual(["✓", "●", "○"]);
    expect(rows[0]?.textContent).toContain("读契约");
    expect(rows[1]?.textContent).toContain("正在写测试");
    expect(rows[2]?.getAttribute("data-level")).toBe("1");
  });

  it("does not read an unknown status as finished work", () => {
    // A newer kernel may add a status. Showing it as completed would be a
    // claim the client cannot support.
    render([{ content: "等外部输入", status: "blocked" }]);
    const row = container.querySelector("li");
    expect(row?.className).toBe("todo pending");
    expect(row?.querySelector(".mark")?.textContent).toBe("○");
    expect(container.querySelector(".todo-count")?.textContent).toBe("0/1");
  });

  it("says a failed refresh left an old list on screen", () => {
    render(list, "failed");
    expect(container.textContent).toContain("任务列表暂时没更新");
  });

  it("claims nothing when every row is done", () => {
    render([
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ]);
    expect(container.querySelector(".todo-count")?.textContent).toBe("2/2");
    expect(container.textContent).toContain("全部完成");
  });
});
