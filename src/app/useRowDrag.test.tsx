import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAG_HOLD_MS, useRowDrag } from "./useRowDrag";

const ROWS = ["r0", "r1", "r2"];

function box(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: 300,
    width: 300,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function Harness({ place, enabled = true }: { place: (key: string, index: number) => void; enabled?: boolean }) {
  const drag = useRowDrag<HTMLUListElement>({
    rows: ROWS.map((key) => ({ key, movable: true })),
    enabled,
    place,
  });
  return (
    <div className="body">
      <ul ref={drag.listRef} data-dragging={drag.state ? "true" : undefined}>
        {ROWS.map((key, index) => (
          <li key={key} data-drag-key={key} {...drag.row(key)}>
            Row {index}
          </li>
        ))}
      </ul>
    </div>
  );
}

function pointer(type: string, pointerId: number, clientX: number, clientY: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerType: { value: "touch" },
  });
  return event;
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  // The hook skips its edge-scroll loop without rAF; jsdom's would otherwise
  // keep running against a fake clock.
  vi.stubGlobal("requestAnimationFrame", undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.tagName === "UL") return box(0, ROWS.length * 50);
    if (this.classList.contains("body")) return box(0, 300);
    const key = this.getAttribute("data-drag-key");
    if (key) {
      const index = Number(key.slice(1));
      return box(index * 50, 50);
    }
    return box(0, 0);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(node: ReactNode): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
}

function hold(): void {
  act(() => {
    vi.advanceTimersByTime(DRAG_HOLD_MS);
  });
}

describe("useRowDrag", () => {
  it("lifts after the hold and drops at the row under the finger", async () => {
    const place = vi.fn();
    await render(<Harness place={place} />);

    const row = container.querySelector('[data-drag-key="r0"]') as HTMLElement;
    act(() => {
      row.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    });
    hold();
    expect(document.querySelector(".drag-ghost")).toBeTruthy();

    act(() => {
      window.dispatchEvent(pointer("pointermove", 1, 10, 120));
      window.dispatchEvent(pointer("pointerup", 1, 10, 120));
    });
    expect(place).toHaveBeenCalledWith("r0", 2);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(document.querySelector(".drag-ghost")).toBeNull();
  });

  it("treats movement before the hold as a scroll", async () => {
    const place = vi.fn();
    await render(<Harness place={place} />);

    const row = container.querySelector('[data-drag-key="r0"]') as HTMLElement;
    act(() => {
      row.dispatchEvent(pointer("pointerdown", 1, 10, 10));
      window.dispatchEvent(pointer("pointermove", 1, 10, 40));
    });
    hold();

    expect(document.querySelector(".drag-ghost")).toBeNull();
    act(() => {
      window.dispatchEvent(pointer("pointerup", 1, 10, 40));
    });
    expect(place).not.toHaveBeenCalled();
  });

  it("does not wedge when a release never reached the row", async () => {
    const place = vi.fn();
    await render(<Harness place={place} />);

    const first = container.querySelector('[data-drag-key="r0"]') as HTMLElement;
    act(() => {
      first.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    });
    hold();
    expect(document.querySelector(".drag-ghost")).toBeTruthy();

    // No pointerup at all: the new press may even carry another pointer id.
    // The old entry is stale, and must not block this gesture.
    const second = container.querySelector('[data-drag-key="r1"]') as HTMLElement;
    act(() => {
      second.dispatchEvent(pointer("pointerdown", 2, 10, 60));
    });
    expect(document.querySelector(".drag-ghost")).toBeNull();

    hold();
    expect(document.querySelector(".drag-ghost")).toBeTruthy();
    act(() => {
      window.dispatchEvent(pointer("pointermove", 2, 10, 10));
      window.dispatchEvent(pointer("pointerup", 2, 10, 10));
    });
    expect(place).toHaveBeenCalledWith("r1", 0);
  });

  it("ends a drag when the window loses focus", async () => {
    const place = vi.fn();
    await render(<Harness place={place} />);

    const row = container.querySelector('[data-drag-key="r0"]') as HTMLElement;
    act(() => {
      row.dispatchEvent(pointer("pointerdown", 1, 10, 10));
    });
    hold();

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(document.querySelector(".drag-ghost")).toBeNull();
    expect(place).not.toHaveBeenCalled();
  });

  it("refuses the browser context menu on a row", async () => {
    await render(<Harness place={vi.fn()} />);

    const row = container.querySelector('[data-drag-key="r0"]') as HTMLElement;
    const allowed = row.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
    expect(allowed).toBe(false);
  });
});
