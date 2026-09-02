import type { Vec2 } from '../math/geometry';
import { dynamicRectangleAxisCoordinate, dynamicRectangleBoxPoints, dynamicRectangleCorner, type DynamicRectangleFields } from './DynamicRectangleInput';

/** A minimal element surface — real `HTMLElement`/`HTMLInputElement` in the
 *  app, a plain stub in tests — so this stays testable without a DOM. */
export interface DynamicRectangleInputElement {
  value: string;
  hidden: boolean;
  style: { left: string; top: string };
  select(): void;
  focus(): void;
  addEventListener(type: 'focus' | 'input', listener: () => void): void;
  addEventListener(type: 'keydown', listener: (event: { key?: string; preventDefault(): void }) => void): void;
}

export interface DynamicRectangleInputContext {
  widthInput: DynamicRectangleInputElement;
  heightInput: DynamicRectangleInputElement;
  /** Local-plane point to screen pixels, the same frame the fixed/cursor
   *  points passed to `update()`/`updateEdge()` arrive in. */
  project: (point: Vec2) => { x: number; y: number };
  /** Whether the boxes should still be showing right now — checked by
   *  `sync()` so a command switch, cancel, grip release, or view-mode
   *  change hides them even without a further pointer move to trigger it.
   *  Decoupled from any one caller (RECTANGLE's own draw step, or grip-
   *  editing an existing rectangle's corner or mid-edge grip) so this stays
   *  reusable. */
  isActive: () => boolean;
  onCommit: (point: Vec2) => void;
}

type Session =
  | { kind: 'corner'; start: Vec2; cursor: Vec2 }
  | { kind: 'edge'; axis: 'x' | 'y'; fixed: number; mid: number; cursor: number };

/**
 * A Fusion-360-style dynamic input prototype for placing a rectangle's free
 * corner opposite a fixed one — RECTANGLE's own second point, or dragging an
 * existing rectangle's corner grip — and, single-axis, for a mid-edge grip
 * that stretches only one side: two small boxes (or, for a mid-edge grip,
 * just the one relevant box) sit on the affected side(s) showing the live
 * size, editable in place. Tab moves between the two corner-mode boxes
 * (plain DOM tab order isn't reliable here, so handled explicitly), Enter
 * commits through `onCommit`, which the caller wires to whichever path a
 * real click/release would take, so typed and clicked results never
 * diverge. 2D only; scoped to rectangles as a trial run of an on-canvas
 * input surface living alongside the command line.
 */
