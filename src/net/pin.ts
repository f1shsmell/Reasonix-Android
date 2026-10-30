/**
 * Rearranging the sidebar: pinning a conversation, moving a project.
 *
 * Both are promises to the kernel as much as to the person. A pin stops the
 * automatic archiver from guessing what should be kept, so it is posted to
 * `/tree/sessions/pin` rather than kept as a phone-side flag — a local list
 * would keep a row on screen while the kernel archived it. A project order is
 * the window's own remembered order, so it goes to `/tree/workspaces/move`.
 *
 * The kernel does not sort pinned rows first, and does not fold the moved
 * project into the answer: the screen that draws the list applies
 * `pinnedFirst` and re-reads the tree afterwards.
 */

import type { TreeSession } from "../wire/tree";
import { fetchWithTimeout } from "./http";

export type TreeWrite = { ok: true } | { ok: false; code: string };

async function post(path: string, body: unknown): Promise<TreeWrite> {
  try {
    const response = await fetchWithTimeout(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      },
      15_000,
    );
    if (response.ok) return { ok: true };
    try {
      const parsed = (await response.json()) as { code?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.code === "string") {
        return { ok: false, code: parsed.code };
      }
    } catch {
      // A refusal that is not JSON still has an HTTP status.
    }
    return { ok: false, code: `http.${response.status}` };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

export function setPinned(path: string, pinned: boolean): Promise<TreeWrite> {
  const target = path.trim();
  if (!target) return Promise.resolve({ ok: false, code: "client.empty_path" });
  return post("/tree/sessions/pin", { path: target, pinned });
}

/**
 * Put one project before another in the remembered order; `""` means the end.
 *
 * The same placement the desktop's drag makes, so a drop here and a drop there
 * name the same position. The kernel removes the project and reinserts it, so
 * the order after the call is the one the finger described.
 */
export function placeProject(path: string, before: string): Promise<TreeWrite> {
  const target = path.trim();
  if (!target) return Promise.resolve({ ok: false, code: "client.empty_path" });
  return post("/tree/workspaces/move", { path: target, before: before.trim() });
}

/**
 * Pinned conversations first, each group keeping the order it arrived in.
 *
 * The tree is already sorted by activity inside a project; this is a stable
 * partition, not a re-sort, so pinning one row does not reshuffle the rest.
 */
export function pinnedFirst(sessions: TreeSession[]): TreeSession[] {
  const pinned = sessions.filter((session) => session.pinned === true);
  if (pinned.length === 0) return sessions;
  const rest = sessions.filter((session) => session.pinned !== true);
  return [...pinned, ...rest];
}

/** A refusal from either write, as a sentence. */
export function treeWriteMessage(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "等电脑回应超时，检查连接后重试。";
    case "client.empty_path":
      return "这一行没有路径。";
    case "session.outside_workspace":
      return "这个会话不在已知项目里。";
    case "session.bad_path":
      return "这个会话的路径读不出来。";
    case "workspace.unknown":
    case "workspace.not_found":
      return "这个项目不在桌面端的列表里。";
    case "workspace.running":
      return "这个项目里还有会话在跑。";
    case "workspace.not_remembered":
      return "这个项目没有被记住，不能排序。";
    default:
      return `没改成：${code}`;
  }
}
