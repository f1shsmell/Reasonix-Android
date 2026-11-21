/**
 * The kernel transport seam.
 *
 * The phone's kernel boundary is HTTP plus SSE; every endpoint module above
 * this file already describes the contract. Swapping the transport is what lets
 * a dev build run the real UI against a scripted kernel without changing a
 * screen or an endpoint module.
 */

/**
 * How a runtime's frames reach the phone: the LAN's native SSE, the relay's
 * mux push lane, or the relay's polled fallback.
 */
export type EventChannel = "sse" | "mux" | "poll";

export interface KernelEventSource {
  readonly readyState: number;
  /**
   * The lane this source settled on, set by the time `onopen` fires. A source
   * that does not know (the browser's native EventSource) leaves it unset and
   * the stream reports `sse`.
   */
  channel?: EventChannel;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface KernelTransport {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  eventSource(url: string, init?: EventSourceInit): KernelEventSource;
  /**
   * The relay link's health, when this transport owns one. The dev mock
   * scripts recovery states through it; the production build leaves it unset
   * and the caller reads the real link instead.
   */
  relayState?: () => "open" | "reconnecting" | "ended" | null;
}

const browserTransport: KernelTransport = {
  fetch: (input, init) => fetch(input, init),
  eventSource: (url, init) => new EventSource(url, init),
};

let active: KernelTransport = browserTransport;

export function kernelTransport(): KernelTransport {
  return active;
}

export function setKernelTransport(next: KernelTransport): void {
  active = next;
}