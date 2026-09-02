import type { Vec2 } from '../math/geometry';
import { dynamicLengthMidpoint, dynamicLengthPoint, type DynamicLengthFields } from './DynamicLengthInput';

/** How far right of the length box, in screen pixels, the angle box sits —
 *  a fixed on-screen offset rather than a world-space one, since a world
 *  offset would grow or shrink with zoom instead of staying a steady gap
 *  beside the other box. Roughly the box's own rendered width (56px plus
 *  padding and border, see .dyn-dim-input in app.css) plus enough gap either
 *  side for the "<" and "°" labels. */
const ANGLE_OFFSET_PX = 84;
/** Where the "<" between the two boxes sits — the midpoint of the gap. */
const SEPARATOR_OFFSET_PX = ANGLE_OFFSET_PX / 2;
/** Where the "°" after the angle box sits, relative to the angle box itself. */
const DEGREE_OFFSET_PX = 40;

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

/** The non-interactive "<" and "°" labels riding beside the two boxes —
 *  just enough surface to show/hide and position them. */
export interface DynamicLengthLabelElement {
  hidden: boolean;
  style: { left: string; top: string };
}

export interface DynamicLengthInputContext {
  lengthInput: DynamicLengthInputElement;
  angleInput: DynamicLengthInputElement;
  /** The "<" between the two boxes and the "°" after the angle box —
   *  AutoCAD's own polar-coordinate notation (e.g. "5<30"). */
  separatorLabel: DynamicLengthLabelElement;
  degreeLabel: DynamicLengthLabelElement;
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
 * segment's own midpoint and an Angle box sits right beside it — typing
 * either fixes it while the mouse still drives the other. Tab moves
 * between the two (plain DOM tab order isn't reliable here, so handled
 * explicitly, same as RECTANGLE's boxes). See update()'s own doc comment
 * for when it auto-focuses versus waits for a click.
 */
export function createDynamicLengthInput(ctx: DynamicLengthInputContext) {
  const { lengthInput, angleInput, separatorLabel, degreeLabel, project, isActive, onCommit, onEmptyCommit } = ctx;
  let lengthOverridden = false;
  let angleOverridden = false;
  let lastStart: Vec2 | null = null;
  let lastCursor: Vec2 | null = null;
  let lastEmptyFinishes = false;
  let lastDiameterMode = false;

  function currentFields(): DynamicLengthFields {
    return {
      length: lengthOverridden ? lengthInput.value : '',
      angle: angleOverridden ? angleInput.value : '',
    };
  }

  /** `updateDiameter`'s own fields: the box shows and edits the diameter,
   *  but `dynamicLengthPoint`'s "length" is the radius-equivalent distance
   *  from centre to the circumference point — half of whatever was typed.
   *  Dividing unparsable text by 2 still fails to parse, so it falls back
   *  to the live distance exactly the same way an empty box would. */
  function radiusFieldsFromDiameterBox(): DynamicLengthFields {
    return { length: lengthOverridden ? String(Number(lengthInput.value) / 2) : '', angle: '' };
  }

  function position(element: DynamicLengthInputElement | DynamicLengthLabelElement, screen: { x: number; y: number }): void {
    element.style.left = `${screen.x}px`;
    element.style.top = `${screen.y}px`;
    element.hidden = false;
  }

  /** Hides both boxes (and their labels) and drops whatever was typed — a
   *  fresh segment starts clean. */
  function hide(): void {
    if (lengthInput.hidden && angleInput.hidden) return;
    lengthInput.hidden = true;
    angleInput.hidden = true;
    separatorLabel.hidden = true;
    degreeLabel.hidden = true;
    lengthInput.value = '';
    angleInput.value = '';
    lengthOverridden = false;
    angleOverridden = false;
    lastStart = null;
    lastCursor = null;
    lastDiameterMode = false;
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
    const fields = lastDiameterMode ? radiusFieldsFromDiameterBox() : currentFields();
    const point = dynamicLengthPoint(lastStart, lastCursor, fields);
    hide();
    onCommit(point);
  }

  /**
   * Called on every pointer move while a segment's free end is pending.
   * `emptyFinishes` marks whether a bare Enter should finish the whole
   * command instead of placing a point at the live cursor — true for
   * POLYLINE's own optional continuation step, false otherwise. `autoFocus`
   * is for grip-editing an existing line's endpoint: that keeps the pointer
   * captured for the whole click-move-click gesture (see RECTANGLE's own
   * grip-editing case), so a click on the box never reaches it — it has to
   * already have focus. Drawing a new line/polyline never captures the
   * pointer, so those callers leave it false and let a click reach the box
   * normally, which also avoids swallowing POLYLINE's own keyboard
   * shortcuts (like typing "C" to close) the moment the box appears.
   * Returns the effective point so the caller can draw the segment's own
   * live preview against it instead of the raw cursor — see RECTANGLE's
   * `update()` for why that matters once a value has been typed.
   */
  function update(start: Vec2, cursor: Vec2, options: { emptyFinishes: boolean; autoFocus?: boolean }): Vec2 {
    const firstFrame = lengthInput.hidden && angleInput.hidden;
    lastStart = start;
    lastCursor = cursor;
    lastEmptyFinishes = options.emptyFinishes;
    lastDiameterMode = false;
    const point = dynamicLengthPoint(start, cursor, currentFields());
    if (!lengthOverridden) lengthInput.value = Math.hypot(point.x - start.x, point.y - start.y).toFixed(2);
    if (!angleOverridden) angleInput.value = ((Math.atan2(point.y - start.y, point.x - start.x) * 180) / Math.PI).toFixed(2);
    const screen = project(dynamicLengthMidpoint(start, point));
    position(lengthInput, screen);
    position(separatorLabel, { x: screen.x + SEPARATOR_OFFSET_PX, y: screen.y });
    position(angleInput, { x: screen.x + ANGLE_OFFSET_PX, y: screen.y });
    position(degreeLabel, { x: screen.x + ANGLE_OFFSET_PX + DEGREE_OFFSET_PX, y: screen.y });
    if (firstFrame && options.autoFocus) lengthInput.focus();
    return point;
  }

  /**
   * The single-axis counterpart for CIRCLE's own radius step: shows and
   * edits the *diameter* (what the user asked to see) even though the
   * underlying geometry is radius-based — a circle looks the same
   * regardless of which way around it the boundary point sits, so there is
   * no angle to fix and the angle box stays hidden along with its labels.
   */
  function updateDiameter(center: Vec2, cursor: Vec2): Vec2 {
    lastStart = center;
    lastCursor = cursor;
    lastEmptyFinishes = false;
    lastDiameterMode = true;
    const point = dynamicLengthPoint(center, cursor, radiusFieldsFromDiameterBox());
    if (!lengthOverridden) lengthInput.value = (Math.hypot(point.x - center.x, point.y - center.y) * 2).toFixed(2);
    const screen = project(dynamicLengthMidpoint(center, point));
    position(lengthInput, screen);
    angleInput.hidden = true;
    separatorLabel.hidden = true;
    degreeLabel.hidden = true;
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

  return { update, updateDiameter, hide, sync };
}
