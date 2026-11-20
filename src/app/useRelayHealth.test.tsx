import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kernelTransport, setKernelTransport } from "../net/transport";
import { useRelayHealth } from "./useRelayHealth";
import type { RelayHealth } from "./useRelayHealth";

/**
 * The hook is the seam between the relay's self-healing window and the two
 * surfaces that must not claim health during it (the chat dot, the Home chip).
 */

let container: HTMLDivElement;
let root: Root | null = null;
const seen: RelayHealth[] = [];

function Probe(): null {
  seen.push(useRelayHealth());
  return null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  seen.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("useRelayHealth", () => {
  it("follows the real relay's condition when nothing is scripted", () => {
    // No relay is routing in this environment: the first state the watcher
    // pushes is `none`, which is what a LAN session should show.
    act(() => {
      root = createRoot(container);
      root?.render(<Probe />);
    });
    expect(seen.at(-1)).toBe("none");
  });

  it("reports the transport's scripted lane", () => {
    const previous = kernelTransport();
    setKernelTransport({ ...previous, relayState: () => "reconnecting" });
    try {
      act(() => {
        root = createRoot(container);
        root?.render(<Probe />);
      });
    } finally {
      setKernelTransport(previous);
    }
    expect(seen.at(-1)).toBe("reconnecting");
  });
});
