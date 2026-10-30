/**
 * What the home inbox remembers between polls.
 *
 * A decision carries no age and no read state; the kernel only says it is
 * still there. The phone is the one that watched it appear, so it keeps the
 * first sighting and whether the person has opened it. Both live in
 * localStorage: reopening the app should still say "waiting 12 minutes", not
 * "just now", and a decision answered on the desktop simply stops being read.
 */

const STORAGE_KEY = "reasonix.attention.v1";
/** A week is long enough to survive a weekend; older keys are noise. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A bound on a list that would otherwise grow with every prompt ever shown. */
const MAX_ENTRIES = 200;

interface Stored {
  firstSeen: Record<string, number>;
  seen: Record<string, number>;
}

export interface AttentionView {
  /** Unix milliseconds when this key was first reported to the phone. */
  firstSeenAt: number;
  /** The person has not opened the card since it appeared. */
  isNew: boolean;
}

export function decisionKey(runtimeId: string, decisionId: string): string {
  return `d:${runtimeId}:${decisionId}`;
}

export function runningKey(runtimeId: string): string {
  return `r:${runtimeId}`;
}

function empty(): Stored {
  return { firstSeen: {}, seen: {} };
}

function numericMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value === null || typeof value !== "object") return out;
  for (const [key, stamp] of Object.entries(value as Record<string, unknown>)) {
    if (key && typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0) {
      out[key] = stamp;
    }
  }
  return out;
}

function load(now: number): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const value = JSON.parse(raw) as Partial<Stored> | null;
    const out = {
      firstSeen: numericMap(value?.firstSeen),
      seen: numericMap(value?.seen),
    };
    return prune(out, now);
  } catch {
    return empty();
  }
}

function save(state: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private storage is a convenience here; the current screen still works.
  }
}

/** Drop expired keys, then keep the newest ones under the cap. */
function prune(state: Stored, now: number): Stored {
  const cutoff = now - TTL_MS;
  const trim = (map: Record<string, number>): Record<string, number> => {
    const fresh = Object.entries(map)
      .filter(([, stamp]) => stamp >= cutoff)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_ENTRIES);
    return Object.fromEntries(fresh);
  };
  return { firstSeen: trim(state.firstSeen), seen: trim(state.seen) };
}

export class Attention {
  private state: Stored;

  constructor(now = Date.now()) {
    this.state = load(now);
  }

  /** A decision's age and read state, creating the age on first sight. */
  decision(key: string, now = Date.now()): AttentionView {
    let firstSeenAt = this.state.firstSeen[key];
    if (firstSeenAt === undefined) {
      firstSeenAt = now;
      this.state.firstSeen[key] = now;
      save(this.state);
    }
    return { firstSeenAt, isNew: this.state.seen[key] === undefined };
  }

  /** A running turn only needs its first sighting. */
  running(key: string, now = Date.now()): number {
    const known = this.state.firstSeen[key];
    if (known !== undefined) return known;
    this.state.firstSeen[key] = now;
    save(this.state);
    return now;
  }

  /** The person opened the card; the new badge goes away for good. */
  markSeen(key: string, now = Date.now()): void {
    this.state.seen[key] = now;
    save(this.state);
  }
}
