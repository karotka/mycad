import type { Vec2 } from '../math/geometry';
import { dynamicCoordinatePoint, type DynamicCoordinateFields } from './DynamicCoordinateInput';

/** How far right of the X box, in screen pixels, the Y box sits — see
 *  RECTANGLE's/LINE's own controllers for why this is a fixed screen offset
 *  rather than a world-space one. */
const Y_OFFSET_PX = 74;
/** Where the "," between the two boxes sits — the midpoint of the gap. */
const COMMA_OFFSET_PX = Y_OFFSET_PX / 2;

/** A minimal element surface — real `HTMLInputElement` in the app, a plain
 *  stub in tests — so this stays testable without a DOM. */
export interface DynamicCoordinateInputElement {
  value: string;
  hidden: boolean;
  style: { left: string; top: string };
  select(): void;
  focus(): void;
  addEventListener(type: 'focus' | 'input', listener: () => void): void;
  addEventListener(type: 'keydown', listener: (event: { key?: string; preventDefault(): void }) => void): void;
}

/** The non-interactive "," between the two boxes — just enough surface to
 *  show/hide and position it. */
export interface DynamicCoordinateLabelElement {
  hidden: boolean;
  style: { left: string; top: string };
}

export interface DynamicCoordinateInputContext {
  xInput: DynamicCoordinateInputElement;
  yInput: DynamicCoordinateInputElement;
  commaLabel: DynamicCoordinateLabelElement;
  /** Local-plane point to screen pixels, the same frame the cursor point
   *  passed to `update()` arrives in. */
  project: (point: Vec2) => { x: number; y: number };
  isActive: () => boolean;
  onCommit: (point: Vec2) => void;
}

/**
 * Absolute X/Y coordinate entry for dragging an object by a reference point
 * that just moves — a circle's own centre grip, so far — as opposed to
 * RECTANGLE's or LINE's boxes, which measure a distance from a fixed point.
 * There is nothing fixed to measure from here, so the boxes show and accept
 * plain coordinates instead. Tab moves between the two (plain DOM tab order
 * isn't reliable here, so handled explicitly, same as the other boxes).
 * Always auto-focuses on first appearance: this is grip-editing only, which
 * keeps the pointer captured for the whole click-move-click gesture, so a
 * click could never reach a box otherwise.
 */
export function createDynamicCoordinateInput(ctx: DynamicCoordinateInputContext) {
  const { xInput, yInput, commaLabel, project, isActive, onCommit } = ctx;
  let xOverridden = false;
  let yOverridden = false;
  let lastCursor: Vec2 | null = null;

  function currentFields(): DynamicCoordinateFields {
    return {
      x: xOverridden ? xInput.value : '',
      y: yOverridden ? yInput.value : '',
    };
  }

  function position(element: DynamicCoordinateInputElement | DynamicCoordinateLabelElement, screen: { x: number; y: number }): void {
    element.style.left = `${screen.x}px`;
    element.style.top = `${screen.y}px`;
    element.hidden = false;
  }

  /** Hides both boxes (and the label) and drops whatever was typed — a
   *  fresh drag starts clean. */
  function hide(): void {
    if (xInput.hidden && yInput.hidden) return;
    xInput.hidden = true;
    yInput.hidden = true;
    commaLabel.hidden = true;
    xInput.value = '';
    yInput.value = '';
    xOverridden = false;
    yOverridden = false;
    lastCursor = null;
  }

  function commit(): void {
    if (!lastCursor) return;
    const point = dynamicCoordinatePoint(lastCursor, currentFields());
    hide();
    onCommit(point);
  }

  /**
   * Called on every pointer move while a reference point is being dragged:
   * positions both boxes and refreshes whichever one has no typed override
   * yet. Returns the effective point so the caller can feed it into the
   * drag's own geometry update instead of the raw cursor — see RECTANGLE's
   * `update()` for why that matters once a value has been typed.
   */
  function update(cursor: Vec2): Vec2 {
    const firstFrame = xInput.hidden && yInput.hidden;
    lastCursor = cursor;
    const point = dynamicCoordinatePoint(cursor, currentFields());
    if (!xOverridden) xInput.value = point.x.toFixed(2);
    if (!yOverridden) yInput.value = point.y.toFixed(2);
    const screen = project(point);
    position(xInput, screen);
    position(commaLabel, { x: screen.x + COMMA_OFFSET_PX, y: screen.y });
    position(yInput, { x: screen.x + Y_OFFSET_PX, y: screen.y });
    if (firstFrame) xInput.focus();
    return point;
  }

  /** Hides the boxes the moment they no longer apply, even without a
   *  further pointer move to trigger it otherwise — see `isActive` above. */
  function sync(): void {
    if (!isActive()) hide();
  }

  const onXKeydown = (event: { key?: string; preventDefault(): void }): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Tab') { event.preventDefault(); yInput.focus(); }
  };
  const onYKeydown = (event: { key?: string; preventDefault(): void }): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Tab') { event.preventDefault(); xInput.focus(); }
  };
  xInput.addEventListener('keydown', onXKeydown);
  yInput.addEventListener('keydown', onYKeydown);
  xInput.addEventListener('focus', () => xInput.select());
  yInput.addEventListener('focus', () => yInput.select());
  // Clearing a box back to empty returns that axis to live tracking.
  xInput.addEventListener('input', () => { xOverridden = xInput.value.trim() !== ''; });
  yInput.addEventListener('input', () => { yOverridden = yInput.value.trim() !== ''; });

  return { update, hide, sync };
}
