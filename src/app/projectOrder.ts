/**
 * Where a dragged project lands.
 *
 * The kernel knows one order — the list it remembers — and accepts a drop as
 * "put this root before that one", with `""` meaning the end. So a drop is
 * described in rows, not indices: the displayed list may hold rows the kernel
 * does not remember, and an index into it would name a position the kernel
 * cannot be told about.
 *
 * Pure, because the interesting cases are geometric and invisible: dropping a
 * row back where it was must not write, and an unremembered folder must not
 * be draggable at all.
 */

export interface OrderRow {
  root: string;
  remembered: boolean;
}

/**
 * The root a drop of `root` should precede, or null when there is nothing to
 * write: the row is not movable, or it already sits there.
 */
export function dropBefore(rows: OrderRow[], root: string, insertAt: number): string | null {
  const from = rows.findIndex((row) => row.root === root);
  const moving = rows[from];
  if (!moving?.remembered) return null;

  const at = Math.max(0, Math.min(insertAt, rows.length));
  let next = "";
  for (let index = at; index < rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (row.root !== root && row.remembered) {
      next = row.root;
      break;
    }
  }

  let current = "";
  for (let index = from + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.remembered) {
      current = row.root;
      break;
    }
  }
  return next === current ? null : next;
}

/**
 * The gap under a finger: the index of the first row whose middle is below
 * `y`, or the end of the list. `bounds` are in display order.
 */
export function insertAt(bounds: { top: number; bottom: number }[], y: number): number {
  for (let index = 0; index < bounds.length; index += 1) {
    const box = bounds[index];
    if (box === undefined) continue;
    if (y < box.top + (box.bottom - box.top) / 2) return index;
  }
  return bounds.length;
}
