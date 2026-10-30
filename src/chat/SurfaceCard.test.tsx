import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceCard, surfaceReady } from "./SurfaceCard";
import type { SurfaceValues } from "./SurfaceCard";
import { parseSurface, surfaceFields } from "../wire/surface";

/**
 * A surface question is the one card that used to be unanswerable: it carries
 * no options, and its answer is field values sent under `Value`. These tests
 * draw the real component and press its controls, because every claim about it
 * is a claim about what a thumb can reach.
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
  act(() => root?.unmount());
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`no button containing ${JSON.stringify(text)}`);
  return found;
}

const form = {
  spec_version: 1,
  title: "配置",
  body: [
    { kind: "text", value: "选一下设置" },
    {
      kind: "field",
      key: "count",
      label: "数量",
      field: { type: "number", required: true, min: 1, max: 5, default: 2 },
    },
    {
      kind: "choice_card",
      key: "mode",
      label: "模式",
      field: {
        type: "choice",
        options: [
          { value: "fast", label: "快速", description: "短跑" },
          { value: "full", label: "完整" },
        ],
      },
    },
  ],
};

describe("SurfaceCard", () => {
  it("draws the nodes the kernel described", () => {
    render(<SurfaceCard surface={form} pending={true} onAnswer={() => {}} />);

    expect(container.textContent).toContain("配置");
    expect(container.textContent).toContain("选一下设置");
    expect(container.textContent).toContain("数量");
    expect(button("快速")).toBeTruthy();
    expect(container.textContent).toContain("短跑");
  });

  it("starts a required field at its declared default and can be sent", () => {
    const onAnswer = vi.fn();
    render(<SurfaceCard surface={form} pending={true} onAnswer={onAnswer} />);

    // The default is 2, so the required number is already answered.
    expect(button("确认").disabled).toBe(false);

    act(() => button("确认").click());

    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]?.[0]).toMatchObject({ count: 2, mode: "" });
  });

  it("sends the chosen value, not its label", () => {
    const onAnswer = vi.fn();
    render(<SurfaceCard surface={form} pending={true} onAnswer={onAnswer} />);

    act(() => button("完整").click());
    act(() => button("确认").click());

    // The wire wants `value`; a label here would be refused as not a choice.
    expect(onAnswer.mock.calls[0]?.[0]).toMatchObject({ mode: "full" });
  });

  it("will not send while a required field is empty", () => {
    render(
      <SurfaceCard
        surface={{
          body: [
            {
              kind: "editable_text",
              key: "draft",
              label: "草稿",
              field: { type: "string", required: true },
            },
          ],
        }}
        pending={true}
        onAnswer={() => {}}
      />,
    );

    expect(button("确认").disabled).toBe(true);
  });

  it("accepts a multi-choice answer as a list", () => {
    const onAnswer = vi.fn();
    render(
      <SurfaceCard
        surface={{
          body: [
            {
              kind: "choice_card",
              key: "tags",
              label: "标签",
              field: {
                type: "multichoice",
                required: true,
                options: [
                  { value: "a", label: "A" },
                  { value: "b", label: "B" },
                ],
              },
            },
          ],
        }}
        pending={true}
        onAnswer={onAnswer}
      />,
    );

    act(() => button("A").click());
    act(() => button("B").click());
    act(() => button("确认").click());

    expect(onAnswer.mock.calls[0]?.[0]).toMatchObject({ tags: ["a", "b"] });
  });

  it("draws the display-only nodes", () => {
    render(
      <SurfaceCard
        surface={{
          body: [
            { kind: "kv", key: "模型", value: "flash" },
            { kind: "meter", label: "已用", progress: 0.4 },
            { kind: "divider" },
            { kind: "diff_preview", label: "改动", diff: { before: "旧", after: "新" } },
            {
              kind: "dashboard",
              label: "用量",
              dataset: {
                categories: ["一月", "二月"],
                series: [{ id: "s", label: "用量", values: [10, 20] }],
              },
            },
          ],
        }}
        pending={true}
        onAnswer={() => {}}
      />,
    );

    expect(container.textContent).toContain("模型");
    expect(container.textContent).toContain("flash");
    expect(container.querySelector('[role="meter"]')).toBeTruthy();
    expect(container.querySelector(".surface-divider")).toBeTruthy();
    expect(container.textContent).toContain("改动");
    expect(container.textContent).toContain("一月");
    expect(container.querySelectorAll(".surface-dash-bar").length).toBe(2);
  });

  it("keeps the rest of the card when one node kind is unknown", () => {
    render(
      <SurfaceCard
        surface={{
          body: [
            { kind: "text", value: "还在" },
            { kind: "future_widget", value: "看不见" },
          ],
        }}
        pending={true}
        onAnswer={() => {}}
      />,
    );

    expect(container.textContent).toContain("还在");
    expect(container.textContent).not.toContain("看不见");
  });

  it("draws nothing for a payload it cannot parse", () => {
    render(<SurfaceCard surface={{ body: [] }} pending={true} onAnswer={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("turns into a record once the question is settled", () => {
    render(<SurfaceCard surface={form} pending={false} onAnswer={() => {}} />);

    expect(container.textContent).toContain("已结束");
    expect(container.querySelector(".confirm")).toBeNull();
    // The controls stay visible as the record of what was asked, disabled.
    expect((container.querySelector('input[type="number"]') as HTMLInputElement).disabled).toBe(true);
  });
});

describe("surfaceReady", () => {
  it("treats a filled default as ready and an unfilled required field as not", () => {
    const nodes = parseSurface(form)?.body ?? [];
    const fields = surfaceFields(nodes);

    const withDefault: SurfaceValues = { count: 2, mode: "" };
    expect(surfaceReady(nodes, withDefault)).toBe(true);

    const missing: SurfaceValues = { count: "", mode: "" };
    expect(surfaceReady(nodes, missing)).toBe(false);
    expect(fields.get("count")?.required).toBe(true);
  });

  it("counts an unchecked bool as an answer", () => {
    const nodes = parseSurface({
      body: [
        {
          kind: "field",
          key: "ok",
          label: "同意",
          field: { type: "bool", required: true },
        },
      ],
    })?.body ?? [];

    // `false` is a decision; refusing it would make a required checkbox
    // impossible to answer negatively.
    expect(surfaceReady(nodes, { ok: false })).toBe(true);
  });
});
