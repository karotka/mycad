import { rotatePoint, type Vec2 } from '../../math/geometry';
import { cloneEntity, transformEntityPoints, type Entity, type PolylineEntity } from './types';

/**
 * Rotate a drawing entity within its work plane.
 *
 * Point storage is handled by the same mapper used by MOVE, COPY and MIRROR.
 * The switch contains only orientation metadata that point mapping cannot
 * infer. Commands and live previews therefore share one entity interpretation.
 */
export function rotateEntity(entity: Entity, base: Vec2, angle: number): Entity {
  if (entity.type === 'rectangle') {
    const source = cloneEntity(entity);
    const { first, opposite, ...properties } = source;
    const corners = [
      first,
      { x: opposite.x, y: first.y },
      opposite,
      { x: first.x, y: opposite.y },
    ];
    return {
      ...properties,
      type: 'polyline',
      vertices: corners.map((point) => rotatePoint(point, base, angle)),
      closed: true,
    } as PolylineEntity;
  }

  const result = transformEntityPoints(entity, (point) => rotatePoint(point, base, angle));
  switch (result.type) {
    case 'ellipse': result.rotation += angle; break;
    case 'arc': result.startAngle += angle; break;
    case 'hatch':
      result.angle += angle * 180 / Math.PI;
      result.patternLines = result.patternLines.map((line) => ({
        ...line,
        angle: line.angle + angle,
        offset: rotatePoint(line.offset, { x: 0, y: 0 }, angle),
      }));
      break;
    case 'text': result.rotation = (result.rotation ?? 0) + angle; break;
    case 'dimension':
      if (result.rotation !== undefined) result.rotation += angle;
      break;
    case 'insert': result.rotation += angle; break;
  }
  return result;
}
