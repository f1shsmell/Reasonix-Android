/**
 * The context window of one conversation, and folding it.
 *
 * Both routes are per runtime (`GET /rt/{id}/context`, `POST /rt/{id}/compact`),
 * so this belongs next to the conversation, not to the machine: the same phone
 * can hold two computers and several panes, each with its own window. Reading
 * it from a machine-level screen showed the gauge of whichever runtime happened
 * to be first in the list.
 *
 * The kernel's numbers are answers, not guesses: `used`/`window` are the gauge,
 * the class breakdown says what is filling it, and `compact_at` is where a fold
 * actually happens. That last one is drawn against its own bound rather than the
 * window, because a 1M-token session sits at 16% when it folds.
 */

import { fetchWithTimeout } from "./http";

export interface ContextLargest {
  /** Message class: system, tools, user, reply or output. */
  class: string;
  /** Tool that produced it, when it came from one. */
  tool: string;
  tokens: number;
}

export interface ContextSnapshot {
  used: number;
  window: number;
  system: number;
  tools: number;
  user: number;
  reply: number;
  output: number;
  /** Where maintenance happens; the lower of the capacity and economic bounds. */
  compactAt: number;
  /** Which bound `compactAt` is: "capacity" or "economic". */
  boundary: string;
  capacityAt: number;
  largest: ContextLargest[];
}

export type ContextRead = { ok: true; context: ContextSnapshot } | { ok: false; code: string };

/**
 * What a fold did.
 *
 * A declined fold is a verdict about this transcript — nothing left worth
 * folding — and is reported as one rather than as a failure, because that is
 * what it is: the kernel answered.
 */
export type CompactResult =
  | { ok: true; compacted: true }
  | { ok: true; compacted: false; reason: string; detail: string }
  | { ok: false; code: string };

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function largest(value: unknown): ContextLargest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    return [
      {
        class: text(row.class),
        tool: text(row.tool),
        tokens: num(row.tokens),
      },
    ];
  });
}

/** `base` is the runtime's request prefix, e.g. `/rt/r1`. */
export async function loadContext(base: string): Promise<ContextRead> {
  try {
    const response = await fetchWithTimeout(`${base}/context`, { credentials: "same-origin" }, 12_000);
    if (!response.ok) {
      try {
        const body = (await response.json()) as { code?: unknown };
        if (body && typeof body === "object" && typeof body.code === "string") {
          return { ok: false, code: body.code };
        }
      } catch {
        // A refusal that is not JSON still has an HTTP status.
      }
      return { ok: false, code: `http.${response.status}` };
    }
    const body = (await response.json()) as Record<string, unknown>;
    return {
      ok: true,
      context: {
        used: num(body.used),
        window: num(body.window),
        system: num(body.system),
        tools: num(body.tools),
        user: num(body.user),
        reply: num(body.reply),
        output: num(body.output),
        compactAt: num(body.compact_at),
        boundary: text(body.boundary),
        capacityAt: num(body.capacity_at),
        largest: largest(body.largest),
      },
    };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

/**
 * Fold this conversation's context now.
 *
 * The kernel refuses while a turn is running — `cannot compact while a turn is
 * running or the session is changing` — and that refusal is reported with its
 * code so the sheet can say "wait for this turn" instead of showing a failure
 * the person cannot act on. A fold rewrites the transcript, so the caller
 * re-reads history once it succeeds.
 */
export async function compactContext(base: string): Promise<CompactResult> {
  try {
    const response = await fetchWithTimeout(
      `${base}/compact`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        // The kernel's CSRF guard refuses a POST without a JSON content type,
        // and its handler ignores the body.
        body: "{}",
      },
      // A fold asks the model to summarise, so it is a turn-sized wait.
      120_000,
    );
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      if (body.compacted === true) return { ok: true, compacted: true };
      return {
        ok: true,
        compacted: false,
        reason: text(body.reason),
        detail: text(body.detail),
      };
    }
    try {
      const body = (await response.json()) as { code?: unknown };
      if (body && typeof body === "object" && typeof body.code === "string") {
        return { ok: false, code: body.code };
      }
    } catch {
      // A refusal that is not JSON still has an HTTP status.
    }
    return { ok: false, code: `http.${response.status}` };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}
