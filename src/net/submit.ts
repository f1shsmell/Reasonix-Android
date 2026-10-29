/**
 * Sending a turn, as a state a person can see.
 *
 * A phone's network dies mid-request, so "sent" is not one fact. The states are
 * kept apart because each asks the person for something different: a draft is
 * theirs to edit, a failure is theirs to retry, and an unconfirmed send is
 * theirs to check before it is sent twice.
 */

import { fetchWithTimeout, RequestTimeout } from "./http";

export type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "failed"; detail: string; retryable: boolean };

export interface SubmitResult {
  ok: boolean;
  /** The kernel's dotted refusal code, or a transport error. */
  code?: string;
  /** True when trying the same input again could plausibly succeed. */
  retryable?: boolean;
}

/**
 * What the kernel refused with. `internal/frontend/serve/fail.go` writes
 * `{code, error, params}` — `code` is the stable identity and `error` is only
 * its wording for a human, so nothing here reads the message.
 */
interface Refusal {
  code?: string;
  error?: string;
  params?: Record<string, unknown>;
}

async function refusal(response: Response): Promise<Refusal> {
  try {
    return (await response.json()) as Refusal;
  } catch {
    return {};
  }
}

/**
 * Codes meaning "not while something else is running" are not the person's
 * error to fix by retrying the same way, and a missing credential will not fix
 * itself. A 5xx or a dead socket might.
 */
function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** `base` is the runtime's request prefix, e.g. `/rt/r1`. */
export async function submit(base: string, input: string): Promise<SubmitResult> {
  const text = input.trim();
  if (!text) return { ok: false, code: "client.empty" };
  try {
    const response = await fetchWithTimeout(`${base}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ input: text }),
    }, 15_000);
    if (response.ok) return { ok: true };
    const body = await refusal(response);
    return {
      ok: false,
      code: body.code ?? `http.${response.status}`,
      retryable: retryable(response.status),
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof RequestTimeout ? "client.timeout" : "client.offline",
      retryable: error instanceof Error,
    };
  }
}

/** Ask the kernel to stop the running turn. */
export async function cancel(base: string): Promise<SubmitResult> {
  try {
    const response = await fetchWithTimeout(`${base}/cancel`, {
      method: "POST",
      credentials: "same-origin",
    }, 8_000);
    if (response.ok) return { ok: true };
    const body = await refusal(response);
    return { ok: false, code: body.code ?? `http.${response.status}` };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof RequestTimeout ? "client.timeout" : "client.offline",
      retryable: true,
    };
  }
}
