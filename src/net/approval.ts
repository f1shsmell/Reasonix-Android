/**
 * How much a conversation asks before running a tool.
 *
 * This is a per-conversation posture, not a machine setting: the kernel keeps
 * one stance per hub and applies it to panes opened later, but the read and
 * the write are both addressed to a runtime. The phone therefore offers it
 * where a conversation is open, and says which conversation it changes.
 *
 * The five names are the kernel's own (`ParseToolApprovalMode` accepts exactly
 * these). A phone that invented "允许全部" would be posting a word the kernel
 * refuses, so the labels live beside the wire values rather than in their
 * place.
 */

import { fetchWithTimeout } from "./http";

export interface ApprovalChoice {
  value: string;
  label: string;
  /** What it lets through, in one line. */
  hint: string;
}

export const APPROVAL_CHOICES: ApprovalChoice[] = [
  { value: "readOnly", label: "只读", hint: "只跑读取类工具" },
  { value: "ask", label: "逐次询问", hint: "每次调用都要你批准" },
  { value: "auto", label: "自动", hint: "安全的自动跑，危险的再问" },
  { value: "dontAsk", label: "不再问", hint: "几乎不再打扰你" },
  { value: "yolo", label: "全放开", hint: "什么都不问，谨慎使用" },
];

export type ApprovalResult = { ok: true } | { ok: false; code: string };

export async function setApprovalMode(base: string, mode: string): Promise<ApprovalResult> {
  const target = mode.trim();
  if (!target) return { ok: false, code: "client.empty_mode" };
  try {
    const response = await fetchWithTimeout(
      `${base}/tool-approval-mode`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ mode: target }),
      },
      15_000,
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

/** The label for a wire value; an unknown one is shown as it arrived. */
export function approvalLabel(value: string | undefined): string {
  if (!value) return "";
  return APPROVAL_CHOICES.find((choice) => choice.value === value)?.label ?? value;
}

/** A refusal, as a sentence. */
export function approvalMessage(code: string): string {
  switch (code) {
    case "client.offline":
      return "连不上电脑，检查连接后重试。";
    case "client.timeout":
      return "等电脑回应超时，检查连接后重试。";
    case "client.empty_mode":
      return "没有选择模式。";
    default:
      return `没改成：${code}`;
  }
}
