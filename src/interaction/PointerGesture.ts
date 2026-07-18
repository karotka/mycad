/**
 * What a press in the viewport means, before anything is done about it.
 *
 * A press says what gesture it starts, never what it will turn out to be: the
 * right button always pans, and only its release can say whether it moved far
 * enough to have been a pan rather than a click for the menu. Keeping the
 * decision here, apart from the doing, makes that order testable.
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
}

export type PointerGesture =
  /** Not ours: let it be. */
  | { kind: 'ignore' }
  /** Drag out a rectangle to zoom to. */
  | { kind: 'zoomWindow' }
  /** Might become an orbit — Viewport3D decides once the pointer really moves. */
  | { kind: 'orbit' }
  /**
   * `opensMenuIfStill` marks the right button: it pans, and a press that pans
   * nowhere turns out to have been a click for the context menu. Which it was is
   * known on release, not now — deciding it from what lies under the cursor is
   * what used to make panning impossible over a selected object.
   */
  | { kind: 'pan'; opensMenuIfStill: boolean }
  /** The ordinary left-click path: pick, draw, drag a grip. */
  | { kind: 'interact' };

export function resolvePointerGesture(input: PointerGestureInput): PointerGesture {
  if (input.onViewToggle) return { kind: 'ignore' };
  if (input.zoomWindowArmed && input.button === 0) return { kind: 'zoomWindow' };
  if (input.button === 0 && input.metaKey) return { kind: 'orbit' };

  // The right button is always live: it pans on a drag and opens the context
  // menu on a still click — including mid-command and mid-grip-drag, where that
  // menu is the only way to choose an object snap. Swallowing it there left
  // drawing without snaps, which is what "the right button does nothing" was.
  if (input.button === 2) return { kind: 'pan', opensMenuIfStill: true };

  if (input.button === 1 || (input.button === 0 && input.altKey)) {
    return { kind: 'pan', opensMenuIfStill: false };
  }
  if (input.button !== 0) return { kind: 'ignore' };
  return { kind: 'interact' };
}
