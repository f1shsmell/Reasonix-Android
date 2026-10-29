/**
 * The canonical task list, read from the kernel rather than folded from the
 * transcript.
 *
 * Reading is allowed to fail without failing the chat screen: a conversation
 * with a working stream and no checklist is better than no screen at all. The
 * caller is told which happened.
 */

import type { WireTodo } from "../wire/todos";

export type TodosRead = { ok: true; items: WireTodo[] } | { ok: false; code: string };

function isTodo(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  // A row with no text cannot be drawn. The kernel requires it, so this only
  // drops something a newer contract would have to explain anyway.
  return typeof row.content === "string" && row.content !== "";
}

function toTodo(row: Record<string, unknown>): WireTodo {
  const todo: WireTodo = {
    content: String(row.content),
    // An unknown status is not an error, but drawing it as a thing the agent
    // is working on would be. The UI normalises it to "pending".
    status: typeof row.status === "string" ? row.status : "pending",
  };
  if (typeof row.activeForm === "string" && row.activeForm) todo.activeForm = row.activeForm;
  if (typeof row.level === "number" && Number.isFinite(row.level)) todo.level = row.level;
  return todo;
}

export async function loadTodos(base: string): Promise<TodosRead> {
  try {
    const response = await fetch(`${base}/todos`, { credentials: "same-origin" });
    if (!response.ok) return { ok: false, code: `http.${response.status}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      // A 200 whose body is not JSON is a shape refusal, not a dead socket.
      return { ok: false, code: "todos.shape" };
    }
    if (!Array.isArray(body)) return { ok: false, code: "todos.shape" };
    const items: WireTodo[] = [];
    for (const entry of body) {
      if (isTodo(entry)) items.push(toTodo(entry));
    }
    return { ok: true, items };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

/**
 * A cheap identity for "the list may have changed".
 *
 * The frame carries no list, only revisions, so two frames with the same three
 * revisions cannot have changed what `/todos` would answer. One with any clock
 * moved can. This is what keeps a chatty turn from re-reading on every frame.
 */
export function todoRevision(progress: {
  contentRevision?: number;
  planRevision?: number;
  progressRevision?: number;
} | undefined): string {
  if (!progress) return "";
  return [
    progress.contentRevision ?? 0,
    progress.planRevision ?? 0,
    progress.progressRevision ?? 0,
  ].join(":");
}
