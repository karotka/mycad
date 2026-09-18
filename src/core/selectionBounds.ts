/**
 * Where the current selection sits in the drawing.
 *
 * The camera orbits about a point, and until now that point was wherever the
 * view happened to have left it — the default box near the origin, for a
 * drawing that had never been framed. Turning the view around something you
 * had just selected therefore swung it off the screen. This is the point to
 * turn about instead: the middle of what is selected.
 *
 * Entity bounds come back in the entity's own work plane, so each is carried
 * out to world before being taken into account; a solid's and a surface's
 * mesh is already there.
 */
import { entityBounds, type Entity, type Solid, type Surface } from './entities/types';
import { localToWorld, WORLD_WORK_PLANE } from '../math/workplane';
import type { Vec3 } from '../math/geometry';

export interface WorldBounds {
  min: Vec3;
  max: Vec3;
}

/** The world-space box around everything given, or null when nothing was. */
export function worldBoundsOf(
  entities: readonly Entity[],
  solids: readonly Solid[],
  surfaces: readonly Surface[],
): WorldBounds | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;
  const cover = (point: Vec3): void => {
    any = true;
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  };
  for (const entity of entities) {
    const bounds = entityBounds(entity);
    const plane = entity.workPlane ?? WORLD_WORK_PLANE;
    // All four corners, not just two: a plane turned in its own right maps a
    // box to a box standing at an angle, whose extent the opposite corners
    // alone do not describe.
    for (const corner of [
      { x: bounds.min.x, y: bounds.min.y },
      { x: bounds.max.x, y: bounds.min.y },
      { x: bounds.max.x, y: bounds.max.y },
      { x: bounds.min.x, y: bounds.max.y },
    ]) cover(localToWorld(plane, corner));
  }
  for (const body of [...solids, ...surfaces]) {
    const positions = body.mesh.positions;
    for (let index = 0; index + 2 < positions.length; index += 3) {
      cover({ x: positions[index], y: positions[index + 1], z: positions[index + 2] });
    }
  }
  return any ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } : null;
}

/** The middle of that box, which is what a view turns about. */
export function centerOfWorldBounds(bounds: WorldBounds): Vec3 {
  return {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
}
