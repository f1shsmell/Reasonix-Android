/**
 * What one pane says about itself right now.
 *
 * `GET /rt/{id}/status` is the kernel's own snapshot of a conversation: the
 * decisions it is blocked on, the model it is running, whether a turn is in
 * flight. The phone reads it for two things a list cannot answer — "is this
 * conversation waiting for me?" and "which model am I talking to?".
 *
 * `decisions` is the authoritative list of things waiting on the person. It is
 * derived from the owning subsystems on every read, so a card answered on the
 * desktop disappears here without any bookkeeping of our own.
 */

import { fetchWithTimeout } from "./http";

/** Which subsystem owns a decision, and therefore what settles it. */
export type DecisionKind =
  | "tool_approval"
  | "plan_approval"
  | "recovery_approval"
  | "ask";

export interface DecisionQuestion {
  id: string;
  header?: string;
  prompt: string;
  reason?: string;
  options: { label: string; description?: string }[];
  multi?: boolean;
}

export interface Decision {
  id: string;
  kind: DecisionKind | string;
  questions?: DecisionQuestion[];
}

export interface RuntimeStatus {
  decisions: Decision[];
  /** The model this conversation runs, e.g. `deepseek/deepseek-flash`. */
  modelRef?: string;
  effort?: string;
  running: boolean;
  busy: boolean;
  plan: boolean;
  /** Which tools run without asking: `readOnly` | `ask` | `auto` | `dontAsk` | `yolo`. */
  toolApprovalMode?: string;
  workspaceRoot?: string;
  sessionPath?: string;
}

export type StatusRead =
  | { ok: true; status: RuntimeStatus }
  | { ok: false; code: string };

function question(value: unknown): DecisionQuestion | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const prompt = typeof row.prompt === "string" ? row.prompt : "";
  if (!prompt) return null;
  const out: DecisionQuestion = {
    id: typeof row.id === "string" ? row.id : "",
    prompt,
    options: Array.isArray(row.options)
      ? row.options.flatMap((option) => {
          if (option === null || typeof option !== "object") return [];
          const entry = option as Record<string, unknown>;
          if (typeof entry.label !== "string") return [];
          return [
            {
              label: entry.label,
              ...(typeof entry.description === "string" && entry.description
                ? { description: entry.description }
                : {}),
            },
          ];
        })
      : [],
  };
  if (typeof row.header === "string" && row.header) out.header = row.header;
  if (typeof row.reason === "string" && row.reason) out.reason = row.reason;
  if (row.multi === true) out.multi = true;
  return out;
}

function decision(value: unknown): Decision | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;
  const out: Decision = {
    id: row.id,
    kind: typeof row.kind === "string" ? row.kind : "unknown",
  };
  if (Array.isArray(row.questions)) {
    const questions = row.questions
      .map(question)
      .filter((entry): entry is DecisionQuestion => entry !== null);
    if (questions.length > 0) out.questions = questions;
  }
  return out;
}

function status(value: unknown): RuntimeStatus | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const out: RuntimeStatus = {
    decisions: Array.isArray(row.decisions)
      ? row.decisions.map(decision).filter((entry): entry is Decision => entry !== null)
      : [],
    running: row.running === true,
    busy: row.busy === true,
    plan: row.plan === true,
  };
  if (typeof row.modelRef === "string" && row.modelRef) out.modelRef = row.modelRef;
  if (typeof row.effort === "string" && row.effort) out.effort = row.effort;
  if (typeof row.toolApprovalMode === "string" && row.toolApprovalMode) {
    out.toolApprovalMode = row.toolApprovalMode;
  }
  if (typeof row.workspaceRoot === "string" && row.workspaceRoot) {
    out.workspaceRoot = row.workspaceRoot;
  }
  if (typeof row.sessionPath === "string" && row.sessionPath) out.sessionPath = row.sessionPath;
  return out;
}

export async function loadStatus(base: string): Promise<StatusRead> {
  try {
    const response = await fetchWithTimeout(`${base}/status`, { credentials: "same-origin" }, 12_000);
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
    const parsed = status(await response.json());
    return parsed ? { ok: true, status: parsed } : { ok: false, code: "status.shape" };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

/**
 * Turn planning on or off for this conversation.
 *
 * Plan mode is a hub setting the desktop exposes next to the composer; the
 * phone reaches the same `POST /rt/{id}/plan` so a plan started here is the
 * same plan the desktop approves. It is not a message: the next turn reads it.
 */
export type PlanWrite = { ok: true } | { ok: false; code: string };

export async function setPlanMode(base: string, on: boolean): Promise<PlanWrite> {
  try {
    const response = await fetchWithTimeout(
      `${base}/plan`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ on }),
      },
      12_000,
    );
    if (response.ok) return { ok: true };
    try {
      const body = (await response.json()) as { code?: unknown };
      if (body && typeof body === "object" && typeof body.code === "string") {
        return { ok: false, code: body.code };
      }
    } catch {
      // A refusal that is not JSON still has an HTTP status.
    }
    return { ok: false, code: `http.${response.status}` };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

/**
 * A decision as one sentence.
 *
 * The kinds are different subsystems, and "waiting for approval" is wrong for
 * a question: one wants a yes/no, the other wants an answer the person has to
 * type or choose. The list is what tells them which conversation to open.
 */
export function decisionLabel(item: Decision): string {
  const first = item.questions?.[0];
  if (first) {
    return first.header?.trim() || first.prompt;
  }
  switch (item.kind) {
    case "tool_approval":
      return "等你批准一个工具调用";
    case "plan_approval":
      return "等你批准这份计划";
    case "recovery_approval":
      return "等你确认怎么恢复";
    case "ask":
      return "等你回答一个问题";
    default:
      return "等你处理";
  }
}

/** The verb a decision's row shows beside its conversation name. */
export function decisionVerb(item: Decision): string {
  switch (item.kind) {
    case "ask":
      return "待回答";
    case "plan_approval":
      return "待批准计划";
    case "recovery_approval":
      return "待恢复";
    case "tool_approval":
      return "待批准";
    default:
      return "待处理";
  }
}
