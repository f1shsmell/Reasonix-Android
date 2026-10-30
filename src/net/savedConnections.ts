/**
 * The computers this phone has connected to.
 *
 * The proxy remembers one active upstream, and a pairing code buys exactly one
 * connection. Neither is a record of where this phone has been: once a cloud
 * link replaces the LAN origin, or the computer's share port changes, the
 * person is back to a QR code. This list is that record — newest first, LAN
 * and account links together — so reconnecting is a tap and recovery knows
 * which doors to try.
 *
 * It is a hint, never a credential. Pairing cookies and the account session
 * stay where they are (the proxy and its CookieManager); an entry here only
 * says "this target worked once".
 */

export type SavedConnectionKind = "lan" | "cloud";

export interface SavedConnection {
  kind: SavedConnectionKind;
  /** A LAN origin (no trailing slash) or an account device id. */
  target: string;
  /** What the row calls it: a host for LAN, a computer name for cloud. */
  name: string;
  /** Unix milliseconds of the last successful connect. */
  usedAt: number;
}

const KEY = "reasonix.connections.v1";

/** Enough to cover home, office and a couple of devices without becoming a log. */
const LIMIT = 8;

function isKind(value: unknown): value is SavedConnectionKind {
  return value === "lan" || value === "cloud";
}

/**
 * One spelling per target, so the same computer cannot occupy two rows.
 *
 * A LAN origin loses the slash a person may have typed; a cloud id is opaque
 * and only trimmed.
 */
export function normalizeTarget(kind: SavedConnectionKind, target: string): string {
  const trimmed = target.trim();
  if (!trimmed) return "";
  if (kind === "cloud") return trimmed;
  const withoutSlash = trimmed.replace(/\/+$/, "");
  try {
    const url = new URL(withoutSlash);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return withoutSlash;
  } catch {
    return "";
  }
}

/** The host part of a LAN origin, which is the name worth showing. */
export function originName(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

function read(): SavedConnection[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const rows: SavedConnection[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const kind = row.kind;
      if (!isKind(kind)) continue;
      const target = normalizeTarget(kind, typeof row.target === "string" ? row.target : "");
      if (!target) continue;
      const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : target;
      const usedAt = typeof row.usedAt === "number" && Number.isFinite(row.usedAt) ? row.usedAt : 0;
      if (rows.some((candidate) => candidate.kind === kind && candidate.target === target)) continue;
      rows.push({ kind, target, name, usedAt });
    }
    return rows.sort((a, b) => b.usedAt - a.usedAt).slice(0, LIMIT);
  } catch {
    return [];
  }
}

function write(rows: SavedConnection[]): SavedConnection[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    // A blocked storage API costs a re-scan, not a connection.
  }
  return rows;
}

export function loadConnections(): SavedConnection[] {
  return read();
}

/**
 * Record a successful connection, newest first.
 *
 * The same target moves to the front instead of appearing twice; a later name
 * (an account's computer name arriving after the id) replaces the old one.
 */
export function rememberConnection(
  kind: SavedConnectionKind,
  target: string,
  name?: string,
): SavedConnection[] {
  const normalized = normalizeTarget(kind, target);
  if (!normalized) return read();
  const label = name?.trim() || (kind === "lan" ? originName(normalized) : normalized);
  const next = read().filter((row) => !(row.kind === kind && row.target === normalized));
  next.unshift({ kind, target: normalized, name: label, usedAt: Date.now() });
  return write(next.slice(0, LIMIT));
}

export function forgetConnection(kind: SavedConnectionKind, target: string): SavedConnection[] {
  const normalized = normalizeTarget(kind, target);
  return write(read().filter((row) => !(row.kind === kind && row.target === normalized)));
}

/** Signing out makes every cloud row unusable; the LAN ones still are. */
export function forgetCloudConnections(): SavedConnection[] {
  return write(read().filter((row) => row.kind !== "cloud"));
}

/** The most recent target of one kind, or "" when none was recorded. */
export function latestConnection(kind: SavedConnectionKind): SavedConnection | null {
  return read().find((row) => row.kind === kind) ?? null;
}
