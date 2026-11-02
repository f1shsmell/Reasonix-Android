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
  /**
   * The computer this door reaches, when the far side named itself.
   *
   * A LAN origin gets it from the paired-device route (`GET /device`), and a
   * cloud row from the account's device list. Both are the machine's host
   * name, which is what lets two doors be recognised as one computer instead
   * of two rows in the list.
   */
  machine?: string;
  /** Unix milliseconds of the last successful connect. */
  usedAt: number;
  /**
   * Where this row sits in the order the app tries its doors.
   *
   * Explicit rather than "newest first" because the order is a decision: a
   * phone that lost its Wi-Fi should walk the person's own list — home, then
   * office, then the account — instead of spending its attempts on whichever
   * computer happened to be used most recently. Rows written before this
   * existed are migrated once, from `usedAt`, so an upgrade keeps a sensible
   * order instead of inventing one.
   */
  order: number;
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
      const machine =
        typeof row.machine === "string" && row.machine.trim() ? row.machine.trim() : undefined;
      const usedAt = typeof row.usedAt === "number" && Number.isFinite(row.usedAt) ? row.usedAt : 0;
      // `order` arrived after the first releases. A row without one is placed
      // by recency below, which is exactly what this list meant before it.
      const order =
        typeof row.order === "number" && Number.isFinite(row.order) ? row.order : null;
      if (rows.some((candidate) => candidate.kind === kind && candidate.target === target)) continue;
      rows.push({
        kind,
        target,
        name,
        ...(machine ? { machine } : {}),
        usedAt,
        order: order ?? Number.POSITIVE_INFINITY,
      });
    }
    // Rows that carry an explicit order come first, in it; the ones an older
    // build wrote follow by recency, so an upgrade keeps its old list. `order`
    // is then renumbered densely, which is what the drop handler writes back.
    return rows
      .sort((a, b) => {
        if (a.order !== b.order) return a.order - b.order;
        return b.usedAt - a.usedAt;
      })
      .slice(0, LIMIT)
      .map((row, index) => ({ ...row, order: index }));
  } catch {
    return [];
  }
}

/** Store rows and hand back the normalised list the caller should draw. */
function write(rows: SavedConnection[]): SavedConnection[] {
  const next = rows.map((row, index) => ({ ...row, order: index }));
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A blocked storage API costs a re-scan, not a connection.
  }
  return next;
}

export function loadConnections(): SavedConnection[] {
  return read();
}

/** A row's identity: what a reorder moves, and what a saved list keys on. */
export function connectionKey(kind: SavedConnectionKind, target: string): string {
  return `${kind}:${normalizeTarget(kind, target) || target.trim()}`;
}

/**
 * The list with one row moved to `index`, the way a drop describes it.
 *
 * `index` is a slot in the *current* list — the same number `insertAt` answers
 * — so moving a row down by one has to land before the row it passed rather
 * than after it. A drop that changes nothing answers the same array, which is
 * what keeps a settled drag from writing storage.
 */
export function reorderConnections(
  rows: SavedConnection[],
  key: string,
  index: number,
): SavedConnection[] {
  const from = rows.findIndex((row) => connectionKey(row.kind, row.target) === key);
  if (from < 0) return rows;
  const clamped = Math.max(0, Math.min(index, rows.length));
  const at = from < clamped ? clamped - 1 : clamped;
  if (at === from) return rows;
  const next = [...rows];
  const [moving] = next.splice(from, 1);
  if (!moving) return rows;
  next.splice(at, 0, moving);
  return next.map((row, position) => ({ ...row, order: position }));
}

/** Move one saved row and keep the new order. */
export function moveConnection(key: string, index: number): SavedConnection[] {
  const rows = read();
  const next = reorderConnections(rows, key, index);
  return next === rows ? rows : write(next);
}

/**
 * Record a successful connection.
 *
 * A target already in the list keeps its place: the order is the person's, and
 * reconnecting to a computer must not quietly move it. A new target joins at
 * the end, where the next drop can put it, instead of jumping the queue of a
 * list someone arranged on purpose. Only the name and the time are refreshed.
 */
export function rememberConnection(
  kind: SavedConnectionKind,
  target: string,
  name?: string,
  machine?: string,
): SavedConnection[] {
  const normalized = normalizeTarget(kind, target);
  if (!normalized) return read();
  const label = name?.trim() || (kind === "lan" ? originName(normalized) : normalized);
  const identity = machine?.trim() || undefined;
  const rows = read();
  const existing = rows.find((row) => row.kind === kind && row.target === normalized);
  if (existing) {
    return write(
      rows.map((row) =>
        row === existing
          ? {
              ...row,
              name: label,
              ...(identity ? { machine: identity } : {}),
              usedAt: Date.now(),
            }
          : row,
      ),
    );
  }
  // A full list drops its last row rather than refusing the computer just
  // reached; the person can reorder or forget to make room deliberately.
  const kept = rows.length >= LIMIT ? rows.slice(0, LIMIT - 1) : rows;
  return write([
    ...kept,
    {
      kind,
      target: normalized,
      name: label,
      ...(identity ? { machine: identity } : {}),
      usedAt: Date.now(),
      order: kept.length,
    },
  ]);
}

