/**
 * Reordering a list by holding a row and dragging it.
 *
 * The dragged row lifts into a fixed ghost that follows the finger, while the
 * rows between its old and new slots move aside. A press that moves before the
 * hold expires is a scroll and cancels the drag.
 *
 * The hook knows nothing about what it is ordering: a row is a key, and a drop
 * is a slot index. The project list turns that into the kernel's "put this
 * before that" write; the connection list turns it into a stored rank.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { insertAt } from "./projectOrder";

/** How long a row rests before it is picked up. */
export const DRAG_HOLD_MS = 400;

/** How far a finger may drift before the press is a scroll. */
const SLOP_PX = 10;

/** How close to the edge of the list a drag starts scrolling it. */
const EDGE_PX = 56;

/** Pixels per frame at the edge; low enough to land on a row. */
const EDGE_SPEED = 6;

/** The drop animation's length; the preview stays this long before settling. */
const DROP_MS = 180;

/** The attribute a row carries so the hook can find it and measure it. */
export const DRAG_KEY_ATTRIBUTE = "data-drag-key";

export interface RowDragState {
  key: string;
  from: number;
  insertAt: number;
  /** The lifted row's height, used to shift its neighbours. */
  height: number;
}

export interface RowDragHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

/** One row the hook may pick up. */
export interface DragRow {
  key: string;
  /** A row that is shown but must not move (a folder the kernel does not own). */
  movable: boolean;
}

export interface RowDrag<T extends HTMLElement = HTMLElement> {
  state: RowDragState | null;
  listRef: RefObject<T | null>;
  /** Props for one row; the row's own tap still opens it. */
  row: (key: string) => RowDragHandlers;
  /** Set while a drag is in progress, so a page swipe leaves it alone. */
  swallowSwipe: RefObject<boolean>;
}

interface Bounds {
  top: number;
  bottom: number;
}

interface Live {
  key: string;
  node: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  y: number;
  from: number;
  height: number;
  /** Row boxes relative to the list, captured before any shift. */
  bounds: Bounds[];
  insertAt: number;
  startTop: number;
  armed: boolean;
  dropping: boolean;
  timer: number | null;
  release: (() => void) | null;
  ghost: HTMLElement | null;
}

export interface RowDragOptions {
  rows: DragRow[];
  enabled: boolean;
  /**
   * The row landed in slot `index` of the list as it was drawn.
   *
   * Called once per completed drop, after the ghost has settled; the caller
   * owns the write and the re-read.
   */
  place: (key: string, index: number) => void;
  /** The element that scrolls the list, for edge auto-scroll. */
  scrollerSelector?: string;
  /**
   * The caller's swipe-suppression flag, when more than one drag shares a
   * gesture owner.
   *
   * A sheet rendered inside a page that also swipes would otherwise need to
   * copy the flag out of this hook on every render, and would still lose the
   * race: `pointerup` sets it and the page's `touchend` reads it a frame
   * later. Handing the ref in lets both see the same boolean.
   */
  swallowSwipe?: RefObject<boolean>;
}

/** How far a row moves aside to open the gap under the finger. */
export function dragShift(state: RowDragState | null, index: number): number {
  if (state === null || index === state.from) return 0;
  if (state.from < state.insertAt && index > state.from && index < state.insertAt) {
    return -state.height;
  }
  if (state.insertAt < state.from && index >= state.insertAt && index < state.from) {
    return state.height;
  }
  return 0;
}

/** Which row carries the line showing where the dragged row would land. */
export function dropEdge(
  state: RowDragState | null,
  index: number,
  count: number,
): "before" | "after" | undefined {
  if (state === null) return undefined;
  if (state.insertAt === index) return "before";
  if (state.insertAt >= count && index === count - 1) return "after";
  return undefined;
}

/** Move the lifted row without re-rendering the list on every frame. */
function placeGhost(current: Live, offsetY: number): void {
  if (current.ghost) {
    current.ghost.style.transform = `translate3d(0, ${offsetY}px, 0) scale(1.02)`;
  }
}

function rowNodes(list: HTMLElement | null): HTMLElement[] {
  if (!list) return [];
  return Array.from(list.querySelectorAll<HTMLElement>(`[${DRAG_KEY_ATTRIBUTE}]`));
}

/** The viewport top of the gap the row would land in. */
function gapTop(current: Live, list: HTMLElement | null): number {
  if (!list) return current.startTop;
  const boxes = rowNodes(list).map((node) => node.getBoundingClientRect());
  if (current.insertAt >= boxes.length) {
    return boxes[boxes.length - 1]?.bottom ?? current.startTop;
  }
  const target = boxes[current.insertAt];
  if (!target) return current.startTop;
  if (current.insertAt === current.from) return target.top;
  return target.top - current.height;
}

