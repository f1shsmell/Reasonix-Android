/**
 * The kernel transport seam.
 *
 * The phone's kernel boundary is HTTP plus SSE; every endpoint module above
 * this file already describes the contract. Swapping the transport is what lets
 * a dev build run the real UI against a scripted kernel without changing a
 * screen or an endpoint module.
 */

export interface KernelEventSource {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface KernelTransport {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  eventSource(url: string, init?: EventSourceInit): KernelEventSource;
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