/**
 * Messages sent while a turn is still running.
 *
 * The kernel has two ways to take one, and they are different promises:
 *
 * - **排队 (followup)** waits for the running turn to finish, then runs. It is
 *   the safe default: nothing about the current turn changes.
 * - **插话 (steer)** is delivered into the running turn, so the model sees it
 *   before it decides its next step. That is what "stop doing that, do this"
 *   needs — and it is also a request that can be refused (`rejected_busy`,
 *   `steer.already_applied`), because the turn may have moved on.
 *
 * `POST /rt/{id}/inbox/items` answers a receipt whose `disposition` says which
 * of those actually happened. This module carries that through rather than
 * reporting success: a steer that was queued instead is not the same thing.
 */

import { fetchWithTimeout } from "./http";

export type InboxIntent = "followup" | "steer";

/** How an admission attempt settled, as the kernel names it. */
export type Disposition =
  | "started"
  | "steer_accepted"
  | "queued_followup"
  | "rejected_busy"
  | "rejected_rotating"
  | "rejected_closed"
  | "rejected_capacity"
  | "idempotent_hit"
  | "deleted"
  | string;

export interface InboxReceipt {
  itemId: string;
  disposition: Disposition;
  position: number;
  paused: boolean;
  idempotent?: boolean;
}

export interface InboxItem {
  id: string;
  intent: InboxIntent | string;
  state: string;
  preview: string;
  /** Present when the item cannot run yet, e.g. `steer_unapplied`. */
  blockReason?: string;
  images?: boolean;
}

export interface InboxSnapshot {
  revision: number;
  paused: boolean;
  /** The queue could not be read at all: unknown contents, not empty. */
  unrecovered: boolean;
  items: InboxItem[];
}

export type InboxSend =
  | { ok: true; receipt: InboxReceipt }
  | { ok: false; code: string };

export type InboxRead =
  | { ok: true; snapshot: InboxSnapshot }
  | { ok: false; code: string };

function item(value: unknown): InboxItem | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;
  const out: InboxItem = {
    id: row.id,
    intent: typeof row.intent === "string" ? row.intent : "followup",
    state: typeof row.state === "string" ? row.state : "",
    preview: typeof row.preview === "string" ? row.preview : "",
  };
  if (typeof row.blockReason === "string" && row.blockReason) out.blockReason = row.blockReason;
  if (row.images === true) out.images = true;
  return out;
}

/**
 * Send one message into a running conversation.
 *
 * The body is `{input, intent}`: the kernel's chip form takes the text under
 * `input` and the intent beside it, so a skill chip and a plain sentence go
 * through the same door.
 */
export async function sendToInbox(
  base: string,
  input: string,
  intent: InboxIntent,
): Promise<InboxSend> {
  const text = input.trim();
  if (!text) return { ok: false, code: "client.empty_input" };
  try {
    const response = await fetchWithTimeout(
      `${base}/inbox/items`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ input: text, intent }),
      },
      20_000,
    );
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
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.itemId !== "string" || typeof body.disposition !== "string") {
      return { ok: false, code: "inbox.shape" };
    }
    return {
      ok: true,
      receipt: {
        itemId: body.itemId,
        disposition: body.disposition,
        position: typeof body.position === "number" ? body.position : 0,
        paused: body.paused === true,
        ...(body.idempotent === true ? { idempotent: true } : {}),
      },
    };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

export async function loadInbox(base: string): Promise<InboxRead> {
  try {
    const response = await fetchWithTimeout(`${base}/inbox`, { credentials: "same-origin" }, 12_000);
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
    const body = (await response.json()) as Record<string, unknown>;
    return {
      ok: true,
      snapshot: {
        revision: typeof body.revision === "number" ? body.revision : 0,
        paused: body.paused === true,
        unrecovered: body.unrecovered === true,
        items: Array.isArray(body.items)
          ? body.items.map(item).filter((entry): entry is InboxItem => entry !== null)
          : [],
      },
    };
  } catch {
    return { ok: false, code: "client.offline" };
  }
}

/** What the receipt means, in a sentence a person can act on. */
export function receiptText(receipt: InboxReceipt): string {
  switch (receipt.disposition) {
    case "steer_accepted":
      return "已插话，这一轮会看到。";
    case "queued_followup":
      return `已排队，这一轮结束后发（第 ${receipt.position} 位）。`;
    case "started":
      return "已发送。";
    case "idempotent_hit":
      return "这条已经发过了。";
    case "rejected_busy":
      return "这一轮正在切换状态，稍等再试。";
    case "rejected_rotating":
      return "这个会话正在切换，稍等再试。";
    case "rejected_closed":
      return "这个会话已经关了。";
    case "rejected_capacity":
      return "队列满了，等前面的发完再试。";
    default:
      return `已发送（${receipt.disposition}）。`;
  }
}

/** A refusal, as a sentence. */
export function inboxMessage(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "等电脑回应超时，检查连接后重试。";
    case "client.empty_input":
      return "没有内容可发。";
    case "inbox.shape":
      return "桌面端返回了无法识别的回执。";
    case "steer.already_applied":
      return "这条插话已经被这一轮用过了。";
    case "inbox.capacity_items":
    case "inbox.capacity_bytes":
      return "队列满了，等前面的发完再试。";
    case "inbox.paused":
      return "队列已暂停，先恢复再发。";
    case "inbox.unrecovered":
      return "队列读不出来，去桌面端看看。";
    case "inbox.item_too_large":
      return "这条太大了。";
    default:
      return `没发出去：${code}`;
  }
}
