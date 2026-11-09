/**
 * Forking a conversation at the turn that asked for an answer.
 *
 * The kernel copies the transcript up to that turn into a new session file and
 * answers its path; opening it is the caller's job, the same way a new session
 * is opened. A turn still running cannot be a cut point, and the kernel says so
 * with its own code rather than leaving this side to guess.
 */

import { fetchWithTimeout } from "./http";

export type BranchWrite = { ok: true; path: string } | { ok: false; code: string };

export async function branchAt(base: string, turn: number, name: string): Promise<BranchWrite> {
  try {
    const response = await fetchWithTimeout(
      `${base}/branch/at`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ turn, name }),
      },
      30_000,
    );
    if (response.ok) {
      const body = (await response.json()) as { path?: unknown };
      if (typeof body.path === "string" && body.path) return { ok: true, path: body.path };
      return { ok: false, code: "branch.shape" };
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

/** Why a branch was refused, in words the person can act on. */
export function branchMessage(code: string): string {
  switch (code) {
    case "conversation_branch.turn_running":
      return "这一轮还在跑，结束后再建分支。";
    case "conversation_branch.unavailable":
      return "这一轮没有检查点，不能从这里分出去。";
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "电脑没有及时回应，稍后重试。";
    default:
      return `没建成分支：${code}`;
  }
}
