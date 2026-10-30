/**
 * The state of this phone's link to a computer.
 *
 * A connection is not a boolean. It is attempted in steps, can be lost and
 * reopened without the person asking, and a failure needs to say which step
 * failed and whether trying again could help. This module is the vocabulary
 * and the backoff rule; the machine that drives it lives in `useLink`.
 *
 * Nothing here knows about a transport. "LAN" and "cloud" are doors the
 * machine tries; the state only records where it got to.
 */

export type LinkPhase = "idle" | "connecting" | "connected" | "reconnecting" | "failed";

/** The visible stages of one attempt, in order. */
export type LinkStep = "probe" | "switch" | "verify";

export const LINK_STEPS: LinkStep[] = ["probe", "switch", "verify"];

export function stepLabel(step: LinkStep): string {
  switch (step) {
    case "probe":
      return "正在查找电脑";
    case "switch":
      return "正在切换连接";
    case "verify":
      return "正在读取会话";
  }
}

export interface LinkError {
  /** A dotted code, kept so a caller can tell transport from authorization. */
  code: string;
  /** One sentence a person can act on. */
  message: string;
  /** Raw technical detail for a "详情" disclosure. */
  detail?: string;
  /** True when trying the same door again could plausibly work. */
  retryable: boolean;
}

export interface LinkState {
  phase: LinkPhase;
  /** Stage in progress while connecting / reconnecting. */
  step?: LinkStep;
  /** Stages already done in this attempt. */
  completed: LinkStep[];
  /** Which door is being used, for the chip and the progress line. */
  target?: string;
  /** What to call that door ("192.168.5.2:56789", "工作室的 Mac"). */
  name?: string;
  mode?: "lan" | "cloud";
  /** Reconnect attempt number (1-based). */
  attempt: number;
  /** Unix milliseconds of the next automatic attempt. */
  nextRetryAt?: number;
  error?: LinkError;
}

export const idleLink: LinkState = { phase: "idle", completed: [], attempt: 0 };

/** A connection state for an attempt that has just started. */
export function connectingLink(step: LinkStep, previous?: LinkState): LinkState {
  const completed = LINK_STEPS.filter((candidate) => LINK_STEPS.indexOf(candidate) < LINK_STEPS.indexOf(step));
  return {
    phase: "connecting",
    step,
    completed,
    attempt: previous?.attempt ?? 0,
    ...(previous?.target ? { target: previous.target } : {}),
    ...(previous?.name ? { name: previous.name } : {}),
    ...(previous?.mode ? { mode: previous.mode } : {}),
  };
}

/** Short text for the Home chip and settings rows. */
export function linkSummary(state: LinkState): string {
  switch (state.phase) {
    case "idle":
      return "未连接";
    case "connecting":
      return state.step ? `${stepLabel(state.step)}…` : "正在连接…";
    case "connected":
      return state.mode === "cloud" ? "云端已连接" : "局域网已连接";
    case "reconnecting":
      return state.attempt > 1 ? `正在重连（第 ${state.attempt} 次）` : "正在重连…";
    case "failed":
      return "连接失败";
  }
}

/** Dot tone, matching the app's other status dots. */
export function linkTone(state: LinkState): "ok" | "warn" | "bad" | "idle" | "busy" {
  switch (state.phase) {
    case "connected":
      return "ok";
    case "connecting":
      return "busy";
    case "reconnecting":
      return "warn";
    case "failed":
      return "bad";
    case "idle":
      return "idle";
  }
}

/**
 * A failure said in the terms the person can act on.
 *
 * Authorization failures are deliberately not retryable: another attempt
 * changes nothing until the pairing or the sign-in is renewed. Everything
 * transport-shaped is, because a network can come back.
 */
export function linkFailure(code: string, detail?: string): LinkError {
  const withDetail = detail ? { detail } : {};
  switch (code) {
    case "device.unauthorized":
    case "http.401":
    case "http.403":
      return {
        code,
        message: "配对或登录已失效，请在设置里重新连接。",
        retryable: false,
        ...withDetail,
      };
    case "account.signed_out":
    case "account.required":
    case "remote_reauth_required":
      return { code, message: "Reasonix 账号已退出，请重新登录。", retryable: false, ...withDetail };
    case "device_not_found":
      return { code, message: "这台电脑已从账号里移除。", retryable: false, ...withDetail };
    case "client.timeout":
      return { code, message: "电脑没有及时回应，稍后重试。", retryable: true, ...withDetail };
    case "no.doors":
      return { code, message: "还没有连过电脑，先在设置里扫码或登录。", retryable: false, ...withDetail };
    case "client.offline":
    case "proxy.upstream_unreachable":
    case "http.502":
    case "http.503":
    case "http.504":
      return { code, message: "到不了这台电脑，检查网络后重试。", retryable: true, ...withDetail };
    default:
      return { code, message: `没连上：${code}`, retryable: true, ...withDetail };
  }
}

/**
 * Exponential backoff with full jitter.
 *
 * Half fixed and half random keeps a phone that lost Wi-Fi from retrying in
 * lockstep with every other client when the router comes back. `exhausted`
 * counts attempts already handed out, so the eighth delay is followed by a
 * final failure rather than a ninth attempt.
 */
export class Backoff {
  attempt = 0;

  constructor(
    readonly initialMs = 1_000,
    readonly maxMs = 30_000,
    readonly maxAttempts = 8,
    private readonly random: () => number = Math.random,
  ) {}

  get exhausted(): boolean {
    return this.attempt >= this.maxAttempts;
  }

  /** The delay before the next attempt, incrementing [attempt]. */
  next(): number {
    this.attempt += 1;
    const exp = this.initialMs * 2 ** (this.attempt - 1);
    const capped = Math.min(exp, this.maxMs);
    return Math.round(capped / 2 + this.random() * (capped / 2));
  }

  reset(): void {
    this.attempt = 0;
  }
}
