/**
 * An entity reduced to the lines you would draw it with.
 *
 * The renderer, the solid engine and now the G-code exporter all need this, and
 * each had started writing its own: ManifoldEngine has two private ones between
 * them covering six of the ten entity types. This is the one that has to be
 * complete, because a missing case here is geometry silently left out of a cut
 * file rather than something that merely looks wrong on screen.
 */
import { curvePoints, dimensionGeometry, ellipsePoints, type Entity } from './types';
import type { Vec2 } from '../../math/geometry';

export interface EntityPath {
  points: Vec2[];
  /** The last point joins back to the first; the caller decides how to say so. */
  closed: boolean;
}

/**
 * Empty for an entity that has no outline a tool could follow. TEXT is the one
 * that matters: its glyphs are filled shapes drawn by the font, and a single
 * stroke through them needs an engraving font we do not have yet. Callers are
 * expected to report what they dropped rather than pass over it quietly.
 */
export function entityToPaths(entity: Entity, segments = 64): EntityPath[] {
  switch (entity.type) {
    case 'line':
      return [{ points: [entity.start, entity.end], closed: false }];
    case 'polyline':
      return entity.vertices.length >= 2
        ? [{ points: [...entity.vertices], closed: entity.closed }]
        : [];
    case 'rectangle':
      return [{
        points: [
          entity.first,
          { x: entity.opposite.x, y: entity.first.y },
          entity.opposite,
          { x: entity.first.x, y: entity.opposite.y },
        ],
        closed: true,
      }];
    case 'octagon':
      return [{ points: [...entity.vertices], closed: true }];
    case 'circle': {
      const points: Vec2[] = [];
      for (let index = 0; index < segments; index++) {
        const angle = (Math.PI * 2 * index) / segments;
        points.push({
          x: entity.center.x + Math.cos(angle) * entity.radius,
          y: entity.center.y + Math.sin(angle) * entity.radius,
        });
      }
      return [{ points, closed: true }];
    }
    case 'ellipse':
      // Samples the loop with the first point repeated last, which `closed`
      // already says, so it is dropped rather than cut twice.
      return [{ points: ellipsePoints(entity, segments).slice(0, -1), closed: true }];
    case 'arc':
    case 'bezier':
      return [{ points: curvePoints(entity, segments), closed: false }];
    case 'dimension': {
      // Drawn, not cut — but a plotter putting a drawing on paper wants it, and
      // it is made of lines like everything else. The arrowheads are outlines.
      const geometry = dimensionGeometry(entity);
      const paths: EntityPath[] = [
        { points: [...geometry.extensionStart], closed: false },
        { points: [...geometry.extensionEnd], closed: false },
        { points: [...geometry.dimensionLine], closed: false },
        ...geometry.arrows.map((arrow) => ({ points: [...arrow], closed: true })),
      ];
      // A degenerate leg is a path of one repeated point: nothing to draw, and a
      // machine asked to draw it would still lower the tool and lift it again.
      return paths.filter((path) => hasLength(path.points));
    }
    case 'text':
      return [];
  }
}

function hasLength(points: Vec2[]): boolean {
  return points.some((point) => Math.abs(point.x - points[0].x) > 1e-9 || Math.abs(point.y - points[0].y) > 1e-9);
}
