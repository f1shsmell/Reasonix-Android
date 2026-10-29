/**
 * Projects and new conversations.
 *
 * The kernel already holds the project list and the open panes. A phone must not
 * invent a folder picker: a paired device may only open a root the desktop
 * already knows, and `/workspaces` is exactly that list. Opening a runtime is
 * therefore both "new session in this project" and "open that recent project".
 */

import type { RuntimeView } from "../wire/runtime";
import { fetchWithTimeout } from "./http";

export interface WorkspaceEntry {
  path: string;
  name: string;
}

export interface WorkspaceInfo {
  current: string;
  canSwitch: boolean;
  canIsolate: boolean;
  recents: WorkspaceEntry[];
  isolated?: boolean;
}

export type WorkspacesRead =
  | { ok: true; info: WorkspaceInfo }
  | { ok: false; code: string };

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

function entry(value: unknown): WorkspaceEntry | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as { path?: unknown; name?: unknown };
  if (typeof row.path !== "string" || !row.path) return null;
  return {
    path: row.path,
    name: typeof row.name === "string" && row.name ? row.name : row.path,
  };
}

export async function loadWorkspaces(base: string): Promise<WorkspacesRead> {
  try {
    const response = await fetchWithTimeout(`${base}/workspaces`, { credentials: "same-origin" }, 15_000);
    if (!response.ok) return { ok: false, code: await failureCode(response) };
    const body = (await response.json()) as Record<string, unknown>;
    const recents = Array.isArray(body.recents)
      ? body.recents.map(entry).filter((value): value is WorkspaceEntry => value !== null)
      : [];
    return {
      ok: true,
      info: {
        current: typeof body.current === "string" ? body.current : "",
        canSwitch: body.canSwitch === true,
        canIsolate: body.canIsolate === true,
        recents,
        ...(body.isolated === true ? { isolated: true } : {}),
      },
    };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

/**
 * Open a new pane on a root the kernel already knows. The hub creates a fresh
 * conversation (`sessionPath` empty), which is what a phone's "new session"
 * and "open this project" both mean.
 */
export async function openRuntime(root: string): Promise<RuntimeOpen> {
  const path = root.trim();
  if (!path) return { ok: false, code: "client.empty_root" };
  try {
    const response = await fetchWithTimeout("/runtimes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ root: path }),
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
