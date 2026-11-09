/**
 * A picture at the size the phone allows.
 *
 * The thumbnail a turn or the composer draws only says which picture this is;
 * the picture itself is read here, so the zoom and pan gestures live with it.
 */

import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useBackCloser } from "../app/backStack";

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const TAP_SLOP = 8;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 24;

interface Spot {
  x: number;
  y: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function between(first: Spot | undefined, second: Spot | undefined): number {
  if (!first || !second) return 0;
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function ImageViewer({
  src,
  alt = "图片预览",
  onClose,
}: {
  src: string;
  alt?: string;
  /** The close button, a tap on the empty stage, and Android's back. */
  onClose: () => void;
}) {
  useBackCloser(true, onClose);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Spot>({ x: 0, y: 0 });
  const stage = useRef<HTMLDivElement | null>(null);
  const picture = useRef<HTMLImageElement | null>(null);
  const pointers = useRef(new Map<number, Spot>());
  const pinch = useRef({ between: 0, scale: 1 });
  const press = useRef<{ at: Spot; moved: boolean } | null>(null);
  const last = useRef<Spot | null>(null);
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null);

  function panLimit(next: number): Spot {
    const frame = stage.current;
    const image = picture.current;
    if (!frame || !image) return { x: 0, y: 0 };
    return {
      x: Math.max(0, (image.clientWidth * next - frame.clientWidth) / 2),
      y: Math.max(0, (image.clientHeight * next - frame.clientHeight) / 2),
    };
  }

  function zoomTo(next: number): void {
    const limit = panLimit(next);
    setScale(next);
    setOffset((current) => ({
      x: clamp(current.x, -limit.x, limit.x),
      y: clamp(current.y, -limit.y, limit.y),
    }));
  }

  function toggleZoom(): void {
    zoomTo(scale > 1 ? 1 : DOUBLE_TAP_SCALE);
  }

  function down(event: ReactPointerEvent<HTMLDivElement>): void {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      press.current = { at: { x: event.clientX, y: event.clientY }, moved: false };
      last.current = { x: event.clientX, y: event.clientY };
      pinch.current.between = 0;
    } else if (pointers.current.size === 2) {
      const [first, second] = [...pointers.current.values()];
      pinch.current = { between: between(first, second), scale };
      press.current = null;
      last.current = null;
    }
  }

  function move(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2) {
      const [first, second] = [...pointers.current.values()];
      if (pinch.current.between > 0) {
        zoomTo(
          clamp((pinch.current.scale * between(first, second)) / pinch.current.between, 1, MAX_SCALE),
        );
      }
      return;
    }
    const held = press.current;
    if (!held) return;
    if (Math.hypot(event.clientX - held.at.x, event.clientY - held.at.y) > TAP_SLOP) {
      held.moved = true;
    }
    const from = last.current;
    const frame = stage.current;
    if (scale <= 1 || !from || !frame) {
      last.current = { x: event.clientX, y: event.clientY };
      return;
    }
    const limit = panLimit(scale);
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    last.current = { x: event.clientX, y: event.clientY };
    setOffset((current) => ({
      x: clamp(current.x + dx, -limit.x, limit.x),
      y: clamp(current.y + dy, -limit.y, limit.y),
    }));
  }

  function up(event: ReactPointerEvent<HTMLDivElement>): void {
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current.between = 0;
    if (pointers.current.size === 0) last.current = null;
    const held = press.current;
    press.current = null;
    if (!wasSingle || !held || held.moved) return;
    const now = performance.now();
    const tapped = { x: event.clientX, y: event.clientY };
    const previous = lastTap.current;
    if (
      previous &&
      now - previous.at < DOUBLE_TAP_MS &&
      Math.hypot(tapped.x - previous.x, tapped.y - previous.y) < DOUBLE_TAP_SLOP
    ) {
      lastTap.current = null;
      toggleZoom();
      return;
    }
    lastTap.current = { at: now, x: tapped.x, y: tapped.y };
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label="图片预览">
      <div
        ref={stage}
        className="image-viewer-stage"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <img
          ref={picture}
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>
      <button type="button" className="image-viewer-close" aria-label="关闭预览" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
