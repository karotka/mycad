/**
 * An entity reduced to the lines you would draw it with.
 *
 * The renderer, the solid engine and now the G-code exporter all need this, and
 * each had started writing its own: the old mesh kernel had two private ones between
 * them covering six of the ten entity types. This is the one that has to be
 * complete, because a missing case here is geometry silently left out of a cut
 * file rather than something that merely looks wrong on screen.
 */
import { dimensionGeometry, expandedInsertEntities, type Entity } from './types';
import { canonicalEntityPaths, dimensionGeometryPaths, type EntityPath } from './EntityGeometry';

export type { EntityPath } from './EntityGeometry';

/**
 * Empty for an entity that has no outline a tool could follow. TEXT is the one
 * that matters: its glyphs are filled shapes drawn by the font, and a single
 * stroke through them needs an engraving font we do not have yet. Callers are
 * expected to report what they dropped rather than pass over it quietly.
 */
export function entityToPaths(entity: Entity, segments = 64): EntityPath[] {
  switch (entity.type) {
    case 'insert':
      return expandedInsertEntities(entity).flatMap((child) => entityToPaths(child, segments));
    case 'point':
      return [];
    case 'leader':
      return canonicalEntityPaths(entity);
    case 'line':
      return canonicalEntityPaths(entity);
    case 'polyline':
      return canonicalEntityPaths(entity);
    case 'rectangle':
      return canonicalEntityPaths(entity);
    case 'octagon':
      return canonicalEntityPaths(entity);
    case 'mline':
      return canonicalEntityPaths(entity);
    case 'circle': {
      return canonicalEntityPaths(entity, segments);
    }
    case 'ellipse':
      return canonicalEntityPaths(entity, segments);
    case 'arc':
    case 'bezier':
      return canonicalEntityPaths(entity, segments);
    case 'hatch':
      return canonicalEntityPaths(entity);
    case 'dimension': {
      // Drawn, not cut — but a plotter putting a drawing on paper wants it, and
      // it is made of lines like everything else. The arrowheads are outlines.
      return dimensionGeometryPaths(dimensionGeometry(entity));
    }
    case 'text':
      return canonicalEntityPaths(entity);
  }
}
