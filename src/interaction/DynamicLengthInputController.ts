import type { Vec2 } from '../math/geometry';
import { dynamicLengthBoxPoints, dynamicLengthPoint, type DynamicLengthFields } from './DynamicLengthInput';

/** A minimal element surface — real `HTMLInputElement` in the app, a plain
 *  stub in tests — so this stays testable without a DOM. */
export interface DynamicLengthInputElement {
  value: string;
  hidden: boolean;
  style: { left: string; top: string };
  select(): void;
  focus(): void;
  addEventListener(type: 'focus' | 'input', listener: () => void): void;
  addEventListener(type: 'keydown', listener: (event: { key?: string; preventDefault(): void }) => void): void;
}

export interface DynamicLengthInputContext {
  lengthInput: DynamicLengthInputElement;
  angleInput: DynamicLengthInputElement;
  /** Local-plane point to screen pixels, the same frame the start/cursor
   *  points passed to `update()` arrive in. */
  project: (point: Vec2) => { x: number; y: number };
  isActive: () => boolean;
  onCommit: (point: Vec2) => void;
  /** Called instead of `onCommit` when Enter is pressed with NEITHER box
   *  overridden AND the most recent `update()` marked `emptyFinishes` true —
   *  POLYLINE's own "blank Enter finishes the whole polyline early"
   *  convention. LINE has no such concept: it always passes
   *  `emptyFinishes: false`, so a bare Enter there just places the point at
   *  the live cursor, the same as a click. */
  onEmptyCommit?: () => void;
}

/**
 * The polar counterpart to RECTANGLE's width/height boxes: while a line's
 * (or one polyline segment's) free end is pending, a Length box sits at the
 * segment's own midpoint and an Angle box sits at the fixed start point —
 * typing either fixes it while the mouse still drives the other. Tab moves
 * between the two (plain DOM tab order isn't reliable here, so handled
 * explicitly, same as RECTANGLE's boxes). Click to edit — unlike
 * RECTANGLE's grip-editing case, drawing a new line or polyline never
 * captures the pointer, so a click reaches a box fine without needing to
 * auto-focus it and risk swallowing POLYLINE's own keyboard shortcuts (like
 * typing "C" to close).
 */
export function createDynamicLengthInput(ctx: DynamicLengthInputContext) {
  const { lengthInput, angleInput, project, isActive, onCommit, onEmptyCommit } = ctx;
  let lengthOverridden = false;
  let angleOverridden = false;
  let lastStart: Vec2 | null = null;
  let lastCursor: Vec2 | null = null;
  let lastEmptyFinishes = false;

  function currentFields(): DynamicLengthFields {
    return {
      length: lengthOverridden ? lengthInput.value : '',
      angle: angleOverridden ? angleInput.value : '',
    };
  }

  function position(input: DynamicLengthInputElement, point: Vec2): void {
    const screen = project(point);
    input.style.left = `${screen.x}px`;
    input.style.top = `${screen.y}px`;
    input.hidden = false;
  }

  /** Hides both boxes and drops whatever was typed — a fresh segment starts clean. */
  function hide(): void {
    if (lengthInput.hidden && angleInput.hidden) return;
    lengthInput.hidden = true;
    angleInput.hidden = true;
    lengthInput.value = '';
    angleInput.value = '';
    lengthOverridden = false;
    angleOverridden = false;
    lastStart = null;
    lastCursor = null;
  }

  function commit(): void {
    if (!lastStart || !lastCursor) return;
    // The boxes always show live-tracked numbers, so their text is never
    // actually empty by itself — "nothing typed" has to mean no override in
    // either box, not an empty string.
    if (!lengthOverridden && !angleOverridden && lastEmptyFinishes && onEmptyCommit) {
      hide();
      onEmptyCommit();
      return;
    }
    const point = dynamicLengthPoint(lastStart, lastCursor, currentFields());
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
    const point = dynamicLengthPoint(start, cursor, currentFields());
    if (!lengthOverridden) lengthInput.value = Math.hypot(point.x - start.x, point.y - start.y).toFixed(2);
    if (!angleOverridden) angleInput.value = ((Math.atan2(point.y - start.y, point.x - start.x) * 180) / Math.PI).toFixed(2);
    const points = dynamicLengthBoxPoints(start, point);
    position(lengthInput, points.length);
    position(angleInput, points.angle);
    return point;
  }

  /** Hides the boxes the moment they no longer apply, even without a
   *  further pointer move to trigger it otherwise — see `isActive` above. */
  function sync(): void {
    if (!isActive()) hide();
  }

  // Native DOM tab order is not trustworthy here — see RECTANGLE's own
  // controller for why — so Tab is handled explicitly, cycling only between
  // these two fields.
  const onLengthKeydown = (event: { key?: string; preventDefault(): void }): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Tab') { event.preventDefault(); angleInput.focus(); }
  };
  const onAngleKeydown = (event: { key?: string; preventDefault(): void }): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Tab') { event.preventDefault(); lengthInput.focus(); }
  };
  lengthInput.addEventListener('keydown', onLengthKeydown);
  angleInput.addEventListener('keydown', onAngleKeydown);
  lengthInput.addEventListener('focus', () => lengthInput.select());
  angleInput.addEventListener('focus', () => angleInput.select());
  // Clearing a box back to empty returns that quantity to live tracking.
  lengthInput.addEventListener('input', () => { lengthOverridden = lengthInput.value.trim() !== ''; });
  angleInput.addEventListener('input', () => { angleOverridden = angleInput.value.trim() !== ''; });

  return { update, hide, sync };
}
