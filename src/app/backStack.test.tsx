import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTopSheet, useBackCloser } from "./backStack";

let container: HTMLDivElement;
let root: Root | null = null;

function Sheet({ open, close }: { open: boolean; close: () => void }) {
  useBackCloser(open, close);
  return null;
}

function render(children: ReactNode): void {
  root = createRoot(container);
  act(() => root?.render(children));
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

describe("back stack", () => {
  it("reports nothing to close when no sheet is open", () => {
    expect(closeTopSheet()).toBe(false);
  });

  it("closes the sheet opened last", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <>
        <Sheet open close={first} />
        <Sheet open close={second} />
      </>,
    );

    expect(closeTopSheet()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("forgets a closed sheet and falls back to the one below", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <>
        <Sheet open close={first} />
        <Sheet open={false} close={second} />
      </>,
    );

    closeTopSheet();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("drops registrations when the sheet unmounts", () => {
    const close = vi.fn();
    render(<Sheet open close={close} />);
    act(() => root?.unmount());
    root = null;

    expect(closeTopSheet()).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});
