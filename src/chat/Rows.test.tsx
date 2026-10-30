import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard, AskCard, AssistantBubble, ToolDetail, UserBubble } from "./Rows";
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

describe("AskCard", () => {
  it("draws every option of the question it was given", () => {
    // The flat shape this used to read had no options at all, so the card
    // rendered a question with no way to answer it.
    render(<AskCard row={askRow()} handlers={noop} />);
    expect(buttons().map((button) => button.textContent)).toEqual(["茶", "咖啡", "确认"]);
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
    expect(byText("确认").disabled).toBe(true);

    act(() => byText("b").click());
    act(() => byText("确认").click());

    expect(onAnswer).toHaveBeenCalledWith("ask-1", { q1: ["a"], q2: ["b"] });
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
      new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }),
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
});