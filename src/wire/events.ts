/**
 * The kernel's event wire format, mirrored from
 * `internal/contract/eventwire/wire.go`.
 *
 * Every field is optional except `kind`: the kernel omits empty values, so a
 * missing field and an empty one mean the same thing. Unknown fields are
 * ignored rather than rejected — the phone and the desktop update on different
 * schedules, so the contract only grows.
 */

import type { WireTodoProgress } from "./todos";

export type EventKind =
  | "turn_started"
  | "reasoning"
  | "text"
  | "message"
  | "tool_dispatch"
  | "tool_result"
  | "tool_progress"
  | "usage"
  | "notice"
  | "phase"
  | "turn_phase"
  | "approval_request"
  | "ask_request"
  | "ask_engaged"
  | "turn_done"
  | "compaction_started"
  | "compaction_progress"
  | "compaction_done"
  | "mcp_surface_ready"
  | "retrying"
  | "steer"
  | "guardian_assessment"
  | "extension_surface"
  | "extension_status"
  | "stream_attempt"
  | "context_maintenance"
  | "todo_progress"
  | "workspace_lease"
  | "workspace_changed"
  | "completion_summary"
  | "inbox_changed"
  | "rewind_changed"
  | "adjudications_changed"
  | "browser_tabs_changed"
  | "graph_delta"
  | "progress_watch"
  // Transport frames: the stream describing itself, not a kernel event.
  | "stream_gap"
  | "stream_watermark";

/** One tool call, carried by both `tool_dispatch` and `tool_result`. */
export interface WireTool {
  id?: string;
  name: string;
  /** The call's arguments, as the model wrote them: a JSON string, not an object. */
  args?: string;
  output?: string;
  err?: string;
  /** The host's dotted identity for a refusal. `err` is only its wording. */
  refusalCode?: string;
  /** The whole output is a unified diff and should render as one. */
  outputDiff?: boolean;
  readOnly?: boolean;
  /** Truncation or bounding, when the host cut the output short. */
  truncated?: boolean;
  images?: string[];
}

export interface WireAskOption {
  label: string;
  description?: string;
}

/**
 * One question inside an ask. The kernel's `eventwire.Ask` carries a list of
 * these, not one prompt: a form with three questions arrives as a single event
 * with three entries, and every answer names the question it settles.
 */
export interface WireAskQuestion {
  id: string;
  header?: string;
  prompt: string;
  /** Why only the person can answer: `user_decision` | `missing_value`. */
  reason?: string;
  options: WireAskOption[];
  multi?: boolean;
  /** A prefilled answer, for a form sent back to be corrected. */
  default?: string[];
  callId?: string;
  /**
   * A structured form instead of options.
   *
   * A question carrying this has no choices to pick: the answer is an object of
   * field values, sent under `Value` with `Selected` empty. Rendered as a
   * plain question it says "no options" and cannot be answered at all, which
   * is what this field exists to fix.
   */
  surface?: unknown;
}

/**
 * An `ask_request` payload, as `eventwire.Ask` writes it.
 *
 * This was modelled flat once — one prompt carrying its own options — which
 * the kernel never sends. A flat model draws a question with no options and
 * answers with the wrong body; both were live bugs, found by asking a real
 * kernel rather than by reading the struct.
 */
export interface WireAsk {
  id: string;
  questions: WireAskQuestion[];
  origin?: {
    kind?: string;
    source?: string;
    message?: string;
    note?: string;
    url?: string;
  };
  skipInMs?: number;
}

/**
 * One answer to one question. The Go type carries no json tags, so the wire
 * keys are the Go field names. Verified against a real kernel: a bare string
 * list is refused with `request.missing_field`, this shape is accepted.
 */
export interface WireAskAnswer {
  QuestionID: string;
  Selected: string[];
  Value?: Record<string, unknown>;
}

export interface WireApproval {
  id: string;
  tool: string;
  subject: string;
  reason?: string;
  reasonCode?: string;
  allowsSession?: boolean;
  allowsPersist?: boolean;
  /** `tool` | `plan` | `recovery` */
  kind?: string;
}

export interface WireUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  estimated?: boolean;
}

/** An event as it arrives. Exactly one of the payload fields is meaningful. */
export interface EventPayload {
  kind: string;
  text?: string;
  detail?: string;
  code?: string;
  reasoning?: string;
  thoughtMs?: number;
  level?: string;
  /** `operator` means the kernel kept it off the end-user conversation. */
  audience?: string;
  tool?: WireTool;
  usage?: WireUsage;
  ask?: WireAsk;
  approval?: WireApproval;
  err?: string;
  cancelled?: boolean;
  outcome?: string;
  /** `turn_done`: wall-clock ms the turn's runs took. */
  workDurationMs?: number;
  workStartedAt?: number;
  modelRef?: string;
  source?: string;
  /** `turn_started` / `steer`: the person's own message for this turn. */
  attachments?: unknown[];
  /**
   * `todo_progress`: counters and three revisions. It never carries the list —
   * that is read from `GET /rt/{id}/todos`.
   */
  todoProgress?: WireTodoProgress;
  /** Transport frames carry the sequence they vouch for. */
  seq?: number;
  [field: string]: unknown;
}
