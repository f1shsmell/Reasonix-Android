/**
 * The sideways swipe between the two home views.
 *
 * A phone expects to move between sibling tabs by swiping, but this screen is
 * full of things that also want the finger: a vertical list that scrolls, a
 * horizontal strip of "needs you" cards, and rows with their own buttons. A
 * gesture that fires on any horizontal drag would steal all three.
 *
 * So the rule is deliberately strict, and it lives in a pure function:
 *
 * - the drag must be mostly horizontal (a diagonal is a scroll that drifted);
 * - it must cover real distance, so a tap that wobbles does not switch views;
 * - it must start on the page, not inside a horizontally scrolling strip;
 * - and it only moves one step, never wrapping around.
 */

export type HomeTab = "recent" | "projects";

/** How far a finger must travel before it counts as a swipe, in CSS pixels. */
export const SWIPE_MIN_PX = 56;

/** How much more horizontal than vertical the drag has to be. */
export const SWIPE_RATIO = 1.5;

export interface SwipeInput {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

/**
 * Which adjacent view a finished drag asks for: 1 for the next, -1 for the
 * previous, 0 when the drag was not a deliberate sideways move.
 *
 * The rules live here because the failure mode is subtle: a gesture that fires
 * too eagerly steals the vertical scroll and the sideways card strip, and that
 * is not something a screenshot would show.
 */
export function swipeDirection(input: SwipeInput): -1 | 0 | 1 {
  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  if (Math.abs(dx) < SWIPE_MIN_PX) return 0;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_RATIO) return 0;
  // Dragging left brings the next view in from the right.
  return dx < 0 ? 1 : -1;
}

/**
 * The tab a finished drag asks for, or null when it is not a swipe this
 * screen should honour.
 *
 * Direction follows the content, not the finger: dragging left brings the next
 * view in from the right, which is how every native pager behaves.
 */
export function swipeTo(input: SwipeInput & { tab: HomeTab }): HomeTab | null {
  const direction = swipeDirection(input);
  if (direction === 0) return null;
  if (direction === 1) {
    // Dragged left: the next view. There is only one step to take.
    return input.tab === "recent" ? "projects" : null;
  }
  return input.tab === "projects" ? "recent" : null;
}

/**
 * Whether a touch that started on this element belongs to a horizontal strip
 * rather than to the page.
 *
 * The "needs you" cards scroll sideways on their own; a swipe there is the
 * person paging through those cards, and taking it as a tab change would make
 * that strip unusable.
 */
export function insideHorizontalScroller(node: EventTarget | null): boolean {
  const element = node as Element | null;
  if (!element || typeof element.closest !== "function") return false;
  return element.closest(".cards") !== null;
}