export function createDynamicRectangleInput(ctx: DynamicRectangleInputContext) {
  const { widthInput, heightInput, project, isActive, onCommit } = ctx;
  // Whether the user has actually typed a value, as opposed to what the box
  // is currently displaying — the two must stay separate. update() writes
  // its own live-tracked number into `.value` every frame, and reading that
  // back as if it were a typed override next frame would latch the result to
  // whatever the very first frame happened to show, forever. Only a real
  // 'input' event (never fired by update()'s own assignment) may set these.
  let widthOverridden = false;
  let heightOverridden = false;
  let session: Session | null = null;

  function currentFields(): DynamicRectangleFields {
    return {
      width: widthOverridden ? widthInput.value : '',
      height: heightOverridden ? heightInput.value : '',
    };
  }

  /** The single field relevant to a mid-edge grip's one free axis. */
  function edgeOverrideText(axis: 'x' | 'y'): string {
    return axis === 'x' ? currentFields().width : currentFields().height;
  }

  function position(input: DynamicRectangleInputElement, point: Vec2): void {
    const screen = project(point);
    input.style.left = `${screen.x}px`;
    input.style.top = `${screen.y}px`;
    input.hidden = false;
  }

  /** Hides both boxes and drops whatever was typed — a fresh drag starts clean. */
  function hide(): void {
    if (widthInput.hidden && heightInput.hidden) return;
    widthInput.hidden = true;
    heightInput.hidden = true;
    widthInput.value = '';
    heightInput.value = '';
    widthOverridden = false;
    heightOverridden = false;
    session = null;
  }

  function effectivePoint(current: Session): Vec2 {
    if (current.kind === 'corner') return dynamicRectangleCorner(current.start, current.cursor, currentFields());
    const value = dynamicRectangleAxisCoordinate(current.fixed, current.cursor, edgeOverrideText(current.axis));
    return current.axis === 'x' ? { x: value, y: current.mid } : { x: current.mid, y: value };
  }

  function commit(): void {
    if (!session) return;
    const point = effectivePoint(session);
    hide();
    onCommit(point);
  }

  /**
   * Called on every pointer move while a free corner opposite `start` is
   * pending: positions both boxes and refreshes whichever one has no typed
   * override yet. Returns the effective corner — the live cursor on any axis
   * with no typed override, fixed at the typed value on one that has it — so
   * the caller can draw the rectangle's own live shape against the same
   * point instead of the raw cursor. Without that, typing a width wouldn't
   * visibly fix that side: the box would show the right number while the
   * drawn rectangle kept following the mouse as if nothing had been typed.
   */
  function update(start: Vec2, cursor: Vec2): Vec2 {
    const firstFrame = widthInput.hidden && heightInput.hidden;
    session = { kind: 'corner', start, cursor };
    const corner = dynamicRectangleCorner(start, cursor, currentFields());
    if (!widthOverridden) widthInput.value = Math.abs(corner.x - start.x).toFixed(2);
    if (!heightOverridden) heightInput.value = Math.abs(corner.y - start.y).toFixed(2);
    const points = dynamicRectangleBoxPoints(start, corner);
    position(widthInput, points.width);
    position(heightInput, points.height);
    // Grip-editing keeps the pointer captured by the viewport for the whole
    // click-move-click gesture, so a click on the box itself never reaches
    // it — it would be delivered to the viewport as the drag's finishing
    // click instead. Focusing it the moment it appears is the only way in.
    if (firstFrame) widthInput.focus();
    return corner;
  }

  /**
   * The single-axis counterpart for one of a rectangle's mid-edge grips,
   * which stretches only one side: `fixed` is the unmoving opposite edge's
   * coordinate along `axis`, and `perpendicular` is the span the edge itself
   * runs (so the one box shown can sit at its midpoint, like the corner-mode
   * boxes sit at theirs). Only the relevant box (width for a vertical edge
   * changing width, height for a horizontal one changing height) is shown;
   * the other stays hidden. Returns the effective point for the caller to
   * feed into the grip's own geometry update — see `update()`'s doc comment
   * for why the caller needs it rather than the raw cursor.
   */
  function updateEdge(axis: 'x' | 'y', fixed: number, perpendicular: [number, number], cursor: Vec2): Vec2 {
    const firstFrame = widthInput.hidden && heightInput.hidden;
    const cursorAxisValue = axis === 'x' ? cursor.x : cursor.y;
    const mid = (perpendicular[0] + perpendicular[1]) / 2;
    session = { kind: 'edge', axis, fixed, mid, cursor: cursorAxisValue };
    const activeInput = axis === 'x' ? widthInput : heightInput;
    const inactiveInput = axis === 'x' ? heightInput : widthInput;
    const overridden = axis === 'x' ? widthOverridden : heightOverridden;
    const value = dynamicRectangleAxisCoordinate(fixed, cursorAxisValue, edgeOverrideText(axis));
    if (!overridden) activeInput.value = Math.abs(value - fixed).toFixed(2);
    const point = axis === 'x' ? { x: value, y: mid } : { x: mid, y: value };
    position(activeInput, point);
    inactiveInput.hidden = true;
    // See update()'s comment: grip-editing keeps the pointer captured, so a
    // click can never reach the box — it has to already have focus.
    if (firstFrame) activeInput.focus();
    return point;
  }

  /** Hides the boxes the moment they no longer apply, even without a further
   *  pointer move to trigger it otherwise — see `isActive` above. */
  function sync(): void {
    if (!isActive()) hide();
  }

  // Native DOM tab order is not trustworthy here: the app has many other
  // focusable elements (toolbar buttons, panel inputs), so a plain Tab out of
  // one box can easily land somewhere else in the page entirely rather than
  // on its sibling. Tab is handled explicitly instead, cycling only between
  // these two fields — a no-op in mid-edge mode, where only one is shown.
  const onWidthKeydown = (event: { key?: string; preventDefault(): void }): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Tab' && !heightInput.hidden) { event.preventDefault(); heightInput.focus(); }
  };
  const onHeightKeydown = (event: { key?: string; preventDefault(): void }): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Tab' && !widthInput.hidden) { event.preventDefault(); widthInput.focus(); }
  };
  widthInput.addEventListener('keydown', onWidthKeydown);
  heightInput.addEventListener('keydown', onHeightKeydown);
  // Selects the current text so the first keystroke replaces it outright,
  // whether focus arrived from a click or from update()'s own auto-focus.
  widthInput.addEventListener('focus', () => widthInput.select());
  heightInput.addEventListener('focus', () => heightInput.select());
  // Clearing the box back to empty returns that axis to live tracking.
  widthInput.addEventListener('input', () => { widthOverridden = widthInput.value.trim() !== ''; });
  heightInput.addEventListener('input', () => { heightOverridden = heightInput.value.trim() !== ''; });

  return { update, updateEdge, hide, sync };
}