export function useRowDrag<T extends HTMLElement = HTMLElement>({
  rows,
  enabled,
  place,
  scrollerSelector = ".body",
  swallowSwipe: sharedSwipe,
}: RowDragOptions): RowDrag<T> {
  const listRef = useRef<T | null>(null);
  const live = useRef<Live | null>(null);
  const swallowClick = useRef(false);
  const ownSwipe = useRef(false);
  const swallowSwipe = sharedSwipe ?? ownSwipe;
  const [state, setState] = useState<RowDragState | null>(null);

  const measure = useCallback((current: Live, y: number): number => {
    const list = listRef.current;
    if (!list) return 0;
    return insertAt(current.bounds, y - list.getBoundingClientRect().top);
  }, []);

  const settle = useCallback(() => {
    const current = live.current;
    live.current = null;
    if (current?.timer !== null && current?.timer !== undefined) window.clearTimeout(current.timer);
    current?.release?.();
    try {
      if (current?.node.hasPointerCapture?.(current.pointerId)) {
        current.node.releasePointerCapture(current.pointerId);
      }
    } catch {
      // The pointer is already gone; nothing is held.
    }
    if (current?.ghost?.parentNode) current.ghost.parentNode.removeChild(current.ghost);
    listRef.current?.removeAttribute("data-dragging");
    // `swallowSwipe` is deliberately left set: a touch drag ends with a
    // `touchend` after this `pointerup`, and clearing the flag here would let
    // that release be read as a sideways swipe between the home views. The
    // consumer clears it when it eats the gesture, and a fresh `touchstart`
    // clears it anyway, so a mouse drag cannot leave it stuck.
    setState(null);
  }, []);

  useEffect(() => settle, [settle]);

  /** Follow the finger: lift the ghost, then move the gap to the row under it. */
  const track = useCallback(
    (current: Live, x: number, y: number) => {
      if (current.dropping) return;
      current.y = y;
      if (!current.armed) {
        if (Math.hypot(x - current.startX, y - current.startY) > SLOP_PX) settle();
        return;
      }
      placeGhost(current, y - current.startY);
      const at = measure(current, y);
      if (at === current.insertAt) return;
      current.insertAt = at;
      setState({
        key: current.key,
        from: current.from,
        insertAt: at,
        height: current.height,
      });
    },
    [measure, settle],
  );

  /** A released finger: drop into the gap, or settle back where the row was. */
  const finish = useCallback(
    (current: Live) => {
      if (current.dropping) return;
      const armed = current.armed;
      const at = current.insertAt;
      // A slot equal to the row's own, or the one just after it, describes
      // the position it already occupies: nothing moved, so nothing is
      // written and the ghost settles straight away instead of playing a
      // drop animation that would land back on the same row.
      const unchanged = at === current.from || at === current.from + 1;
      if (!armed || unchanged) {
        settle();
        return;
      }
      swallowClick.current = true;
      current.dropping = true;
      current.release?.();
      current.release = null;
      const ghost = current.ghost;
      if (ghost) {
        ghost.style.transition = `transform ${DROP_MS}ms var(--ease-out), opacity ${DROP_MS}ms var(--ease-out)`;
        ghost.style.transform = `translate3d(0, ${gapTop(current, listRef.current) - current.startTop}px, 0) scale(1)`;
        ghost.style.opacity = "0.82";
      }
      if (typeof navigator.vibrate === "function") navigator.vibrate(8);
      place(current.key, at);
      window.setTimeout(() => {
        if (live.current === current) settle();
      }, DROP_MS);
    },
    [place, settle],
  );

  const arm = useCallback(
    (current: Live) => {
      const list = listRef.current;
      if (!list) {
        settle();
        return;
      }
      const nodes = rowNodes(list);
      const from = nodes.indexOf(current.node);
      const rect = current.node.getBoundingClientRect();
      if (from < 0) {
        settle();
        return;
      }
      const listRect = list.getBoundingClientRect();
      current.from = from;
      current.height = rect.height;
      current.bounds = nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top - listRect.top, bottom: box.bottom - listRect.top };
      });
      current.startTop = rect.top;
      current.insertAt = insertAt(current.bounds, current.startY - listRect.top);
      current.armed = true;
      swallowSwipe.current = true;
      try {
        current.node.setPointerCapture?.(current.pointerId);
      } catch {
        // A synthetic or already-released pointer cannot be captured.
      }
      // The guard that keeps the browser from turning this gesture into a pan
      // was registered on pointerdown, before any move could arrive. This is
      // belt and braces for a browser that reads touch-action again late.
      current.node.style.touchAction = "none";

      const ghost = current.node.cloneNode(true) as HTMLElement;
      ghost.classList.remove("dragging");
      ghost.removeAttribute(DRAG_KEY_ATTRIBUTE);
      ghost.removeAttribute("data-drop");
      ghost.setAttribute("aria-hidden", "true");
      ghost.classList.add("drag-ghost");
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      ghost.querySelectorAll("button").forEach((button) => {
        button.tabIndex = -1;
        button.setAttribute("aria-hidden", "true");
      });
      document.body.appendChild(ghost);
      current.ghost = ghost;
      list.setAttribute("data-dragging", "true");
      placeGhost(current, 0);
      if (typeof navigator.vibrate === "function") navigator.vibrate(10);
      setState({ key: current.key, from, insertAt: current.insertAt, height: rect.height });
    },
    [settle],
  );

  const row = useCallback(
    (key: string): RowDragHandlers => ({
      onPointerDown: (event) => {
        if (!enabled) return;
        if (live.current) {
          // A live captured pointer keeps the gesture: a second finger does
          // not steal it. Without capture — because the release was lost, the
          // node was replaced, or this browser never captured — the entry is
          // stale, and leaving it would block every later long press. Settle
          // it and start this gesture fresh.
          const held = live.current.node.hasPointerCapture?.(live.current.pointerId) === true;
          if (held && live.current.pointerId !== event.pointerId) return;
          settle();
        }
        if (!rows.find((candidate) => candidate.key === key)?.movable) return;
        swallowClick.current = false;
        const current: Live = {
          key,
          node: event.currentTarget,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          y: event.clientY,
          from: -1,
          height: 0,
          bounds: [],
          insertAt: 0,
          startTop: 0,
          armed: false,
          dropping: false,
          timer: null,
          release: null,
          ghost: null,
        };
        live.current = current;

        const node = current.node;
        const claimed = node.style.touchAction;
        const scroller = node.closest<HTMLElement>(scrollerSelector);
        // The guard is registered now, not when the hold succeeds: the first
        // touchmove after the hold can arrive before a timer callback would
        // have added it, and that one move is enough for the browser to take
        // the gesture as a pan and cancel the drag.
        const guard = (touch: TouchEvent) => {
          if (
            live.current === current &&
            current.armed &&
            !current.dropping &&
            touch.cancelable
          ) {
            touch.preventDefault();
          }
        };
        scroller?.addEventListener("touchmove", guard, { passive: false });

        // Pointer capture usually keeps move/up on the row, but Android can
        // retarget a release or drop the capture when a refresh replaces a
        // node. Window listeners end the gesture even then; the stuck `live`
        // entry was what made the next long press do nothing.
        const onMove = (move: PointerEvent) => {
          if (move.pointerId !== current.pointerId || live.current !== current) return;
          track(current, move.clientX, move.clientY);
        };
        const onUp = (up: PointerEvent) => {
          if (up.pointerId !== current.pointerId || live.current !== current) return;
          finish(current);
        };
        const onCancel = (cancel: PointerEvent) => {
          if (cancel.pointerId !== current.pointerId || live.current !== current) return;
          settle();
        };
        const onBlur = () => {
          if (live.current === current) settle();
        };
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
        window.addEventListener("pointercancel", onCancel, true);
        window.addEventListener("blur", onBlur);
        current.release = () => {
          scroller?.removeEventListener("touchmove", guard);
          window.removeEventListener("pointermove", onMove, true);
          window.removeEventListener("pointerup", onUp, true);
          window.removeEventListener("pointercancel", onCancel, true);
          window.removeEventListener("blur", onBlur);
          node.style.touchAction = claimed;
        };
        current.timer = window.setTimeout(() => {
          if (live.current === current) arm(current);
        }, DRAG_HOLD_MS);
      },
      onPointerMove: (event) => {
        const current = live.current;
        if (!current || current.key !== key || event.pointerId !== current.pointerId) return;
        track(current, event.clientX, event.clientY);
      },
      onPointerUp: (event) => {
        const current = live.current;
        if (!current || current.key !== key || event.pointerId !== current.pointerId) return;
        finish(current);
      },
      onPointerCancel: () => {
        if (live.current?.key === key) settle();
      },
      onContextMenu: (event) => {
        event.preventDefault();
      },
      onClickCapture: (event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.stopPropagation();
        event.preventDefault();
      },
    }),
    [arm, enabled, finish, rows, scrollerSelector, settle, track],
  );

  const dragging = state !== null;
  useEffect(() => {
    if (!dragging) return;
    if (typeof requestAnimationFrame !== "function") return;
    const scroller = listRef.current?.closest<HTMLElement>(scrollerSelector);
    if (!scroller) return;
    let frame = 0;
    const tick = () => {
      const current = live.current;
      if (current?.armed && !current.dropping) {
        const box = scroller.getBoundingClientRect();
        const top = box.top + EDGE_PX;
        const bottom = box.bottom - EDGE_PX;
        const push = current.y < top ? -(top - current.y) : current.y > bottom ? current.y - bottom : 0;
        if (push !== 0) {
          const was = scroller.scrollTop;
          scroller.scrollTop = was + Math.max(-EDGE_SPEED, Math.min(EDGE_SPEED, push));
          if (scroller.scrollTop !== was) {
            const at = measure(current, current.y);
            if (at !== current.insertAt) {
              current.insertAt = at;
              setState({ key: current.key, from: current.from, insertAt: at, height: current.height });
            }
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging, measure, scrollerSelector]);

  return { state, listRef, row, swallowSwipe };
}
