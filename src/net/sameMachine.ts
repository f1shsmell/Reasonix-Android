/**
 * Whether two doors lead to the same computer.
 *
 * A handover swaps the transport under a conversation, and a runtime id only
 * means something on the kernel that minted it. Moving to another computer
 * would silently replace the project, the panes and the transcript, so an
 * automatic switch is allowed only when both doors carry the same machine
 * identity.
 *
 * Identity comes from the saved list, which is the one place both doors meet:
 * a LAN door learns the computer's own name (`readMachineIdentity`), and a
 * cloud door carries the account's device name. `name` is the fallback for
 * rows written before the identity field existed — the same fallback
 * `preferLan` already uses.
 *
 * Absence is a refusal, never a guess. Two machines can share a host name,
 * and a wrong switch costs more than a link that stays down.
 */

import { normalizeTarget } from "./savedConnections";
import type { SavedConnection, SavedConnectionKind } from "./savedConnections";

export interface DoorRef {
  kind: SavedConnectionKind;
  target: string;
}

/** The identity a saved row carries, preferring the machine over its label. */
function identityOf(rows: SavedConnection[], door: DoorRef): string {
  const target = normalizeTarget(door.kind, door.target);
  const row = rows.find(
    (candidate) =>
      candidate.kind === door.kind &&
      normalizeTarget(candidate.kind, candidate.target) === target,
  );
  if (!row) return "";
  return (row.machine ?? "").trim() || (row.name ?? "").trim();
}

/** One spelling per machine, matching `machineKey`'s own normalisation. */
function fold(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True only when both doors are recorded and name the same computer.
 *
 * A door the saved list has never seen is not evidence of anything: the app
 * cannot prove the switch is safe, so it declines.
 */
export function sameMachine(rows: SavedConnection[], a: DoorRef, b: DoorRef): boolean {
  const left = identityOf(rows, a);
  const right = identityOf(rows, b);
  if (!left || !right) return false;
  return fold(left) === fold(right);
}