/**
 * Record the machine a saved door reaches.
 *
 * A door is saved before the far side has answered with its name, so the
 * identity arrives a moment later. Nothing changes when the answer is empty
 * or already stored, which keeps a reconnect from spending a write.
 */
export function learnConnectionMachine(
  kind: SavedConnectionKind,
  target: string,
  machine: string,
): SavedConnection[] {
  const normalized = normalizeTarget(kind, target);
  const identity = machine.trim();
  if (!normalized || !identity) return read();
  const rows = read();
  const existing = rows.find((row) => row.kind === kind && row.target === normalized);
  if (!existing || existing.machine === identity) return rows;
  return write(
    rows.map((row) => (row === existing ? { ...row, machine: identity } : row)),
  );
}

/** One spelling per machine name, for comparing two doors. */
export function machineKey(machine: string | undefined): string {
  return (machine ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface ConnectionGroup {
  /** Stable across a rebuild: the machine when known, else the one door. */
  key: string;
  /** The computer's name, or "" for a door that has not named itself. */
  machine: string;
  /** Every door to that computer, in the list's order. */
  rows: SavedConnection[];
}

/**
 * The saved list grouped by computer.
 *
 * A LAN origin and a cloud device that name the same machine are one row in
 * the list, because they are one computer: two rows would ask the person to
 * choose between a door they walked through and the same door by another
 * route. A door that has not named itself keeps its own row.
 */
export function groupConnections(rows: SavedConnection[]): ConnectionGroup[] {
  const groups: ConnectionGroup[] = [];
  const seen = new Map<string, ConnectionGroup>();
  for (const row of rows) {
    const key = connectionGroupKey(row);
    const found = seen.get(key);
    if (found) {
      found.rows.push(row);
      continue;
    }
    const group: ConnectionGroup = {
      key,
      machine: row.machine?.trim() ?? "",
      rows: [row],
    };
    seen.set(key, group);
    groups.push(group);
  }
  return groups;
}

/** The row's group identity: one computer, or one named door. */
export function connectionGroupKey(row: SavedConnection): string {
  const machine = row.machine?.trim() ?? "";
  return machine ? `machine:${machineKey(machine)}` : connectionKey(row.kind, row.target);
}

/** Remove one computer and every door that reaches it. */
export function forgetConnectionGroup(key: string): SavedConnection[] {
  const rows = read();
  const next = rows.filter((row) => connectionGroupKey(row) !== key);
  return next.length === rows.length ? rows : write(next);
}

/** Move one computer (all of its doors) to `index`, the way a drop asks. */
export function moveConnectionGroup(key: string, index: number): SavedConnection[] {
  const rows = read();
  const groups = groupConnections(rows);
  const from = groups.findIndex((group) => group.key === key);
  if (from < 0) return rows;
  const clamped = Math.max(0, Math.min(index, groups.length));
  const at = from < clamped ? clamped - 1 : clamped;
  if (at === from) return rows;
  const [moving] = groups.splice(from, 1);
  if (!moving) return rows;
  groups.splice(at, 0, moving);
  return write(groups.flatMap((group) => group.rows));
}

/**
 * The LAN door to `machine` that this phone can reach without a tunnel.
 *
 * This is the upgrade an active cloud link looks for: the same computer,
 * named by both doors, and an address the proxy says is a neighbour. A door
 * with no direct answer is not a candidate — pinning the socket to Wi-Fi for
 * an address that is not there is how a working link gets dropped.
 */
export function directDoorForMachine(
  rows: SavedConnection[],
  machine: string,
  direct: string[],
): SavedConnection | null {
  const key = machineKey(machine);
  if (!key) return null;
  const reachable = new Set(
    direct.map((target) => normalizeTarget("lan", target)).filter(Boolean),
  );
  return (
    rows.find(
      (row) =>
        row.kind === "lan" &&
        machineKey(row.machine) === key &&
        reachable.has(row.target),
    ) ?? null
  );
}

export function forgetConnection(kind: SavedConnectionKind, target: string): SavedConnection[] {
  const normalized = normalizeTarget(kind, target);
  return write(read().filter((row) => !(row.kind === kind && row.target === normalized)));
}

/** Signing out makes every cloud row unusable; the LAN ones still are. */
export function forgetCloudConnections(): SavedConnection[] {
  return write(read().filter((row) => row.kind !== "cloud"));
}

/**
 * The target of one kind that was connected most recently.
 *
 * Recency, not list position: this is the "last computer this phone used"
 * hint, which a reorder must not change.
 */
export function latestConnection(kind: SavedConnectionKind): SavedConnection | null {
  const rows = read().filter((row) => row.kind === kind);
  let best: SavedConnection | null = null;
  for (const row of rows) {
    if (best === null || row.usedAt > best.usedAt) best = row;
  }
  return best;
}
