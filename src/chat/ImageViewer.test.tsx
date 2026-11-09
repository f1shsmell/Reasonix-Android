import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageViewer } from "./ImageViewer";

let container: HTMLDivElement;
let root: Root | null = null;
let onClose = vi.fn();

/** jsdom has no PointerEvent; React only reads the fields the gestures use. */
function pointer(node: Element, type: string, x = 0, y = 0): void {
  act(() => {
    node.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
    );
  });
}

function tap(node: Element, x = 0, y = 0): void {
  pointer(node, "pointerdown", x, y);
  pointer(node, "pointerup", x, y);
}

function render(): void {
  root = createRoot(container);
  act(() => root?.render(<ImageViewer src="blob:photo" onClose={onClose} />));
}

function picture(): HTMLImageElement {
  return container.querySelector("img") as HTMLImageElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  onClose = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("ImageViewer", () => {
  it("shows the picture and closes from its button", () => {
    render();

    expect(picture().getAttribute("src")).toBe("blob:photo");
    act(() => (container.querySelector('button[aria-label="关闭预览"]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("zooms on a double tap and returns on the next one", () => {
    render();

    tap(picture(), 40, 40);
    tap(picture(), 40, 40);
    expect(picture().style.transform).toContain("scale(2.5)");

    tap(picture(), 40, 40);
    tap(picture(), 40, 40);
    expect(picture().style.transform).toContain("scale(1)");
  });

  it("closes on a tap on the empty stage but not on the picture", () => {
    render();

    tap(picture(), 40, 40);
    expect(onClose).not.toHaveBeenCalled();

    tap(container.querySelector(".image-viewer-stage") as Element, 200, 200);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
