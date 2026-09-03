import type { Vec2 } from '../math/geometry';
import { arcFromSagitta, dynamicArcPoint } from '../math/arcFit';

/** How far past the arc's own apex, in screen pixels, the box sits — not
 *  directly on top of the point (and the cursor sitting right there too),
 *  same reasoning as CIRCLE's own diameter box sitting outside its edge. */
const ARC_BOX_OUTSET_PX = 16;

/** A minimal element surface — real `HTMLInputElement` in the app, a plain
 *  stub in tests — so this stays testable without a DOM. */
export interface DynamicArcInputElement {
  value: string;
  hidden: boolean;
  style: { left: string; top: string };
  select(): void;
  focus(): void;
  addEventListener(type: 'focus' | 'input', listener: () => void): void;
  addEventListener(type: 'keydown', listener: (event: { key?: string; preventDefault(): void }) => void): void;
}

export interface DynamicArcInputContext {
  input: DynamicArcInputElement;
  /** Local-plane point to screen pixels, the same frame the start/end/cursor
   *  points passed to `update()` arrive in. */
  project: (point: Vec2) => { x: number; y: number };
  isActive: () => boolean;
  onCommit: (point: Vec2) => void;
}

/**
 * The rubber-band-arc counterpart to CIRCLE's own diameter box: while
 * ARC_SER's third ("point on arc") step is pending, one box sits at the
 * live arc's own apex showing its radius — editable in place, fixing the
 * radius (on whichever side of the chord the cursor is on) while the mouse
 * still drives the bulge otherwise. Click to edit, same as CIRCLE and
 * LINE/POLYLINE's own draw-time boxes: this step never captures the
 * pointer, so a click reaches it fine without auto-focusing.
 */
export function createDynamicArcInput(ctx: DynamicArcInputContext) {
  const { input, project, isActive, onCommit } = ctx;
  let overridden = false;
  let lastStart: Vec2 | null = null;
  let lastEnd: Vec2 | null = null;
  let lastCursor: Vec2 | null = null;

  /** Hides the box and drops whatever was typed — a fresh arc starts clean. */
  function hide(): void {
    if (input.hidden) return;
    input.hidden = true;
    input.value = '';
    overridden = false;
    lastStart = null;
    lastEnd = null;
    lastCursor = null;
  }

  function commit(): void {
    if (!lastStart || !lastEnd || !lastCursor) return;
    const point = dynamicArcPoint(lastStart, lastEnd, lastCursor, overridden ? input.value : '');
    hide();
    onCommit(point);
  }

  /**
   * Called on every pointer move while the arc's third point is pending.
   * Returns the effective point so the caller can draw the arc's own live
   * shape against it instead of the raw cursor — see RECTANGLE's `update()`
   * for why that matters once a value has been typed.
   */
  function update(start: Vec2, end: Vec2, cursor: Vec2): Vec2 {
    lastStart = start;
    lastEnd = end;
    lastCursor = cursor;
    const point = dynamicArcPoint(start, end, cursor, overridden ? input.value : '');
    const arc = arcFromSagitta(start, end, point);
    if (!arc) {
      // The cursor is (momentarily) exactly on the chord — no arc, and
      // nothing sensible to show, but keep whatever was typed rather than
      // dropping it: the very next frame, off the chord again, picks back up.
      input.hidden = true;
      return point;
    }
    if (!overridden) input.value = arc.radius.toFixed(2);
    // Push the box past the apex rather than sitting right on it — directly
    // on the point (and the cursor, which is also right there) buried it
    // under the crosshair. Worked out in screen space, past the projected
    // midpoint→apex direction, for the same reason CIRCLE's diameter box is.
    const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const midScreen = project(mid);
    const apexScreen = project(point);
    const dx = apexScreen.x - midScreen.x, dy = apexScreen.y - midScreen.y;
    const outward = Math.hypot(dx, dy) || 1;
    const screen = {
      x: apexScreen.x + (dx / outward) * ARC_BOX_OUTSET_PX,
      y: apexScreen.y + (dy / outward) * ARC_BOX_OUTSET_PX,
    };
    input.style.left = `${screen.x}px`;
    input.style.top = `${screen.y}px`;
    input.hidden = false;
    return point;
  }

  /** Hides the box the moment it no longer applies, even without a further
   *  pointer move to trigger it otherwise — see `isActive` above. */
  function sync(): void {
    if (!isActive()) hide();
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
  });
  input.addEventListener('focus', () => input.select());
  // Clearing the box back to empty returns the radius to live tracking.
  input.addEventListener('input', () => { overridden = input.value.trim() !== ''; });

  return { update, hide, sync };
}
