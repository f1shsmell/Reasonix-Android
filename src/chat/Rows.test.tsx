import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard, AskCard, AssistantBubble, ToolDetail, UserBubble } from "./Rows";
import { clockText } from "../app/format";
import type { ApprovalRow, AskRow, ToolRow } from "./transcript";

/**
 * The prompt cards are the only place a phone can act on the kernel, and they
 * had no test at all — every claim about them was a claim about CSS nobody had
 * looked at. These render them for real and press the buttons.
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function render(node: React.ReactElement): void {
  root = createRoot(container);
  act(() => root?.render(node));
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

function byText(text: string): HTMLButtonElement {
  const found = buttons().find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`no button containing ${JSON.stringify(text)}`);
  return found;
}

function askRow(overrides: Partial<AskRow> = {}): AskRow {
  return {
    kind: "ask",
    id: "ask-1",
    pending: true,
    ask: {
      id: "ask-1",
      questions: [
        {
          id: "q1",
          header: "饮品偏好",
          prompt: "你更喜欢茶还是咖啡？",
          options: [{ label: "茶" }, { label: "咖啡" }],
        },
      ],
    },
    ...overrides,
  };
}

const noop = { onAnswer: () => {}, onAnswerSurface: () => {}, onApprove: () => {} };

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AskCard", () => {
  it("draws every option of the question it was given", () => {
    // The flat shape this used to read had no options at all, so the card
    // rendered a question with no way to answer it.
    render(<AskCard row={askRow()} handlers={noop} />);
    expect(buttons().map((button) => button.textContent)).toEqual([
      "茶",
      "咖啡",
      "其他 —— 自行填写",
      "确认",
    ]);
  });

  it("takes a free-text answer when the offered options do not fit", () => {
    const onAnswer = vi.fn();
    render(<AskCard row={askRow()} handlers={{ ...noop, onAnswer }} />);

    act(() => byText("其他").click());
    const input = container.querySelector('input[aria-label="其他回答"]') as HTMLInputElement;
    act(() => typeInto(input, "葡萄"));
    expect(byText("确认").disabled).toBe(false);

    act(() => byText("确认").click());
    expect(onAnswer).toHaveBeenCalledWith("ask-1", { q1: ["葡萄"] });
  });

  it("lets a single-choice pick carry an optional note", () => {
    const onAnswer = vi.fn();
    render(<AskCard row={askRow()} handlers={{ ...noop, onAnswer }} />);

    act(() => byText("茶").click());
    const note = container.querySelector('input[aria-label="补充说明"]') as HTMLInputElement;
    act(() => typeInto(note, "加冰"));
    act(() => byText("确认").click());

    expect(onAnswer).toHaveBeenCalledWith("ask-1", { q1: ["茶", "加冰"] });
  });

  it("uses the kernel's own other option instead of adding a second", () => {
    const row = askRow();
    row.ask.questions[0]!.options = [
      { label: "茶" },
      { label: "其他（请说明）", description: "写下来" },
    ];
    render(<AskCard row={row} handlers={noop} />);

    const labels = buttons().map((button) => button.textContent ?? "");
    expect(labels.filter((label) => label.includes("其他"))).toEqual(["其他（请说明）写下来"]);
  });

  it("will not send before a question has an answer", () => {
    render(<AskCard row={askRow()} handlers={noop} />);
    expect(byText("确认").disabled).toBe(true);
  });

  it("counts a prefilled answer as ready and submits it", () => {
    const onAnswer = vi.fn();
    const row = askRow();
    const question = row.ask.questions[0];
    if (!question) throw new Error("test question missing");
    question.default = ["茶"];

    render(<AskCard row={row} handlers={{ ...noop, onAnswer }} />);
    expect(byText("确认").disabled).toBe(false);
    act(() => byText("确认").click());

    expect(onAnswer).toHaveBeenCalledWith("ask-1", { q1: ["茶"] });
  });

  it("sends the picked label under its question id", () => {
    const onAnswer = vi.fn();
    render(<AskCard row={askRow()} handlers={{ ...noop, onAnswer }} />);

    act(() => byText("茶").click());
    act(() => byText("确认").click());

    expect(onAnswer).toHaveBeenCalledWith("ask-1", { q1: ["茶"] });
  });

  it("replaces the choice when the question is single-select", () => {
    const onAnswer = vi.fn();
    render(<AskCard row={askRow()} handlers={{ ...noop, onAnswer }} />);

    act(() => byText("茶").click());
    act(() => byText("咖啡").click());
    act(() => byText("确认").click());

    expect(onAnswer).toHaveBeenCalledWith("ask-1", { q1: ["咖啡"] });
  });

  it("collects several labels when the question is multi-select", () => {
    const row = askRow();
    row.ask.questions[0]!.multi = true;
    const onAnswer = vi.fn();
    render(<AskCard row={row} handlers={{ ...noop, onAnswer }} />);

    act(() => byText("茶").click());
    act(() => byText("咖啡").click());
    act(() => byText("确认").click());

    expect(onAnswer).toHaveBeenCalledWith("ask-1", { q1: ["茶", "咖啡"] });
  });

  it("answers a two-question form only once both are picked", () => {
    const onAnswer = vi.fn();
    const row = askRow();
    row.ask.questions = [
      { id: "q1", prompt: "one?", options: [{ label: "a" }] },
      { id: "q2", prompt: "two?", options: [{ label: "b" }] },
    ];
    render(<AskCard row={row} handlers={{ ...noop, onAnswer }} />);

    act(() => byText("a").click());
    act(() => byText("下一题 (1/2)").click());
    expect(byText("还有 1 题未答").disabled).toBe(true);
    expect(container.textContent).toContain("1/2 已答");

    act(() => byText("b").click());
    act(() => byText("提交 2 个回答").click());

    expect(onAnswer).toHaveBeenCalledWith("ask-1", { q1: ["a"], q2: ["b"] });
  });

  it("answers a mixed MCP form of free text and choices", () => {
    const onAnswer = vi.fn();
    const row = askRow();
    row.ask.questions = [
      {
        id: "name",
        header: "姓名",
        prompt: "怎么称呼？",
        reason: "missing_value",
        options: [],
      },
      {
        id: "env",
        header: "环境",
        prompt: "部署到哪？",
        options: [{ label: "prod" }, { label: "dev" }],
      },
    ];
    render(<AskCard row={row} handlers={{ ...noop, onAnswer }} />);

    const free = container.querySelector(".prompt.wizard .ask-extra") as HTMLInputElement;
    expect(free).toBeTruthy();
    expect(container.textContent).not.toContain("其他 —— 自行填写");
    act(() => typeInto(free, "Alice"));
    act(() => byText("下一题 (1/2)").click());
    act(() => byText("prod").click());
    act(() => byText("提交 2 个回答").click());

    expect(onAnswer).toHaveBeenCalledWith("ask-1", { name: ["Alice"], env: ["prod"] });
  });

  it("draws a free-text-only MCP field as an input, not as an other option", () => {
    const onAnswer = vi.fn();
    const row = askRow();
    row.ask.questions = [
      { id: "name", header: "姓名", prompt: "怎么称呼？", options: [] },
    ];
    render(<AskCard row={row} handlers={{ ...noop, onAnswer }} />);

    expect(container.querySelector(".choices")).toBeNull();
    expect(container.textContent).not.toContain("其他 —— 自行填写");
    const field = container.querySelector(".question .ask-extra") as HTMLInputElement;
    expect(field).toBeTruthy();
    act(() => typeInto(field, "Alice"));
    act(() => byText("确认").click());

    expect(onAnswer).toHaveBeenCalledWith("ask-1", { name: ["Alice"] });
  });

  it("refuses a mixed surface and option ask instead of dropping the choices", () => {
    const row = askRow();
    row.ask.questions = [
      {
        id: "form",
        header: "表单",
        prompt: "表单",
        options: [],
        surface: { spec_version: 1, body: [{ kind: "text", value: "body" }] },
      },
      { id: "choice", header: "选项", prompt: "选项", options: [{ label: "a" }] },
    ];
    render(<AskCard row={row} handlers={noop} />);

    expect(container.textContent).toContain("无法提交");
    expect(container.textContent).not.toContain("body");
    expect(container.querySelector(".choices")).toBeNull();
  });

  it("jumps to the first missing question when the last one is answered", () => {
    const row = askRow();
    row.ask.questions = [
      { id: "q1", header: "one", prompt: "one", options: [{ label: "a" }] },
      { id: "q2", header: "two", prompt: "two", options: [{ label: "b" }] },
    ];
    render(<AskCard row={row} handlers={noop} />);

    act(() => byText("下一题 (1/2)").click());
    act(() => byText("b").click());
    const jump = byText("去补 1 题");
    expect(jump.disabled).toBe(false);
    act(() => jump.click());
    expect(container.textContent).toContain("one");
    expect(byText("下一题 (1/2)")).toBeTruthy();
  });

  it("offers no buttons once it is settled, and says what was picked", () => {
    const row = askRow({ pending: false, selected: { q1: ["茶"] } });
    render(<AskCard row={row} handlers={noop} />);

    expect(buttons()).toHaveLength(0);
    expect(container.textContent).toContain("已回答");
    expect(container.textContent).toContain("茶");
  });
});

function approvalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    kind: "approval",
    id: "ap-1",
    pending: true,
    approval: {
      id: "ap-1",
      tool: "bash",
      subject: "rm -rf build",
      allowsSession: true,
      allowsPersist: false,
    },
    ...overrides,
  };
}

describe("ApprovalCard", () => {
  it("offers once and session, but not a persistent rule the host refused", () => {
    render(<ApprovalCard row={approvalRow()} handlers={noop} />);
    const labels = buttons().map((button) => button.textContent ?? "");
    expect(labels.some((label) => label.includes("允许一次"))).toBe(true);
    expect(labels.some((label) => label.includes("本会话"))).toBe(true);
    expect(labels.some((label) => label.includes("以后都允许"))).toBe(false);
  });

  it("sends a one-off allow with no grant attached", () => {
    // The old body sent `remember`, which the kernel accepts and ignores, so
    // the grant the person asked for was never applied and nothing said so.
    const onApprove = vi.fn();
    render(<ApprovalCard row={approvalRow()} handlers={{ ...noop, onApprove }} />);

    act(() => byText("允许一次").click());

    expect(onApprove).toHaveBeenCalledWith("ap-1", true, false, false);
  });

  it("sends a session grant as session, not as a persisted rule", () => {
    const onApprove = vi.fn();
    render(<ApprovalCard row={approvalRow()} handlers={{ ...noop, onApprove }} />);

    act(() => byText("本会话").click());

    expect(onApprove).toHaveBeenCalledWith("ap-1", true, true, false);
  });

  it("offers a persisted rule only when the host allows one", () => {
    const onApprove = vi.fn();
    const row = approvalRow();
    row.approval.allowsPersist = true;
    render(<ApprovalCard row={row} handlers={{ ...noop, onApprove }} />);

    act(() => byText("以后都允许").click());

    expect(onApprove).toHaveBeenCalledWith("ap-1", true, true, true);
  });

  it("sends a denial with no grants", () => {
    const onApprove = vi.fn();
    render(<ApprovalCard row={approvalRow()} handlers={{ ...noop, onApprove }} />);

    act(() => byText("拒绝").click());

    expect(onApprove).toHaveBeenCalledWith("ap-1", false, false, false);
  });

  it("says the turn ended rather than claiming it was handled", () => {
    render(<ApprovalCard row={approvalRow({ pending: false, outcome: "turn_ended" })} handlers={noop} />);
    expect(container.textContent).toContain("这一轮已结束");
    expect(buttons()).toHaveLength(0);
  });

  it("shows the steps a plan approval would start", () => {
    const row = approvalRow();
    row.approval.kind = "plan";
    row.approval.subject = "";
    row.approval.input = {
      todos: [
        { content: "读取内核差异", status: "in_progress" },
        { content: "补充测试", status: "pending", level: 1 },
      ],
    };
    render(<ApprovalCard row={row} handlers={noop} />);

    expect(container.textContent).toContain("批准这份计划？");
    expect(container.textContent).toContain("将执行 2 个步骤");
    expect(container.textContent).toContain("读取内核差异");
    expect(container.textContent).toContain("补充测试");
    expect(container.querySelector('.plan-steps li[data-level="1"]')?.textContent).toContain(
      "补充测试",
    );
  });

  it("does not draw a tool call's arguments as plan steps", () => {
    const row = approvalRow();
    row.approval.input = { todos: [{ content: "不是计划", status: "pending" }] };
    render(<ApprovalCard row={row} handlers={noop} />);

    expect(container.textContent).not.toContain("将执行");
    expect(container.textContent).not.toContain("不是计划");
  });

  it("leaves a malformed plan payload to the rest of the card", () => {
    const row = approvalRow();
    row.approval.kind = "plan";
    row.approval.input = { todos: "not a list" };
    render(<ApprovalCard row={row} handlers={noop} />);

    expect(container.textContent).not.toContain("将执行");
    expect(buttons().length).toBeGreaterThan(0);
  });
});

function toolRow(overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    kind: "tool",
    id: "tool-1",
    name: "edit_file",
    outputDiff: true,
    readOnly: false,
    running: false,
    ...overrides,
  };
}

describe("ToolDetail", () => {
  it("marks added, removed and hunk lines in a diff", () => {
    render(
      <ToolDetail
        row={toolRow({
          output: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n context",
        })}
      />,
    );

    expect(container.querySelectorAll(".line.add")).toHaveLength(1);
    expect(container.querySelectorAll(".line.del")).toHaveLength(1);
    expect(container.querySelectorAll(".line.hunk")).toHaveLength(1);
    expect(container.querySelectorAll(".line.meta")).toHaveLength(2);
    expect(container.querySelector(".line.add")?.textContent?.trim()).toBe("+new");
    expect(container.querySelector(".line.del")?.textContent?.trim()).toBe("-old");
  });

  it("leaves a non-diff output as one block", () => {
    render(<ToolDetail row={toolRow({ output: "plain\noutput", outputDiff: false })} />);

    expect(container.querySelector("pre.out.diff")).toBeNull();
    expect(container.querySelector("pre.out")?.textContent).toBe("plain\noutput");
  });

  it("shows the arguments, a refusal and its output together", () => {
    render(
      <ToolDetail
        row={toolRow({
          args: '{"path":"a.ts"}',
          refusalCode: "permission.denied",
          err: "not allowed",
          output: "after",
          outputDiff: false,
        })}
      />,
    );

    expect(container.querySelector("pre")?.textContent).toContain("a.ts");
    expect(container.querySelector(".refusal")?.textContent).toContain("permission.denied");
    expect(container.querySelector(".refusal")?.textContent).toContain("not allowed");
    expect(container.querySelector("pre.out")?.textContent).toBe("after");
  });

  it("draws nothing for an assistant row with neither answer nor reasoning", () => {
    render(
      <AssistantBubble
        row={{ kind: "assistant", id: "a1", text: "", reasoning: "", streaming: false }}
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});

describe("UserBubble", () => {
  it("renders an uploaded image and hides its @reference", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("png", { status: 200, headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:message");

    render(
      <UserBubble
        row={{ kind: "user", id: "u1", text: "看看\n@.reasonix/attachments/photo.png" }}
        base="/rt/r1"
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("看看");
    expect(container.textContent).not.toContain("@.reasonix");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:message");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/rt/r1/workspace/image?path="),
      expect.anything(),
    );
  });

  it("hands a loaded picture to the viewer when it is tapped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("png", { status: 200, headers: { "content-type": "image/png" } }),
      ),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:message");
    const onOpenImage = vi.fn();

    render(
      <UserBubble
        row={{ kind: "user", id: "u2", text: "@.reasonix/attachments/photo.png" }}
        base="/rt/r1"
        onOpenImage={onOpenImage}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const button = container.querySelector('button[aria-label="放大图片"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    act(() => button.click());
    expect(onOpenImage).toHaveBeenCalledWith("blob:message");
  });
});
describe("AssistantBubble action row", () => {
  it("shows the landing clock beside the copy action when it watched the end", () => {
    const finishedAt = Date.parse("2026-11-04T07:08:00");
    render(
      <AssistantBubble
        row={{
          kind: "assistant",
          id: "a1",
          text: "好了",
          reasoning: "",
          streaming: false,
          finishedAt,
        }}
      />,
    );
    // Compare against clockText itself: the clock follows the phone's locale,
    // so the exact digits are not this test's to know.
    const shown = container.querySelector(".bubble-at")?.textContent ?? "";
    expect(shown).toBe(clockText(finishedAt));
    expect(shown).not.toBe("");
  });

  it("shows no clock for a row rebuilt from history without one", () => {
    render(
      <AssistantBubble row={{ kind: "assistant", id: "a2", text: "好了", reasoning: "", streaming: false }} />,
    );
    expect(container.querySelector(".bubble-at")).toBeNull();
  });
});
