/**
 * What a left click in the viewport should do, once it is known what lies under
 * it. Deciding this apart from doing it keeps the order of the rules — which is
 * the part that is easy to get wrong — in something tests can pin down.
 */

export interface ViewportPick {
  /** A command owns the click: it feeds the command rather than selecting. */
  commandActive: boolean;
  /** The active step gathers a set of objects, so an empty click drags a rectangle. */
  multiObjectStep: boolean;
  /** Index of the selection's grip under the cursor, or -1. */
  gripIndex: number;
  /** Something is selected, so its grips are on screen to be grabbed. */
  hasSelection: boolean;
  entityHit: boolean;
  solidHit: boolean;
  /** Whether this view can drag a selection rectangle. */
  canWindowSelect: boolean;
}

export type ViewportAction =
  | { kind: 'dragGrip' }
  | { kind: 'windowSelect' }
  | { kind: 'commandClick' }
  | { kind: 'selectEntity' }
  | { kind: 'selectSolid' }
  | { kind: 'clearSelection' };

/**
 * A grip belongs to the selection and outranks everything under the cursor — but
 * only when no command is running, since then the click is the command's.
 *
 * Separate because it needs nothing picked: the 3D view asks before raycasting,
 * to skip the work when the answer cannot change.
 */
export function grabsGrip(pick: Pick<ViewportPick, 'commandActive' | 'gripIndex' | 'hasSelection'>): boolean {
  return !pick.commandActive && pick.gripIndex >= 0 && pick.hasSelection;
}

export function resolveViewportAction(pick: ViewportPick): ViewportAction {
  if (grabsGrip(pick)) return { kind: 'dragGrip' };

  // Missing everything while gathering objects starts a rectangle, rather than
  // handing the command a click that picked nothing.
  if (pick.canWindowSelect && pick.multiObjectStep && !pick.entityHit && !pick.solidHit) {
    return { kind: 'windowSelect' };
  }

  if (pick.commandActive) return { kind: 'commandClick' };
  // An entity in front of a solid wins: it is the smaller thing to have meant.
  if (pick.entityHit) return { kind: 'selectEntity' };
  if (pick.solidHit) return { kind: 'selectSolid' };
  return pick.canWindowSelect ? { kind: 'windowSelect' } : { kind: 'clearSelection' };
}
