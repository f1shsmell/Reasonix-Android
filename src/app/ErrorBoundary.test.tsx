import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error("boom");
}

describe("ErrorBoundary", () => {
  it("keeps a render failure on screen with a recovery action", () => {
    root = createRoot(container);
    act(() => {
      root?.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });

    expect(container.textContent).toContain("界面出错了");
    expect(container.textContent).toContain("boom");
    expect(container.querySelector("button")?.textContent).toBe("重新加载");
  });
});
