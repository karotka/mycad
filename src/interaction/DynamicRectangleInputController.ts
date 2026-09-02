import type { Vec2 } from '../math/geometry';
import type { Document } from '../core/Document';
import type { CommandManager } from '../core/commands/CommandManager';
import { dynamicRectangleBoxPoints, dynamicRectangleCorner, type DynamicRectangleFields } from './DynamicRectangleInput';

/** A minimal element surface — real `HTMLElement`/`HTMLInputElement` in the
 *  app, a plain stub in tests — so this stays testable without a DOM. */
export interface DynamicRectangleInputElement {
  value: string;
  hidden: boolean;
  style: { left: string; top: string };
  select(): void;
  focus(): void;
  addEventListener(type: 'focus' | 'blur' | 'input', listener: () => void): void;
  addEventListener(type: 'keydown', listener: (event: { key?: string; preventDefault(): void }) => void): void;
}

export interface DynamicRectangleInputContext {
  widthInput: DynamicRectangleInputElement;
  heightInput: DynamicRectangleInputElement;
  commands: CommandManager;
  doc: Document;
  /** Local-plane point to screen pixels, the same frame RECTANGLE's own points arrive in. */
  project: (point: Vec2) => { x: number; y: number };
  onCommit: (point: Vec2) => void;
}

/**
 * A Fusion-360-style dynamic input prototype for RECTANGLE: while its second
 * point is pending, two small boxes sit on the width and height sides showing
 * the live size, editable in place — Tab moves between them (plain DOM tab
 * order, since they are adjacent siblings), Enter commits through the same
 * `handleClick` path a real click would take, so typed and clicked corners
 * can never diverge. 2D only; scoped to the one command as a trial run of an
 * on-canvas input surface living alongside the command line.
 */
export function createDynamicRectangleInput(ctx: DynamicRectangleInputContext) {
  const { widthInput, heightInput, commands, doc, project, onCommit } = ctx;
  let widthFocused = false;
  let heightFocused = false;
  // Whether the user has actually typed a value, as opposed to what the box
  // is currently displaying — the two must stay separate. update() writes
  // its own live-tracked number into `.value` every frame, and reading that
  // back as if it were a typed override next frame would latch the corner to
  // whatever the very first frame happened to show, forever. Only a real
  // 'input' event (never fired by update()'s own assignment) may set these.
  let widthOverridden = false;
  let heightOverridden = false;
  let lastStart: Vec2 | null = null;
  let lastCursor: Vec2 | null = null;

  function currentFields(): DynamicRectangleFields {
    return {
      width: widthOverridden ? widthInput.value : '',
      height: heightOverridden ? heightInput.value : '',
    };
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
    lastStart = null;
    lastCursor = null;
  }

  function commit(): void {
    if (!lastStart || !lastCursor) return;
    const corner = dynamicRectangleCorner(lastStart, lastCursor, currentFields());
    hide();
    onCommit(corner);
  }

  /** Called on every pointer move while RECTANGLE's second point is pending:
   *  positions both boxes and refreshes whichever one isn't being typed into. */
  function update(start: Vec2, cursor: Vec2): void {
    lastStart = start;
    lastCursor = cursor;
    const corner = dynamicRectangleCorner(start, cursor, currentFields());
    if (!widthFocused) widthInput.value = Math.abs(corner.x - start.x).toFixed(2);
    if (!heightFocused) heightInput.value = Math.abs(corner.y - start.y).toFixed(2);
    const points = dynamicRectangleBoxPoints(start, corner);
    position(widthInput, points.width);
    position(heightInput, points.height);
  }

  /** Hides the boxes the moment RECTANGLE's second point is no longer being
   *  gathered — a command switch, cancel or completion — even without any
   *  further pointer movement to trigger it otherwise. */
  function sync(): void {
    const active = commands.active;
    const applies = active?.name === 'RECTANGLE' && active.stepIndex === 1 && doc.viewMode === '2d';
    if (!applies) hide();
  }

  // Native DOM tab order is not trustworthy here: the app has many other
  // focusable elements (toolbar buttons, panel inputs), so a plain Tab out of
  // one box can easily land somewhere else in the page entirely rather than
  // on its sibling. Tab is handled explicitly instead, cycling only between
  // these two fields.
  const onWidthKeydown = (event: { key?: string; preventDefault(): void }): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Tab') { event.preventDefault(); heightInput.focus(); }
  };
  const onHeightKeydown = (event: { key?: string; preventDefault(): void }): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); }
    else if (event.key === 'Tab') { event.preventDefault(); widthInput.focus(); }
  };
  widthInput.addEventListener('keydown', onWidthKeydown);
  heightInput.addEventListener('keydown', onHeightKeydown);
  widthInput.addEventListener('focus', () => { widthFocused = true; widthInput.select(); });
  widthInput.addEventListener('blur', () => { widthFocused = false; });
  heightInput.addEventListener('focus', () => { heightFocused = true; heightInput.select(); });
  heightInput.addEventListener('blur', () => { heightFocused = false; });
  // Clearing the box back to empty returns that axis to live tracking.
  widthInput.addEventListener('input', () => { widthOverridden = widthInput.value.trim() !== ''; });
  heightInput.addEventListener('input', () => { heightOverridden = heightInput.value.trim() !== ''; });

  return { update, hide, sync };
}
