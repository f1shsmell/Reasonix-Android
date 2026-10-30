/**
 * Read-only facts about the computer the phone is attached to.
 *
 * Usage, window, tool boundary and version are decisions the desktop owns.
 * The phone can explain them — "why did it refuse that write", "how much is
 * left" — but nothing here writes: a machine-wide switch belongs where the
 * machine is. Each read is independent; one route this kernel does not have
 * must not hide the others.
 */

import { fetchWithTimeout } from "./http";

export interface MachineUsage {
  tokens: number;
  requests: number;
  turns: number;
  cost: string[];
  topModel: string;
}

export interface MachineContext {
  used: number;
  window: number;
  compactAt: number;
  boundary: string;
}

export interface MachineTools {
  total: number;
  disabled: string[];
}

export interface MachineBoundary {
  mode: string;
  allow: number;
  ask: number;
  deny: number;
}

export interface MachineVersion {
  current: string;
  latest: string;
  newer: boolean;
}

export interface MachineSnapshot {
  usage: MachineUsage | null;
  context: MachineContext | null;
  tools: MachineTools | null;
  boundary: MachineBoundary | null;
  version: MachineVersion | null;
}

async function read<T>(path: string): Promise<T | null> {
  try {
    const response = await fetchWithTimeout(path, { credentials: "same-origin" }, 12_000);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function money(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const amount = typeof row.amount === "string" ? row.amount : "";
    const currency = typeof row.currency === "string" ? row.currency : "";
    return amount ? [`${currency} ${amount}`.trim()] : [];
  });
}

/** Read everything the panel can show; a failed read is a missing section. */
export async function loadMachine(base = ""): Promise<MachineSnapshot> {
  const [usage, context, tools, boundary, version] = await Promise.all([
    read<Record<string, unknown>>(`${base}/usage?days=30`),
    read<Record<string, unknown>>(`${base}/context`),
    read<Record<string, unknown>>(`${base}/tools`),
    read<Record<string, unknown>>(`${base}/permissions`),
    read<Record<string, unknown>>(`${base}/studio/versions`),
  ]);

  return {
    usage: usage
      ? {
          tokens: typeof usage.tokens === "number" ? usage.tokens : 0,
          requests: typeof usage.requests === "number" ? usage.requests : 0,
          turns: typeof usage.turns === "number" ? usage.turns : 0,
          cost: money(usage.cost),
          topModel: typeof usage.top_model === "string" ? usage.top_model : "",
        }
      : null,
    context: context
      ? {
          used: typeof context.used === "number" ? context.used : 0,
          window: typeof context.window === "number" ? context.window : 0,
          compactAt: typeof context.compact_at === "number" ? context.compact_at : 0,
          boundary: typeof context.boundary === "string" ? context.boundary : "",
        }
      : null,
    tools: tools
      ? {
          total: list(tools.tools).length,
          disabled: list(tools.tools).flatMap((entry) => {
            if (entry === null || typeof entry !== "object") return [];
            const row = entry as Record<string, unknown>;
            return row.disabled === true && typeof row.name === "string" ? [row.name] : [];
          }),
        }
      : null,
    boundary: boundary
      ? {
          mode: typeof boundary.mode === "string" ? boundary.mode : "",
          allow: list(boundary.allow).length,
          ask: list(boundary.ask).length,
          deny: list(boundary.deny).length,
        }
      : null,
    version: version
      ? {
          current: typeof version.current === "string" ? version.current : "",
          latest: typeof version.latest === "string" ? version.latest : "",
          newer: version.newer === true,
        }
      : null,
  };
}

export function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}
