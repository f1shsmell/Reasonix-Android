/**
 * The stored conversation, as `GET /history` writes it.
 *
 * Mirrored from `internal/frontend/serve/history.go` (`historyMessage`) and the
 * desktop's `port/session.ts`. The stream only carries what happened since the
 * app attached, so a reopened conversation has to be read from here first and
 * folded into the same rows — otherwise a phone shows an empty transcript for a
 * session that has been running for days.
 *
 * As with the events, every field is optional but the role: the kernel omits
 * empty values, and unknown fields are ignored rather than rejected.
 */

export type HistoryRole = "system" | "user" | "assistant" | "tool";

/** One call a message made. `arguments` is the model's JSON string, not an object. */
export interface HistoryToolCall {
  id: string;
  name: string;
  arguments?: string;
  /** What a stable proxy actually reached, when it differs from `name`. */
  resolvedName?: string;
  capabilityId?: string;
}

/** A call whose result is stored outside the message that made it. */
export interface HistoryToolContext {
  messageIndex: number;
  ordinal: number;
  call: HistoryToolCall;
}

export interface HistoryMessage {
  role: HistoryRole;
  content: string;
  reasoning?: string;
  /** Which model wrote this assistant turn; a rebuild has no `turn_started`. */
  modelRef?: string;
  /** Kernel-measured thinking time; absent on turns recorded before it was. */
  thoughtMs?: number;
  /** Only on the answer that closed a turn. */
  workDurationMs?: number;
  /** Unix ms a user turn landed. */
  createdAt?: number;
  /** How many attachments the turn carried — not the attachments themselves. */
  images?: number;
  toolCalls?: HistoryToolCall[];
  toolCallId?: string;
  toolName?: string;
  /** The host's own account of a result that did not succeed. */
  toolFailed?: boolean;
  /** The host's dotted refusal identity. `content` is only its wording. */
  toolRefusalCode?: string;
  /** The whole output is a unified diff, re-derived by the host. */
  outputDiff?: boolean;
  /** The session index this message occupies. */
  msgIndex: number;
  /** A user-role message the host wrote, not the person. */
  hostAuthored?: boolean;
  /** Guidance sent into a running turn rather than a turn of its own. */
  steer?: boolean;
}

export interface HistoryPage {
  messages: HistoryMessage[];
  toolContext: HistoryToolContext[];
  snapshot: string;
  start: number;
  end: number;
  total: number;
  hasMoreBefore: boolean;
  nextCursor?: string;
  turnStartedAt?: number;
}