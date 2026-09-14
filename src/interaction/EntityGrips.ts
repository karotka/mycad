import { cloneEntity, type Entity } from '../core/entities/types';
import type { Vec2 } from '../math/geometry';

export type EntityGrip = {
  point: Vec2 & { z?: number };
  index: number;
  shape?: 'square' | 'edge';
  angle?: number;
};

const pointWithElevation = (cursor: Vec2 & { z?: number }, original: Vec2): Vec2 => {
  const z = cursor.z ?? (original as Vec2 & { z?: number }).z;
  return z === undefined ? { x: cursor.x, y: cursor.y } : { x: cursor.x, y: cursor.y, z } as Vec2;
};

/** Basic shape-editing grips shared by document entities and loft members. */
export function entityReshapeGrips(entity: Entity): EntityGrip[] | null {
  if (entity.type === 'line') return [
    { point: entity.start, index: 0, shape: 'square' },
    { point: entity.end, index: 1, shape: 'square' },
  ];
  if (entity.type === 'circle') {
    const z = (entity.center as Vec2 & { z?: number }).z;
    const grips: EntityGrip[] = [{ point: entity.center, index: 0, shape: 'square' }];
    for (let index = 0; index < 4; index++) {
      const angle = index * Math.PI / 2;
      const point = {
        x: entity.center.x + Math.cos(angle) * entity.radius,
        y: entity.center.y + Math.sin(angle) * entity.radius,
      };
      grips.push({ point: z === undefined ? point : { ...point, z }, index: index + 1, shape: 'square' });
    }
    return grips;
  }
  if (entity.type === 'polyline') {
    const vertices = entity.closed ? entity.vertices.slice(0, -1) : entity.vertices;
    return vertices.map((point, index) => ({ point, index, shape: 'square' }));
  }
  if (entity.type === 'bezier') {
    const points = [entity.start, ...entity.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end])];
    return points.map((point, index) => ({ point, index, shape: 'square' }));
  }
  if (entity.type === 'arc') {
    const z = (entity.center as Vec2 & { z?: number }).z;
    const point = (angle: number): Vec2 => {
      const flat = {
        x: entity.center.x + Math.cos(angle) * entity.radius,
        y: entity.center.y + Math.sin(angle) * entity.radius,
      };
      return z === undefined ? flat : { ...flat, z } as Vec2;
    };
    return [
      { point: entity.center, index: 0, shape: 'square' },
      { point: point(entity.startAngle), index: 1, shape: 'square' },
      { point: point(entity.startAngle + entity.sweepAngle), index: 2, shape: 'square' },
    ];
  }
  return null;
}

/** Apply one of entityReshapeGrips' indices, preserving optional elevation. */
export function reshapeEntityAtGrip(
  original: Entity,
  gripIndex: number,
  cursor: Vec2 & { z?: number },
  dx: number,
  dy: number,
): Entity | null {
  const entity = cloneEntity(original);
  if (entity.type === 'line' && original.type === 'line') {
    if (gripIndex === 0) entity.start = pointWithElevation(cursor, original.start);
    else if (gripIndex === 1) entity.end = pointWithElevation(cursor, original.end);
    else return null;
    return entity;
  }
  if (entity.type === 'circle' && original.type === 'circle') {
    if (gripIndex === 0) entity.center = pointWithElevation({ x: original.center.x + dx, y: original.center.y + dy }, original.center);
    else entity.radius = Math.max(0.0001, Math.hypot(cursor.x - original.center.x, cursor.y - original.center.y));
    return entity;
  }
  if (entity.type === 'polyline' && original.type === 'polyline') {
    const oldPoint = original.vertices[gripIndex];
    if (!oldPoint) return null;
    const point = pointWithElevation(cursor, oldPoint);
    entity.vertices[gripIndex] = point;
    if (entity.closed && gripIndex === 0) entity.vertices[entity.vertices.length - 1] = { ...point };
    return entity;
  }
  if (entity.type === 'bezier' && original.type === 'bezier') {
    const points = [original.start, ...original.segments.flatMap((segment) => [segment.control1, segment.control2, segment.end])];
    const oldPoint = points[gripIndex];
    if (!oldPoint) return null;
    const point = pointWithElevation(cursor, oldPoint);
    if (gripIndex === 0) entity.start = point;
    else {
      const segment = entity.segments[Math.floor((gripIndex - 1) / 3)];
      if (!segment) return null;
      const field = (gripIndex - 1) % 3;
      if (field === 0) segment.control1 = point;
      else if (field === 1) segment.control2 = point;
      else segment.end = point;
    }
    return entity;
  }
  if (entity.type === 'arc' && original.type === 'arc') {
    if (gripIndex === 0) {
      entity.center = pointWithElevation({ x: original.center.x + dx, y: original.center.y + dy }, original.center);
      return entity;
    }
    if (gripIndex !== 1 && gripIndex !== 2) return null;
    const angle = Math.atan2(cursor.y - original.center.y, cursor.x - original.center.x);
    entity.radius = Math.max(0.001, Math.hypot(cursor.x - original.center.x, cursor.y - original.center.y));
    if (gripIndex === 1) {
      entity.startAngle = angle;
      let sweep = original.startAngle + original.sweepAngle - angle;
      while (sweep <= 0) sweep += Math.PI * 2;
      entity.sweepAngle = sweep;
    } else {
      let sweep = angle - original.startAngle;
      if (sweep <= 0) sweep += Math.PI * 2;
      entity.sweepAngle = sweep;
    }
    return entity;
  }
  return null;
}
