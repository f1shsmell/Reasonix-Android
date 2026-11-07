/**
 * The steps a plan approval card carries.
 *
 * A plan card's input is the starter list approving seeds — todo_write-shaped,
 * `{"todos":[...]}`. Drawing it means the person reads the steps before allowing
 * them. Only a plan card has this field; a tool call's arguments arrive only
 * with a declared scope, and a malformed payload must leave the card usable
 * rather than blank it.
 */

import type { WireApproval } from "../wire/events";
import type { WireTodo } from "../wire/todos";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The plan's steps, or none when the card carries no readable list. */
export function approvalPlanSteps(approval: WireApproval): WireTodo[] {
  if (approval.kind !== "plan") return [];
  const input = approval.input;
  if (input === null || typeof input !== "object") return [];
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const content = text(row.content);
    if (!content) return [];
    const level =
      typeof row.level === "number" && Number.isFinite(row.level) && row.level > 0
        ? Math.floor(row.level)
        : 0;
    return [{ content, status: text(row.status) || "pending", level }];
  });
}
