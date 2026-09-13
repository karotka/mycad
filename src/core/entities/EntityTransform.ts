import { rotatePoint, type Vec2 } from '../../math/geometry';
import { cloneEntity, transformEntityPoints, type Entity, type PolylineEntity } from './types';

/** Uniformly scale a drawing entity about a point in its work plane. */
export function scaleEntity(entity: Entity, base: Vec2, factor: number): Entity {
  const magnitude = Math.abs(factor);
  const scaled = transformEntityPoints(entity, (point) => {
    const elevation = (point as Vec2 & { z?: number }).z;
    return {
      x: base.x + (point.x - base.x) * factor,
      y: base.y + (point.y - base.y) * factor,
      ...(elevation === undefined ? {} : { z: elevation * factor }),
    } as Vec2;
  });

  switch (scaled.type) {
    case 'circle':
    case 'arc':
    case 'octagon':
      scaled.radius *= magnitude;
      break;
    case 'ellipse':
      scaled.radiusX *= magnitude;
      scaled.radiusY *= magnitude;
      break;
    case 'mline':
      scaled.elements = scaled.elements.map((element) => ({ ...element, offset: element.offset * magnitude }));
      break;
    case 'hatch':
      scaled.spacing *= magnitude;
      scaled.patternLines = scaled.patternLines.map((line) => ({
        ...line,
        angle: line.angle + (factor < 0 ? Math.PI : 0),
        offset: { x: line.offset.x * factor, y: line.offset.y * factor },
      }));
      if (factor < 0) scaled.angle += 180;
      break;
    case 'text':
      scaled.height *= magnitude;
      break;
    case 'dimension':
      scaled.scale *= magnitude;
      break;
    case 'insert':
      scaled.scaleZ *= factor;
      break;
  }
  return scaled;
}

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
