import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalCard, AskCard } from "./Rows";
import type { ApprovalRow, AskRow } from "./transcript";

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

const noop = { onAnswer: () => {}, onApprove: () => {} };

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