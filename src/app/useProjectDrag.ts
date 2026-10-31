/**
 * Reordering the project list by holding a row and dragging it.
 *
 * The dragged row lifts into a fixed ghost that follows the finger, while the
 * rows between its old and new slots move aside. The drop is still a preview:
 * the kernel owns the order, and the caller re-reads after the write. A press
 * that moves before the hold expires is a scroll and cancels the drag.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { dropBefore, insertAt, type OrderRow } from "./projectOrder";

/** How long a project row rests before it is picked up. */
export const DRAG_HOLD_MS = 400;

/** How far a finger may drift before the press is a scroll. */
const SLOP_PX = 10;

/** How close to the edge of the list a drag starts scrolling it. */
const EDGE_PX = 56;

/** Pixels per frame at the edge; low enough to land on a row. */
const EDGE_SPEED = 6;

/** The drop animation's length; the preview stays this long before settling. */
const DROP_MS = 180;

export interface ProjectDragState {
  root: string;
  from: number;
  insertAt: number;
  /** The lifted row's height, used to shift its neighbours. */
  height: number;
}

export interface ProjectDragHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

interface Bounds {
  top: number;
  bottom: number;
}

interface Live {
  root: string;
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

export interface ProjectDrag {
  state: ProjectDragState | null;
  listRef: RefObject<HTMLUListElement | null>;
  /** Props for one project row; the row's own tap still opens it. */
  row: (root: string) => ProjectDragHandlers;
  /** Set while a drag is in progress, so the tab swipe leaves it alone. */
  swallowSwipe: RefObject<boolean>;
}

/** Move the lifted row without re-rendering the list on every frame. */
function placeGhost(current: Live, offsetY: number): void {
  if (current.ghost) {
    current.ghost.style.transform = `translate3d(0, ${offsetY}px, 0) scale(1.02)`;
  }
}

/** The viewport top of the gap the row would land in. */
function gapTop(current: Live, list: HTMLUListElement | null): number {
  if (!list) return current.startTop;
  const nodes = Array.from(list.querySelectorAll<HTMLElement>("[data-project-root]"));
  const boxes = nodes.map((node) => node.getBoundingClientRect());
  if (current.insertAt >= boxes.length) {
    return boxes[boxes.length - 1]?.bottom ?? current.startTop;
  }
  const target = boxes[current.insertAt];
  if (!target) return current.startTop;
  if (current.insertAt === current.from) return target.top;
  return target.top - current.height;
}

export function useProjectDrag(
  rows: OrderRow[],
  enabled: boolean,
  place: (root: string, before: string) => void,
): ProjectDrag {
  const listRef = useRef<HTMLUListElement | null>(null);
  const live = useRef<Live | null>(null);
  const swallowClick = useRef(false);
  const swallowSwipe = useRef(false);
  const [state, setState] = useState<ProjectDragState | null>(null);

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
    swallowSwipe.current = false;
    setState(null);
  }, []);

  useEffect(() => settle, [settle]);

  const arm = useCallback(
    (current: Live) => {
      const list = listRef.current;
      if (!list) {
        settle();
        return;
      }
      const nodes = Array.from(list.querySelectorAll<HTMLElement>("[data-project-root]"));
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
      const scroller = list.closest<HTMLElement>(".body");
      if (scroller) {
        const prevent = (event: TouchEvent) => {
          if (event.cancelable) event.preventDefault();
        };
        scroller.addEventListener("touchmove", prevent, { passive: false });
        current.release = () => scroller.removeEventListener("touchmove", prevent);
      }

      const ghost = current.node.cloneNode(true) as HTMLElement;
      ghost.classList.remove("dragging");
      ghost.removeAttribute("data-project-root");
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
      setState({ root: current.root, from, insertAt: current.insertAt, height: rect.height });
    },
    [settle],
  );

  const row = useCallback(
    (root: string): ProjectDragHandlers => ({
      onPointerDown: (event) => {
        if (!enabled || live.current) return;
        if (!rows.find((candidate) => candidate.root === root)?.remembered) return;
        swallowClick.current = false;
        const current: Live = {
          root,
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
        current.timer = window.setTimeout(() => {
          if (live.current === current) arm(current);
        }, DRAG_HOLD_MS);
      },
      onPointerMove: (event) => {
        const current = live.current;
        if (!current || current.root !== root || event.pointerId !== current.pointerId) return;
        current.y = event.clientY;
        if (current.dropping) return;
        if (!current.armed) {
          if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > SLOP_PX) {
            settle();
          }
          return;
        }
        placeGhost(current, event.clientY - current.startY);
        const at = measure(current, event.clientY);
        if (at === current.insertAt) return;
        current.insertAt = at;
        setState({ root, from: current.from, insertAt: at, height: current.height });
      },
      onPointerUp: (event) => {
        const current = live.current;
        if (!current || current.root !== root || event.pointerId !== current.pointerId) return;
        if (current.dropping) return;
        const armed = current.armed;
        const at = current.insertAt;
        const before = dropBefore(rows, root, at);
        if (!armed || before === null) {
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
        place(root, before);
        window.setTimeout(() => {
          if (live.current === current) settle();
        }, DROP_MS);
      },
      onPointerCancel: () => {
        if (live.current?.root === root) settle();
      },
      onClickCapture: (event) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.stopPropagation();
        event.preventDefault();
      },
    }),
    [arm, enabled, measure, place, rows, settle],
  );

  const dragging = state !== null;
  useEffect(() => {
    if (!dragging) return;
    if (typeof requestAnimationFrame !== "function") return;
    const scroller = listRef.current?.closest<HTMLElement>(".body");
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
              setState({ root: current.root, from: current.from, insertAt: at, height: current.height });
            }
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging, measure]);

  return { state, listRef, row, swallowSwipe };
}
