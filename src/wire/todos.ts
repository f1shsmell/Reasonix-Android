/**
 * The canonical task list, mirrored from
 * `internal/frontend/serve/todos.go`.
 *
 * `GET /rt/{id}/todos` returns the latest `todo_write` merged with every
 * `complete_step` advance. It is deliberately not derived from the transcript:
 * an advance writes no `todo_write`, and a refused write does land there. The
 * phone reads this list instead of trying to fold it out of the conversation.
 */

export interface WireTodo {
  content: string;
  /** `pending` | `in_progress` | `completed`. A newer kernel may add one. */
  status: string;
  /** Present-continuous wording for the row while it is the current one. */
  activeForm?: string;
  /** 0 = phase, 1 = sub-step of the phase above it. */
  level?: number;
}

/**
 * The `todo_progress` payload.
 *
 * It carries counts and three revisions — never the list. The list itself is
 * read from `/todos`; this frame is what says the list changed and which of
 * its three clocks moved.
 */
export interface WireTodoProgress {
  kind: string;
  steps?: number;
  completed?: number;
  contentRevision?: number;
  planRevision?: number;
  progressRevision?: number;
}
