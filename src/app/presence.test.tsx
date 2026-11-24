import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_MS, motionReduced, useSheetExit } from "./presence";
import type { SheetExit } from "./presence";

let container: HTMLDivElement;
let root: Root | null = null;

function Probe({ onClose, sink }: { onClose: () => void; sink: (exit: SheetExit) => void }) {
  const exit = useSheetExit(onClose);
  sink(exit);
  return <span data-closing={exit.closing ? "yes" : "no"} />;
}

function mount(onClose: () => void): { exit: () => SheetExit; closing: () => string | null } {
  let latest: SheetExit | null = null;
  root = createRoot(container);
  act(() => {
    root?.render(<Probe onClose={onClose} sink={(exit) => (latest = exit)} />);
  });
  return {
    exit: () => latest as SheetExit,
    closing: () => container.querySelector("span")?.getAttribute("data-closing") ?? null,
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sheet exit", () => {
  it("plays the exit before it closes, so the surface is seen leaving", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const onClose = vi.fn();
    const sheet = mount(onClose);

    act(() => sheet.exit().close());
    // The first frame is the exit, not the unmount.
    expect(sheet.closing()).toBe("yes");
    expect(onClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(EXIT_MS - 1));
    expect(onClose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores a second close while the exit is running", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const onClose = vi.fn();
    const sheet = mount(onClose);

    act(() => {
      sheet.exit().close();
      sheet.exit().close();
    });
    act(() => vi.advanceTimersByTime(EXIT_MS));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes at once when the person asked for less motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
    const onClose = vi.fn();
    const sheet = mount(onClose);

    act(() => sheet.exit().close());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(sheet.closing()).toBe("no");
  });

  it("treats a renderer with no media queries as no motion", () => {
    // jsdom has no matchMedia; nothing can animate, so nothing should wait.
    expect(motionReduced()).toBe(true);
  });
});
