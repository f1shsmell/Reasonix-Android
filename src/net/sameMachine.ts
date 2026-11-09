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
 * cloud door carries the account's device name — the `name` fallback for
 * cloud rows written before the identity field existed.
 *
 * Absence is a refusal, never a guess: "unknown" and "different" call for
 * different answers, because only one of them says another computer answers
 * there. Two machines can share a host name, and a wrong switch costs more
 * than a link that stays down.
 */

import { normalizeTarget } from "./savedConnections";
import type { SavedConnection, SavedConnectionKind } from "./savedConnections";

export interface DoorRef {
  kind: SavedConnectionKind;
  target: string;
}

/** What the saved list can say about two doors, never more. */
export type MachineRelation = "same" | "different" | "unknown";

/**
 * The identity a saved row carries, or "" when the row has not learned one.
 *
 * A LAN row is named by its address, which says nothing about the computer;
 * only a cloud row is named by the account's device list.
 */
function identityOf(rows: SavedConnection[], door: DoorRef): string {
  const target = normalizeTarget(door.kind, door.target);
  const row = rows.find(
    (candidate) =>
      candidate.kind === door.kind &&
      normalizeTarget(candidate.kind, candidate.target) === target,
  );
  if (!row) return "";
  const learned = (row.machine ?? "").trim();
  if (learned) return learned;
  if (door.kind !== "cloud") return "";
  // A cloud row with no name of its own is labelled by its device id, which
  // says nothing about the computer; only the account's name does.
  const named = (row.name ?? "").trim();
  return named && named !== target ? named : "";
}

/** One spelling per machine, matching `machineKey`'s own normalisation. */
function fold(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Whether two doors are proven to reach the same computer, another one, or
 * cannot be told apart from what the saved list knows.
 */
export function machineRelation(
  rows: SavedConnection[],
  a: DoorRef,
  b: DoorRef,
): MachineRelation {
  const left = identityOf(rows, a);
  const right = identityOf(rows, b);
  if (!left || !right) return "unknown";
  return fold(left) === fold(right) ? "same" : "different";
}
