/**
 * Answering the two things the kernel stops for: a question and an approval.
 *
 * Both were written once from reading the Go structs and were both wrong on
 * the wire. What is here now was verified against a real kernel:
 *
 * - `POST /answer` with `answers: ["茶"]` → 400 `request.missing_field`, because
 *   the decoder wants `[]event.AskAnswer` and a bare string is not one.
 *   `answers: [{QuestionID, Selected}]` → 204.
 * - `POST /approve` accepts `{id, allow, session, persist}`. It also accepts a
 *   `remember` field and silently ignores it — the answer still lands, just
 *   without the grant the person asked for. Sending it would look like it
 *   worked, which is worse than failing.
 *
 * A prompt reply is a state, not a fire-and-forget call: the phone drops the
 * network constantly, and "did my answer land?" is the only question that
 * matters after a reconnect. The kernel makes a repeated identical answer
 * safe (it is refused only when it differs), so retrying is allowed.
 */

import type { WireAskAnswer } from "../wire/events";

export type PromptState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "done" }
  | { kind: "failed"; code: string; retryable: boolean };

export interface PromptResult {
  ok: boolean;
  /** The kernel's dotted code, or a transport code. Never its wording. */
  code?: string;
  retryable?: boolean;
}

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

/** A 5xx or a dead socket might fix itself; a refusal the person must read will not. */
function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function post(base: string, path: string, body: unknown): Promise<PromptResult> {
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    const refusalBody = await refusal(response);
    return {
      ok: false,
      code: refusalBody.code ?? `http.${response.status}`,
      retryable: retryable(response.status),
    };
  } catch {
    return { ok: false, code: "client.offline", retryable: true };
  }
}

/**
 * Answer every question in one ask.
 *
 * The kernel settles the whole ask at once, so a form with three questions is
 * answered by three entries naming their own question ids. A question left out
 * of the list reads to the kernel as unanswered, not as "no preference".
 */
export function answer(base: string, askId: string, answers: WireAskAnswer[]): Promise<PromptResult> {
  return post(base, "/answer", { id: askId, answers });
}

/**
 * Settle an approval.
 *
 * `session` grants the rest of this conversation, `persist` writes a rule that
 * outlives it. They are separate because the kernel honours them separately:
 * asking for a persistable grant where the host allows only a session one
 * silently downgrades, and the person is never told.
 */
export function approve(
  base: string,
  approvalId: string,
  allow: boolean,
  session: boolean,
  persist: boolean,
): Promise<PromptResult> {
  return post(base, "/approve", { id: approvalId, allow, session, persist });
}