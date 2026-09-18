import type { Vec2 } from '../math/geometry';
import { dynamicLengthPoint, type DynamicLengthFields, type RadialQuantity } from './DynamicLengthInput';

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
/** How far below the line's own start point, in screen pixels, its boxes
 *  sit. Anchored on the start rather than the segment's midpoint: the
 *  midpoint walks along with the cursor, so a short segment put the boxes
 *  under the very end being placed and hid what was being aimed at. The
 *  start point does not move, so the boxes stay put while the line is
 *  drawn. Below rather than on it, so the point itself stays visible. */
const LENGTH_BOX_BELOW_START_PX = 26;
/** Where the R/D label sits, to the left of the box it names. */
const RADIAL_PREFIX_OFFSET_PX = -22;

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

/** The same, for a label whose text changes: the R/D in front of a radial
 *  box, which says which quantity the number in it is. */
export interface DynamicLengthTextLabelElement extends DynamicLengthLabelElement {
  textContent: string | null;
}

export interface DynamicLengthInputContext {
  lengthInput: DynamicLengthInputElement;
  angleInput: DynamicLengthInputElement;
  /** The "<" between the two boxes and the "°" after the angle box —
   *  AutoCAD's own polar-coordinate notation (e.g. "5<30"). */
  separatorLabel: DynamicLengthLabelElement;
  degreeLabel: DynamicLengthLabelElement;
  /** The "R"/"D" in front of a radial box; hidden for a line's own boxes,
   *  which are named by the "<" and "°" between them instead. */
  radialPrefixLabel: DynamicLengthTextLabelElement;
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
  const { lengthInput, angleInput, separatorLabel, degreeLabel, radialPrefixLabel, project, isActive, onCommit, onEmptyCommit } = ctx;
  let lengthOverridden = false;
  let angleOverridden = false;
  let lastStart: Vec2 | null = null;
  let lastCursor: Vec2 | null = null;
  let lastEmptyFinishes = false;
  /** Which quantity the box is showing, or null while it is a line's own
   *  Length/Angle pair rather than a radial one. */
  let lastRadial: RadialQuantity | null = null;

  function currentFields(): DynamicLengthFields {
    return {
      length: lengthOverridden ? lengthInput.value : '',
      angle: angleOverridden ? angleInput.value : '',
    };
  }

  /** A radial box's own fields: the number in it is the centre-to-point
   *  distance, which is exactly `dynamicLengthPoint`'s "length" — each
   *  command decides what that distance means (see `RadialQuantity`), and
   *  neither needs it converted. There is no angle: a circle looks the same
   *  whichever way round its boundary point sits. */
  function radialFields(): DynamicLengthFields {
    return { length: lengthOverridden ? lengthInput.value : '', angle: '' };
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
    radialPrefixLabel.hidden = true;
    lengthInput.value = '';
    angleInput.value = '';
    lengthOverridden = false;
    angleOverridden = false;
    lastStart = null;
    lastCursor = null;
    lastRadial = null;
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
    const fields = lastRadial ? radialFields() : currentFields();
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
    lastRadial = null;
    const point = dynamicLengthPoint(start, cursor, currentFields());
    if (!lengthOverridden) lengthInput.value = Math.hypot(point.x - start.x, point.y - start.y).toFixed(2);
    if (!angleOverridden) angleInput.value = ((Math.atan2(point.y - start.y, point.x - start.x) * 180) / Math.PI).toFixed(2);
    const startScreen = project(start);
    const screen = { x: startScreen.x, y: startScreen.y + LENGTH_BOX_BELOW_START_PX };
    position(lengthInput, screen);
    radialPrefixLabel.hidden = true;
    position(separatorLabel, { x: screen.x + SEPARATOR_OFFSET_PX, y: screen.y });
    position(angleInput, { x: screen.x + ANGLE_OFFSET_PX, y: screen.y });
    position(degreeLabel, { x: screen.x + ANGLE_OFFSET_PX + DEGREE_OFFSET_PX, y: screen.y });
    if (firstFrame && options.autoFocus) lengthInput.focus();
    return point;
  }

  /**
   * The single-axis counterpart for a circle's own size step (and, with
   * `autoFocus`, for dragging an existing circle's radius grip): one box at
   * the centre, labelled R or D for the quantity the command is asking
   * for — CIRCLE is drawn by a point on the circumference, CIRCLE_DIAMETER
   * by a point a diameter away, and a radius grip moves the circumference.
   * No angle box: a circle looks the same whichever way round its boundary
   * point sits, so there is nothing for one to fix.
   *
   * At the centre rather than out past the boundary, where it used to sit
   * on top of the very cursor placing the point. The centre is already
   * fixed by this step, so the box stays still while the circle is sized.
   *
   * `autoFocus` follows the same reasoning as `update()`'s own option:
   * grip-editing keeps the pointer captured for the whole click-move-click
   * gesture, so a click could never reach the box otherwise; drawing a new
   * circle never captures the pointer, so that caller leaves it false.
   */
  function updateRadial(center: Vec2, cursor: Vec2, quantity: RadialQuantity, autoFocus = false): Vec2 {
    const firstFrame = lengthInput.hidden;
    lastStart = center;
    lastCursor = cursor;
    lastEmptyFinishes = false;
    lastRadial = quantity;
    const point = dynamicLengthPoint(center, cursor, radialFields());
    if (!lengthOverridden) lengthInput.value = Math.hypot(point.x - center.x, point.y - center.y).toFixed(2);
    const screen = project(center);
    position(lengthInput, screen);
    radialPrefixLabel.textContent = quantity === 'diameter' ? 'D' : 'R';
    position(radialPrefixLabel, { x: screen.x + RADIAL_PREFIX_OFFSET_PX, y: screen.y });
    angleInput.hidden = true;
    separatorLabel.hidden = true;
    degreeLabel.hidden = true;
    if (firstFrame && autoFocus) lengthInput.focus();
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

  /**
   * Puts the cursor in the Length box, if the boxes are showing at all.
   *
   * RECTANGLE's boxes take focus by themselves the moment they appear, so Tab
   * there already cycles between them. These wait for the user, because a line
   * is usually placed with the mouse and stealing the keyboard would take the
   * next typed command with it — so something has to ask, and Tab is what
   * asks. Answers whether it took focus, so the caller knows to swallow the
   * keystroke rather than let it wander off down the page.
   */
  function focusLength(): boolean {
    if (lengthInput.hidden) return false;
    lengthInput.focus();
    return true;
  }

  return { update, updateRadial, hide, sync, focusLength };
}
