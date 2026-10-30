/**
 * Returning a conversation to a checkpoint the kernel took before a turn.
 *
 * The read lists snapshots; the write is two steps because the second one
 * changes files. `prepare` answers what would be restored and what the
 * snapshot cannot reach, and only a plan id can be committed. The phone never
 * constructs the plan itself — that rule lives in the kernel.
 */

import { fetchWithTimeout } from "./http";

export interface Checkpoint {
  turn: number;
  prompt: string;
  files: number;
  msgIndex?: number;
}

export interface RewindGap {
  reason: string;
  detail: string;
  tool?: string;
}

export interface RewindPlan {
  planId: string;
  turn: number;
  coverage: string;
  coverageGaps?: RewindGap[];
  canFiles: boolean;
  canConversation: boolean;
  disabledReason?: string;
  fileCount: number;
  requiresConfirmation: boolean;
}

export interface RewindResult {
  ok?: boolean;
  transactionId?: string;
  undoAvailable?: boolean;
  conversationOk?: boolean;
  error?: string;
}

export type RewindReply<T> =
  | { ok: true; value: T }
  | { ok: false; code: string };

async function refusal(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown; error?: unknown };
    if (typeof body.code === "string") return body.code;
    if (typeof body.error === "string") return body.error;
  } catch {
    // A refusal without a body still has a status.
  }
  return `http.${response.status}`;
}

async function post<T>(path: string, body: unknown): Promise<RewindReply<T>> {
  try {
    const response = await fetchWithTimeout(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      },
      20_000,
    );
    if (!response.ok) return { ok: false, code: await refusal(response) };
    return { ok: true, value: (await response.json()) as T };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

export async function loadCheckpoints(base: string): Promise<Checkpoint[] | null> {
  try {
    const response = await fetchWithTimeout(`${base}/checkpoints`, { credentials: "same-origin" }, 12_000);
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return null;
    return body.filter((entry): entry is Checkpoint => {
      if (entry === null || typeof entry !== "object") return false;
      const row = entry as Record<string, unknown>;
      return typeof row.turn === "number" && typeof row.prompt === "string" && typeof row.files === "number";
    });
  } catch {
    return null;
  }
}

export function prepareRewind(base: string, turn: number): Promise<RewindReply<RewindPlan>> {
  return post<RewindPlan>(`${base}/rewind/prepare`, { turn, scope: "both" });
}

export function commitRewind(base: string, planId: string): Promise<RewindReply<RewindResult>> {
  return post<RewindResult>(`${base}/rewind/commit`, { planId });
}

export function rewindMessage(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "电脑没有及时回应，稍后重试。";
    default:
      return `没回到这里：${code}`;
  }
}
