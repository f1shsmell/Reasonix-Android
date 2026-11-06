/**
 * The agent's task list, as the kernel holds it.
 *
 * It sits above the transcript because it describes the work behind the
 * conversation, not one turn inside it: the list outlives the message that
 * wrote it. Collapsed it is one line — progress, count, and what is being
 * worked on — so a phone gives up one row, not a third of the screen.
 */

import type { WireTodo } from "../wire/todos";

export type TodosState = "loading" | "loaded" | "failed";

type TodoStatus = "pending" | "in_progress" | "completed";

/**
 * Normalise a status the way the desktop does: anything this client does not
 * know is still open work. Drawing an unknown status as done would claim the
 * agent finished something it may not have.
 */
function statusOf(todo: WireTodo): TodoStatus {
  if (todo.status === "completed") return "completed";
  if (todo.status === "in_progress") return "in_progress";
  return "pending";
}

const MARK: Record<TodoStatus, string> = {
  completed: "✓",
  in_progress: "●",
  pending: "○",
};

export function TodoPanel({ todos, state }: { todos: WireTodo[]; state: TodosState }) {
  // No list and nothing read: the panel would be an empty header. The chat is
  // complete without it, so it simply is not there.
  if (todos.length === 0) return null;

  let done = 0;
  let current: WireTodo | undefined;
  for (const todo of todos) {
    const status = statusOf(todo);
    if (status === "completed") done += 1;
    if (status === "in_progress" && current === undefined) current = todo;
  }
  const percent = Math.round((done / todos.length) * 100);
  const label =
    current !== undefined
      ? current.activeForm ?? current.content
      : done === todos.length
        ? "全部完成"
        : "任务";
  // Keys come from content, not position: an index key re-keys every row on
  // any reorder, remounting the whole list mid-animation. Duplicate contents
  // (the same line can appear at different levels) get an occurrence number
  // so their keys stay unique — and stable per occurrence.
  const occurrences = new Map<string, number>();

  return (
    <details className="todos">
      <summary>
        <span className="todo-progress" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </span>
        <span className="todo-count">
          {done}/{todos.length}
        </span>
        <span className="todo-current">{label}</span>
        <span className="chev" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <ol>
        {todos.map((todo) => {
          const status = statusOf(todo);
          const content = `${todo.level ?? 0}:${todo.content}`;
          const seen = occurrences.get(content) ?? 0;
          occurrences.set(content, seen + 1);
          return (
            <li
              // The counter is appended unconditionally: a first occurrence's
              // bare key would collide with a later occurrence of a title that
              // itself ends in `#<n>`.
              key={`${content}#${seen}`}
              className={`todo ${status}`}
              data-level={todo.level ?? 0}
            >
              <span className="mark" aria-hidden="true">
                {MARK[status]}
              </span>
              <span className="todo-text">
                {todo.content}
                {status === "in_progress" && todo.activeForm ? (
                  <small>{todo.activeForm}</small>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
      {state === "failed" ? (
        <div className="todo-stale">任务列表暂时没更新，显示的是上一次读到的。</div>
      ) : null}
    </details>
  );
}
