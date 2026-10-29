/**
 * Requests with a deadline.
 *
 * A phone's worst network is not "offline": it is a socket that connected and
 * then went quiet — the laptop slept, Wi-Fi roamed, a NAT mapping died. The
 * browser will keep such a fetch pending indefinitely, which turns into a
 * spinner that never resolves and a composer that never unlocks. Every kernel
 * and proxy request therefore runs through this module.
 *
 * `AbortSignal.timeout` is not used on purpose: Android WebViews older than
 * Chromium 103 do not have it, and this app targets whatever WebView the phone
 * ships. The controller below also composes a caller's own signal, so a screen
 * that navigates away still cancels its request.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;
/** An image upload is 10 MB of base64 over a LAN; it needs its own budget. */
export const UPLOAD_TIMEOUT_MS = 60_000;

export class RequestTimeout extends Error {
  readonly code = "client.timeout";

  constructor(
    readonly timeoutMs: number,
    message = `request did not answer within ${timeoutMs} ms`,
  ) {
    super(message);
    this.name = "RequestTimeout";
  }
}

export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init.signal;
  let timedOut = false;

  const forwardAbort = () => controller.abort();
  if (upstream) {
    if (upstream.aborted) controller.abort();
    else upstream.addEventListener("abort", forwardAbort, { once: true });
  }

  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      // Abort first so the socket is actually released, then reject. Racing
      // the fetch instead of trusting it to honour the signal keeps the
      // deadline true even for an implementation that ignores `AbortSignal`.
      controller.abort();
      reject(new RequestTimeout(timeoutMs));
    }, timeoutMs);

    Promise.resolve(fetch(input, { ...init, signal: controller.signal })).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        // A caller's own abort is not a timeout and must stay distinguishable.
        if (timedOut) reject(new RequestTimeout(timeoutMs));
        else reject(error);
      },
    );
  }).finally(() => {
    upstream?.removeEventListener("abort", forwardAbort);
  });
}

/**
 * Bound any promise, not just a fetch.
 *
 * Recovery composes several awaits (proxy probe, relay handshake, runtime
 * list). A lock around that composition must be released even when one step
 * never settles, so each step gets a deadline of its own.
 */
export function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  message = `operation did not finish within ${timeoutMs} ms`,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestTimeout(timeoutMs, message)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
