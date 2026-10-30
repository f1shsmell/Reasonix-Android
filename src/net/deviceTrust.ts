/**
 * Which computer a cloud device id belongs to.
 *
 * The account service names the Host's X25519 public key on every grant. That
 * is a new chance to substitute a key, so this phone remembers the first key a
 * person approved for each device and refuses a later one. The server's
 * membership answer and this local pin are two separate checks: one says the
 * account may reach the machine, the other says this is the machine it reached
 * last time.
 *
 * Only the first trust needs a person. After that, every open and every
 * reconnect verifies the key without asking; a changed key is refused rather
 * than silently accepted. Unpinning is the way to approve a reinstall.
 */

export interface TrustedDevice {
  id: string;
  /** The encoded key as the grant named it, kept for diagnostics. */
  publicKey: string;
  /** SHA-256 of the decoded key, in hex. The comparison uses this, not spelling. */
  fingerprint: string;
  /** Unix milliseconds of the first trust. */
  at: number;
}

export type TrustCode = "required" | "cancelled" | "changed" | "unreadable";

export interface TrustPrompt {
  id: string;
  /** Grouped hex, the part a person compares with the Host. */
  fingerprint: string;
}

export type ConfirmTrust = (prompt: TrustPrompt) => Promise<boolean>;

export type TrustResult =
  | { ok: true }
  | { ok: false; code: TrustCode; fingerprint?: string };

const KEY = "reasonix.devices.v1";
const LIMIT = 32;

function decode(publicKey: string): Uint8Array<ArrayBuffer> | null {
  const text = publicKey.trim().replaceAll("-", "+").replaceAll("_", "/");
  if (!text) return null;
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

function groups(hex: string): string {
  return hex.match(/.{1,4}/g)?.join(" ") ?? hex;
}

/** The full digest and the part worth showing; null when the key is not a key. */
export async function deviceFingerprint(
  publicKey: string,
): Promise<{ full: string; display: string } | null> {
  const bytes = decode(publicKey);
  if (bytes === null) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const full = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  // Eight groups is long enough to compare by eye and short enough for a phone.
  return { full, display: groups(full.slice(0, 32)) };
}

function isTrustedDevice(value: unknown): value is TrustedDevice {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id !== "" &&
    typeof row.publicKey === "string" &&
    row.publicKey !== "" &&
    typeof row.fingerprint === "string" &&
    row.fingerprint !== "" &&
    typeof row.at === "number"
  );
}

function read(): TrustedDevice[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: TrustedDevice[] = [];
    for (const entry of parsed) {
      if (!isTrustedDevice(entry)) continue;
      if (out.some((device) => device.id === entry.id)) continue;
      out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}

function write(devices: TrustedDevice[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(devices.slice(0, LIMIT)));
  } catch {
    // A blocked storage API means trust cannot be remembered; the caller
    // treats that as a refusal rather than pretending it landed.
  }
}

export function trustedDevice(id: string): TrustedDevice | null {
  return read().find((device) => device.id === id) ?? null;
}

export function trustedDevices(): TrustedDevice[] {
  return read();
}

export function pinDevice(device: { id: string; publicKey: string; fingerprint: string }): boolean {
  if (!device.id || !device.publicKey || !device.fingerprint) return false;
  const next = read().filter((row) => row.id !== device.id);
  next.unshift({
    id: device.id,
    publicKey: device.publicKey,
    fingerprint: device.fingerprint,
    at: Date.now(),
  });
  try {
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, LIMIT)));
    return true;
  } catch {
    return false;
  }
}

export function forgetDevice(id: string): void {
  write(read().filter((device) => device.id !== id));
}

/**
 * Verify one grant against the pin, asking only when there is no pin yet.
 *
 * A changed key never reaches `confirm`: a person cannot approve a substitution
 * by tapping through it, because the point of the pin is that this decision
 * already happened. To approve a reinstall, forget the device first.
 */
export async function checkDeviceTrust(
  device: { id: string; publicKey: string },
  confirm?: ConfirmTrust,
): Promise<TrustResult> {
  const fingerprint = await deviceFingerprint(device.publicKey);
  if (fingerprint === null) return { ok: false, code: "unreadable" };

  const pinned = trustedDevice(device.id);
  if (pinned !== null) {
    if (pinned.fingerprint !== fingerprint.full) {
      return { ok: false, code: "changed", fingerprint: fingerprint.display };
    }
    return { ok: true };
  }

  if (confirm === undefined) {
    return { ok: false, code: "required", fingerprint: fingerprint.display };
  }
  const accepted = await confirm({ id: device.id, fingerprint: fingerprint.display });
  if (!accepted) return { ok: false, code: "cancelled" };
  if (!pinDevice({ id: device.id, publicKey: device.publicKey, fingerprint: fingerprint.full })) {
    return { ok: false, code: "required", fingerprint: fingerprint.display };
  }
  return { ok: true };
}
