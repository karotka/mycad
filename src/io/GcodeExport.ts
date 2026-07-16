/**
 * G-code for a machine that drags one tool around the XY plane — a plotter, a
 * laser, a router. Every visible layer becomes one pass, and the passes come out
 * in the order the layers are in, which is the order the layer panel shows and
 * lets you drag.
 *
 * Pure on purpose: a cut file is the one output nobody can eyeball for
 * correctness, so it is worth being able to assert on to the character.
 */
import { entityToPaths } from '../core/entities/paths';
import type { Document } from '../core/Document';
import type { Entity } from '../core/entities/types';
import { localToWorld, WORLD_WORK_PLANE } from '../math/workplane';
import type { Vec2 } from '../math/geometry';
import type { GcodeOptions } from '../core/settings';

export interface GcodeResult {
  gcode: string;
  /** Layers written, in the order they came out. */
  layers: string[];
  /**
   * Entity types with no outline to follow, and how many were left behind. The
   * caller is expected to say so: silence here reads as a complete file.
   */
  skipped: Record<string, number>;
  /**
   * Entities lying off the world XY plane. A three-axis machine owns Z, so their
   * height cannot be honoured and dropping them beats cutting them flat in the
   * wrong place.
   */
  offPlane: number;
  moveCount: number;
}

export function exportGcode(doc: Document, options: GcodeOptions = doc.gcode): GcodeResult {
  const lines: string[] = [
    '; MyCAD G-code',
    'G21 ; mm',
    'G90 ; absolute',
    'G28 ; home',
    `G0 Z${format(options.safeHeight)} F${format(options.travelRate)}`,
  ];
  const skipped: Record<string, number> = {};
  const written: string[] = [];
  let offPlane = 0;
  let moveCount = 0;

  // Layer order is pass order, so this walks doc.layers rather than doc.entities:
  // the entity list is creation order and has nothing to say about it.
  for (const layer of doc.layers) {
    if (doc.hiddenLayers.has(layer)) continue;
    const entities = doc.entities.filter((entity) => entity.layer === layer);
    if (entities.length === 0) continue;

    const passes: string[] = [];
    for (const entity of entities) {
      const paths = entityToPaths(entity, options.segments);
      if (paths.length === 0) {
        skipped[entity.type] = (skipped[entity.type] ?? 0) + 1;
        continue;
      }
      const flat = toWorldXY(entity, paths);
      if (!flat) { offPlane++; continue; }
      for (const path of flat) {
        if (path.points.length < 2) continue;
        const points = path.closed ? [...path.points, path.points[0]] : path.points;
        passes.push(`G0 X${format(points[0].x)} Y${format(points[0].y)}`);
        passes.push(`G1 Z${format(options.cutDepth)} F${format(options.feedRate)}`);
        for (const point of points.slice(1)) {
          passes.push(`G1 X${format(point.x)} Y${format(point.y)} F${format(options.feedRate)}`);
          moveCount++;
        }
        passes.push(`G0 Z${format(options.safeHeight)} F${format(options.travelRate)}`);
      }
    }
    if (passes.length === 0) continue;
    lines.push(`; --- layer: ${layer} ---`, ...passes);
    written.push(layer);
  }

  lines.push('G0 Z' + format(options.safeHeight), 'M2 ; end');
  return { gcode: lines.join('\n') + '\n', layers: written, skipped, offPlane, moveCount };
}

/**
 * Entity points are local to the work plane they were drawn on, so they are put
 * back into the world before anything is written — that is what makes the file
 * agree with the coordinate system on screen. A plane parallel to the world's
 * still lands on Z = 0 and is fine; a tilted one is not, and says so.
 */
function toWorldXY(entity: Entity, paths: ReturnType<typeof entityToPaths>): Array<{ points: Vec2[]; closed: boolean }> | null {
  const plane = entity.workPlane ?? WORLD_WORK_PLANE;
  const flattened: Array<{ points: Vec2[]; closed: boolean }> = [];
  for (const path of paths) {
    const points: Vec2[] = [];
    for (const point of path.points) {
      const world = localToWorld(plane, point, 0);
      if (Math.abs(world.z) > 1e-6) return null;
      points.push({ x: world.x, y: world.y });
    }
    flattened.push({ points, closed: path.closed });
  }
  return flattened;
}

/** Trailing zeroes make a file that is mostly noise; three decimals is a micron. */
function format(value: number): string {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}
