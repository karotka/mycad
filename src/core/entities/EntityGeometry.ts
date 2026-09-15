import type { Vec2 } from '../../math/geometry';
import { polylineOutline } from './polylineArcs';
import type { LineEntity, PolylineEntity } from './types';

export interface EntityPath {
  points: Vec2[];
  /** The last point joins back to the first; callers choose how to render it. */
  closed: boolean;
}

export interface EntityBounds {
  min: Vec2;
  max: Vec2;
}

export type CanonicalPathEntity = LineEntity | PolylineEntity;

/** Canonical display/picking/export paths for the first migrated entity set. */
export function canonicalEntityPaths(entity: CanonicalPathEntity): EntityPath[] {
  if (entity.type === 'line') return [{ points: [entity.start, entity.end], closed: false }];
  const points = [...polylineOutline(entity)];
  return points.length >= 2 ? [{ points, closed: entity.closed }] : [];
}

/** Bounds of a path collection, or null when it contains no points. */
export function boundsFromPaths(paths: readonly EntityPath[]): EntityBounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = false;
  for (const path of paths) {
    for (const point of path.points) {
      found = true;
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  return found ? { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } } : null;
}

/** Bounds derived from the same curved outline every consumer sees. */
export function canonicalEntityBounds(entity: CanonicalPathEntity): EntityBounds {
  return boundsFromPaths(canonicalEntityPaths(entity))
    ?? ('start' in entity
      ? { min: { ...entity.start }, max: { ...entity.start } }
      : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } });
}
