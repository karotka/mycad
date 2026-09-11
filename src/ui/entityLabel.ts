import type { Entity } from '../core/entities/types';

/**
 * What to call an object in front of the user.
 *
 * `entity.type` is the internal tag and is not always the word the drawing
 * uses for the same thing — `bezier` is drawn with the SPLINE commands and is
 * "Spline" everywhere in the UI, `insert` is a block reference. Kept here, in
 * the UI layer, because it is vocabulary rather than geometry.
 */
export function entityTypeLabel(entity: Entity): string {
  switch (entity.type) {
    case 'bezier': return 'Spline';
    case 'insert': return 'Block reference';
    case 'mline': return 'Multiline';
    case 'polyline': return entity.closed ? 'Closed polyline' : 'Polyline';
    case 'octagon': return 'Octagon';
    case 'dimension': return 'Dimension';
    case 'hatch': return 'Hatch';
    case 'point': return 'Point';
    case 'line': return 'Line';
    case 'circle': return 'Circle';
    case 'arc': return 'Arc';
    case 'ellipse': return 'Ellipse';
    case 'rectangle': return 'Rectangle';
    case 'text': return 'Text';
  }
}
