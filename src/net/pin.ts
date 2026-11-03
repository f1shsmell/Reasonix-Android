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

/** Set the title the sidebar and the phone both read for this transcript. */
export function renameSession(path: string, title: string): Promise<TreeWrite> {
  const target = path.trim();
  if (!target) return Promise.resolve({ ok: false, code: "client.empty_path" });
  return post("/tree/sessions/rename", { path: target, title: title.trim() });
}

/** Remove one stored conversation; a running turn is refused by the kernel. */
export function removeSession(path: string): Promise<TreeWrite> {
  const target = path.trim();
  if (!target) return Promise.resolve({ ok: false, code: "client.empty_path" });
  return post("/tree/sessions/remove", { path: target });
}

/**
 * Move one conversation into another project.
 *
 * `target` is the destination project's root, the same spelling the desktop's
 * move dialog sends. What travels is the transcript and the person's own
 * labels; a conversation a window has open, or another writer holds, is
 * refused rather than pulled out from under its work.
 */
export function moveSessionTo(path: string, target: string): Promise<TreeWrite> {
  const from = path.trim();
  const to = target.trim();
  if (!from || !to) return Promise.resolve({ ok: false, code: "client.empty_path" });
  return post("/tree/sessions/move-to", { path: from, target: to });
}

/**
 * Archive a conversation, or bring one back.
 *
 * Archived rows leave the active lists on the kernel's side — the phone reads
 * `scope=active`, so the row disappears here without a local flag. A pinned
 * row only stops the *automatic* archiver; an explicit archive still lands.
 */
export function setArchived(path: string, archived: boolean): Promise<TreeWrite> {
  const target = path.trim();
  if (!target) return Promise.resolve({ ok: false, code: "client.empty_path" });
  return post("/tree/sessions/archive", { path: target, archived });
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
    case "session.running":
      return "这个会话还在运行，先停止再操作。";
    case "session.in_use":
      return "这个会话正在被写入，稍后再试。";
    case "session.in_use_by":
      return "另一个设备或桌面端正打开这个会话，先关掉再改。";
    case "session.move_open":
      return "这个会话在桌面端开着，先关掉那个窗口再移动。";
    case "session.same_project":
      return "这个会话已经在那个项目里了。";
    case "session.move_held_by":
      return "另一个程序正打开这个会话的文件，稍后再移动。";
    case "agent_composition.workspace_bound":
      return "这个会话的组合绑定在原项目上，去目标项目开新会话吧。";
    case "session.unknown":
      return "这个会话已经不在了。";
    case "session.title_save_failed":
      return "标题没有保存成功，稍后再试。";
    case "device.host_only":
      return "桌面端不允许手机做这个操作。";
    case "workspace.unknown":
    case "workspace.not_found":
      return "这个项目不在桌面端的列表里。";
    case "workspace.running":
      return "这个项目里还有会话在跑。";
    case "workspace.not_remembered":
      return "这个项目没有被记住，不能排序。";
    case "http.404":
    case "http.405":
      // A moved or missing route is almost always a kernel older than the
      // feature — say that rather than showing a bare status.
      return "这台电脑上的桌面端版本可能还没有这个功能，把桌面端更新到最新再试。";
    default:
      return `没改成：${code}`;
  }
}
