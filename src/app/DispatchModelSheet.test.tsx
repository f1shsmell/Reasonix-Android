import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchModelSheet } from "./DispatchModelSheet";
import type { ModelCatalog } from "../net/models";

/**
 * The dispatch sheet and the conversation's model sheet must read alike:
 * same words for the reasoning levels, and a selected row a person can find
 * without comparing text colours.
 */

const catalog: ModelCatalog = {
  current: "demo-flash",
  label: "demo",
  default: "demo-flash",
  models: [
    {
      ref: "demo-flash",
      provider: "demo",
      model: "demo-flash",
      displayName: "Demo Flash",
      active: true,
      default: true,
      efforts: ["auto", "low", "high"],
      contextWindow: 128000,
    },
    {
      ref: "demo-reasoner",
      provider: "demo",
      model: "demo-reasoner",
      displayName: "Demo Reasoner",
      active: false,
      default: false,
      efforts: ["auto", "low", "high", "max"],
      contextWindow: 256000,
    },
  ],
};

let container: HTMLDivElement;
let root: Root | null = null;

function render(props: Partial<React.ComponentProps<typeof DispatchModelSheet>> = {}): void {
  act(() => root?.unmount());
  root = createRoot(container);
  act(() => {
    root?.render(
      <DispatchModelSheet
        catalog={catalog}
        loading={false}
        error=""
        model="demo-flash"
        effort="high"
        onPickModel={() => {}}
        onEffort={() => {}}
        onClose={() => {}}
        {...props}
      />,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("DispatchModelSheet", () => {
  it("marks the picked model with the same check the chat sheet uses", () => {
    render();
    const picked = Array.from(container.querySelectorAll(".model-row")).find((row) =>
      row.textContent?.includes("demo-flash"),
    );
    expect(picked?.querySelector(".model-mark")?.textContent).toBe("✓");
    const other = Array.from(container.querySelectorAll(".model-row")).find((row) =>
      row.textContent?.includes("demo-reasoner"),
    );
    expect(other?.querySelector(".model-mark")?.textContent).toBe("");
  });

  it("names the reasoning levels the way the chat sheet does", () => {
    render();
    const group = container.querySelector('[aria-label="思考等级"]');
    const labels = Array.from(group?.querySelectorAll("button") ?? []).map(
      (button) => button.textContent,
    );
    expect(labels).toEqual(["自动", "低", "高"]);
  });
});
