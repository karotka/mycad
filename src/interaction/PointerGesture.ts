/**
 * What a press in the viewport means, before anything is done about it.
 *
 * The order these rules are tried in is load-bearing and not obvious — the right
 * button, for instance, runs the context-menu decision and then *falls through*
 * to panning. Keeping the decision here, apart from the doing, makes that order
 * something tests can pin down.
 */

export interface PointerGestureInput {
  /** 0 left, 1 middle, 2 right. */
  button: number;
  metaKey: boolean;
  altKey: boolean;
  /** The press landed on the 2D/3D view toggle, which handles itself. */
  onViewToggle: boolean;
  /** Zoom-window mode is armed and waiting for a rectangle. */
  zoomWindowArmed: boolean;
  /** A grip drag is latched, so it owns the next click. */
  gripLatched: boolean;
  /** A command is waiting for a point, so the right button must not steal it. */
  awaitingPoint: boolean;
  /** The right button came down over an object that is already selected. */
  overSelectedObject: boolean;
}

export type PointerGesture =
  /** Not ours: let it be. */
  | { kind: 'ignore' }
  /** Drag out a rectangle to zoom to. */
  | { kind: 'zoomWindow' }
  /** Might become an orbit — Viewport3D decides once the pointer really moves. */
  | { kind: 'orbit' }
  | { kind: 'pan'; suppressContextMenu: boolean }
  /** Right-click on something selected: its menu opens instead of a pan. */
  | { kind: 'objectMenu' }
  /** The ordinary left-click path: pick, draw, drag a grip. */
  | { kind: 'interact' };

export function resolvePointerGesture(input: PointerGestureInput): PointerGesture {
  if (input.onViewToggle) return { kind: 'ignore' };
  if (input.zoomWindowArmed && input.button === 0) return { kind: 'zoomWindow' };
  if (input.button === 0 && input.metaKey) return { kind: 'orbit' };

  if (input.button === 2) {
    // A latched grip or a pending point has already claimed the right button.
    if (input.gripLatched || input.awaitingPoint) return { kind: 'ignore' };
    if (input.overSelectedObject) return { kind: 'objectMenu' };
    // Otherwise the right button pans, and the menu it would have opened is
    // swallowed — the drag was the intent.
    return { kind: 'pan', suppressContextMenu: true };
  }

  if (input.button === 1 || (input.button === 0 && input.altKey)) {
    return { kind: 'pan', suppressContextMenu: false };
  }
  if (input.button !== 0) return { kind: 'ignore' };
  return { kind: 'interact' };
}
