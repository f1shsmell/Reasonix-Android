/**
 * The project → conversation tree.
 *
 * The kernel's sidebar endpoint already answers this shape: one row per
 * remembered folder, each with its newest conversations. The phone draws that
 * directly, which is the difference between "five panes called Reasonix" and
 * "these are my projects, and here is what is inside one".
 *
 * `/tree` is not host-only, so a paired device may read it; opening a
 * conversation inside a project is a `POST /runtimes` naming that project's
 * root, which the device gate already allows.
 */

import type { TreeProject, TreeSession } from "../wire/tree";
import { fetchWithTimeout } from "./http";

/** Rows per project. The kernel caps a window at 300. */
export const DEFAULT_TREE_LIMIT = 60;

export interface TreeRequest {
  /** Rows per project. */
  limit?: number;
  /** A larger window for one project, after "show more". */
  limits?: Record<string, number>;
}

export type TreeRead =
  | { ok: true; projects: TreeProject[] }
  | { ok: false; code: string };

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function session(value: unknown): TreeSession | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const path = string(row.path);
  if (!path) return null;
  const out: TreeSession = { path, name: string(row.name) || path };
  if (typeof row.title === "string" && row.title) out.title = row.title;
  if (typeof row.turns === "number") out.turns = row.turns;
  if (typeof row.runtimeId === "string" && row.runtimeId) out.runtimeId = row.runtimeId;
  if (row.archived === true) out.archived = true;
  if (row.pinned === true) out.pinned = true;
  if (typeof row.lastActiveAt === "number" && row.lastActiveAt > 0) out.lastActiveAt = row.lastActiveAt;
  if (row.unread === true) out.unread = true;
  if (row.legacy === true) out.legacy = true;
  return out;
}

function project(value: unknown): TreeProject | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const root = string(row.root);
  if (!root) return null;
  const sessions = Array.isArray(row.sessions)
    ? row.sessions.map(session).filter((entry): entry is TreeSession => entry !== null)
    : [];
  const out: TreeProject = {
    root,
    name: string(row.name) || root,
    total: count(row.total),
    remaining: count(row.remaining),
    sessions,
  };
  if (Array.isArray(row.workspaceRoots)) {
    const roots = row.workspaceRoots.filter((entry): entry is string => typeof entry === "string");
    if (roots.length > 0) out.workspaceRoots = roots;
  }
  if (row.open === true) out.open = true;
  if (row.remembered === true) out.remembered = true;
  if (row.missing === true) out.missing = true;
  if (count(row.archived) > 0) out.archived = count(row.archived);
  return out;
}

/**
 * Read the tree.
 *
 * `scope=active` is deliberate: the phone is a reading surface, and an
 * archived conversation is one the desktop decided to put away. The counts the
 * kernel sends still describe every row, so a project can say how many it
 * holds without listing them.
 */
export async function loadTree(request: TreeRequest = {}): Promise<TreeRead> {
  const query = new URLSearchParams({ scope: "active" });
  query.set("limit", String(request.limit ?? DEFAULT_TREE_LIMIT));
  if (request.limits && Object.keys(request.limits).length > 0) {
    query.set("limits", JSON.stringify(request.limits));
  }
  try {
    const response = await fetchWithTimeout(`/tree?${query.toString()}`, {
      credentials: "same-origin",
    }, 15_000);
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
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return { ok: false, code: "tree.shape" };
    const projects = body.map(project).filter((entry): entry is TreeProject => entry !== null);
    if (body.length > 0 && projects.length === 0) return { ok: false, code: "tree.shape" };
    return { ok: true, projects };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}
