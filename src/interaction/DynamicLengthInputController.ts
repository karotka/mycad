import type { Vec2 } from '../math/geometry';
import { dynamicLengthPoint } from './DynamicLengthInput';

/** A minimal element surface — real `HTMLInputElement` in the app, a plain
 *  stub in tests — so this stays testable without a DOM. */
export interface DynamicLengthInputElement {
  value: string;
  hidden: boolean;
  style: { left: string; top: string };
  select(): void;
  addEventListener(type: 'focus' | 'input', listener: () => void): void;
  addEventListener(type: 'keydown', listener: (event: { key?: string; preventDefault(): void }) => void): void;
}

export interface DynamicLengthInputContext {
  input: DynamicLengthInputElement;
  /** Local-plane point to screen pixels, the same frame the start/cursor
   *  points passed to `update()` arrive in. */
  project: (point: Vec2) => { x: number; y: number };
  isActive: () => boolean;
  onCommit: (point: Vec2) => void;
  /** Called instead of `onCommit` when Enter is pressed on an empty box AND
   *  the most recent `update()` marked `emptyFinishes` true — POLYLINE's own
   *  "blank Enter finishes the whole polyline early" convention. LINE has no
   *  such concept: it always passes `emptyFinishes: false`, so a bare Enter
   *  there just places the point at the live cursor, the same as a click. */
  onEmptyCommit?: () => void;
}

/**
 * A single editable "Length" box for LINE's second point and each of
 * POLYLINE's own — the same dynamic-input idea as RECTANGLE's width/height
 * boxes, but one dimension: the segment's direction always follows the
 * cursor, typing a value fixes only its length. Sits at the segment's own
 * midpoint. Click to edit — unlike RECTANGLE's grip-editing case, drawing a
 * new line or polyline never captures the pointer, so a click reaches the
 * box fine without needing to auto-focus it and risk swallowing POLYLINE's
 * own keyboard shortcuts (like typing "C" to close).
 */
export function createDynamicLengthInput(ctx: DynamicLengthInputContext) {
  const { input, project, isActive, onCommit, onEmptyCommit } = ctx;
  let overridden = false;
  let lastStart: Vec2 | null = null;
  let lastCursor: Vec2 | null = null;
  let lastEmptyFinishes = false;

  /** Hides the box and drops whatever was typed — a fresh segment starts clean. */
  function hide(): void {
    if (input.hidden) return;
    input.hidden = true;
    input.value = '';
    overridden = false;
    lastStart = null;
    lastCursor = null;
  }

  function commit(): void {
    if (!lastStart || !lastCursor) return;
    // The box always shows the live-tracked length, so its text is never
    // actually empty by itself — "nothing typed" has to mean no override,
    // not an empty string.
    if (!overridden && lastEmptyFinishes && onEmptyCommit) {
      hide();
      onEmptyCommit();
      return;
    }
    const point = dynamicLengthPoint(lastStart, lastCursor, overridden ? input.value : '');
    hide();
    onCommit(point);
  }

  /**
   * Called on every pointer move while a segment's free end is pending.
   * `emptyFinishes` marks whether a bare Enter should finish the whole
   * command instead of placing a point at the live cursor — true for
   * POLYLINE's own optional continuation step, false for LINE. Returns the
   * effective point so the caller can draw the segment's own live preview
   * against it instead of the raw cursor — see RECTANGLE's `update()` for
   * why that matters once a value has been typed.
   */
  function update(start: Vec2, cursor: Vec2, emptyFinishes: boolean): Vec2 {
    lastStart = start;
    lastCursor = cursor;
    lastEmptyFinishes = emptyFinishes;
    const point = dynamicLengthPoint(start, cursor, overridden ? input.value : '');
    if (!overridden) input.value = Math.hypot(point.x - start.x, point.y - start.y).toFixed(2);
    const screen = project({ x: (start.x + point.x) / 2, y: (start.y + point.y) / 2 });
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
  // Clearing the box back to empty returns the length to live tracking.
  input.addEventListener('input', () => { overridden = input.value.trim() !== ''; });

  return { update, hide, sync };
}
