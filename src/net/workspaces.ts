/**
 * Opening panes on folders the kernel already knows.
 *
 * A phone must not invent a folder picker: a paired device may only open a
 * root the desktop already knows. Opening a runtime is therefore both "new
 * session in this project" and "open that conversation".
 *
 * The project list itself comes from `GET /tree` (`src/net/tree.ts`), not from
 * `/rt/{id}/workspaces`: that route needs the host grant and only reports what
 * one pane happens to be looking at.
 */

import type { RuntimeView } from "../wire/runtime";
import { fetchWithTimeout } from "./http";

export type RuntimeOpen =
  | { ok: true; runtime: RuntimeView }
  | { ok: false; code: string };

async function failureCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown };
    if (body && typeof body === "object" && typeof body.code === "string") return body.code;
  } catch {
    // A refusal that is not JSON still has an HTTP status.
  }
  return `http.${response.status}`;
}

/**
 * Open a pane on a root the kernel already knows.
 *
 * With no `sessionPath` the hub mints a fresh conversation, which is what
 * "new session in this project" means. With one it binds that transcript —
 * the project's own stored conversation — and answers the pane already driving
 * it if there is one, so tapping a session that is running on the desktop
 * attaches to it rather than opening a second writer.
 */
export async function openRuntime(root: string, sessionPath?: string): Promise<RuntimeOpen> {
  const path = root.trim();
  if (!path) return { ok: false, code: "client.empty_root" };
  const session = sessionPath?.trim() ?? "";
  try {
    const response = await fetchWithTimeout("/runtimes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(session ? { root: path, sessionPath: session } : { root: path }),
    }, 15_000);
    if (!response.ok) return { ok: false, code: await failureCode(response) };
    const runtime = (await response.json()) as RuntimeView;
    if (!runtime || typeof runtime.id !== "string" || typeof runtime.base !== "string") {
      return { ok: false, code: "runtime.shape" };
    }
    return { ok: true, runtime };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}
