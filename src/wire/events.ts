/**
 * The kernel's event wire format, mirrored from
 * `internal/contract/eventwire/wire.go`.
 *
 * Every field is optional except `kind`: the kernel omits empty values, so a
 * missing field and an empty one mean the same thing. Unknown fields are
 * ignored rather than rejected — the phone and the desktop update on different
 * schedules, so the contract only grows.
 */

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

export interface WireAsk {
  id: string;
  header?: string;
  prompt: string;
  reason?: string;
  options: WireAskOption[];
  multi?: boolean;
  default?: string[];
  callId?: string;
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
  /** `todo_progress` and friends carry their payload under this key. */
  todoProgress?: { items?: unknown[] };
  /** Transport frames carry the sequence they vouch for. */
  seq?: number;
  [field: string]: unknown;
}
