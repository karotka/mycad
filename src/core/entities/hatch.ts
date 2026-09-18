import type { Vec2 } from '../../math/geometry';
import type { HatchPatternLine } from './types';

const bounds = (loops: readonly Vec2[][]): { min: Vec2; max: Vec2 } => {
  const min = { x: Infinity, y: Infinity }, max = { x: -Infinity, y: -Infinity };
  for (const loop of loops) for (const point of loop) {
    min.x = Math.min(min.x, point.x); min.y = Math.min(min.y, point.y);
    max.x = Math.max(max.x, point.x); max.y = Math.max(max.y, point.y);
  }
  return { min, max };
};

function crossings(loops: readonly Vec2[][], point: Vec2, direction: Vec2): number[] {
  const result: number[] = [];
  for (const loop of loops) for (let index = 0; index < loop.length; index++) {
    const start = loop[index], end = loop[(index + 1) % loop.length];
    const edgeX = end.x - start.x, edgeY = end.y - start.y;
    const denominator = direction.x * edgeY - direction.y * edgeX;
    if (Math.abs(denominator) < 1e-12) continue;
    const relativeX = start.x - point.x, relativeY = start.y - point.y;
    const edgeT = (relativeX * direction.y - relativeY * direction.x) / denominator;
    if (edgeT < 0 || edgeT >= 1) continue;
    result.push((relativeX * edgeY - relativeY * edgeX) / denominator);
  }
  return result.sort((a, b) => a - b);
}

function familySegments(loops: readonly Vec2[][], line: HatchPatternLine, box: { min: Vec2; max: Vec2 }): Array<[Vec2, Vec2]> {
  const result: Array<[Vec2, Vec2]> = [];
  const direction = { x: Math.cos(line.angle), y: Math.sin(line.angle) };
  const normal = { x: -direction.y, y: direction.x };
  const perpendicularOffset = line.offset.x * normal.x + line.offset.y * normal.y;
  if (Math.hypot(line.offset.x, line.offset.y) < 1e-9 || Math.abs(perpendicularOffset) < 1e-6) return result;
  const corners = [box.min, { x: box.max.x, y: box.min.y }, box.max, { x: box.min.x, y: box.max.y }];
  let minimum = Infinity, maximum = -Infinity;
  for (const corner of corners) {
    const index = ((corner.x - line.base.x) * normal.x + (corner.y - line.base.y) * normal.y) / perpendicularOffset;
    minimum = Math.min(minimum, index); maximum = Math.max(maximum, index);
  }
  if (Math.ceil(maximum) - Math.floor(minimum) > 100000) return result;
  for (let index = Math.floor(minimum) - 1; index <= Math.ceil(maximum) + 1; index++) {
    const point = { x: line.base.x + index * line.offset.x, y: line.base.y + index * line.offset.y };
    const hits = crossings(loops, point, direction);
    for (let hit = 0; hit + 1 < hits.length; hit += 2) {
      if (hits[hit + 1] - hits[hit] < 1e-6) continue;
      result.push([
        { x: point.x + direction.x * hits[hit], y: point.y + direction.y * hits[hit] },
        { x: point.x + direction.x * hits[hit + 1], y: point.y + direction.y * hits[hit + 1] },
      ]);
    }
  }
  return result;
}

/** Renderer-independent hatch strokes clipped to outer loops and holes. */
export function hatchPatternSegments(loops: readonly Vec2[][], families: readonly HatchPatternLine[]): Array<[Vec2, Vec2]> {
  if (loops.length === 0 || families.length === 0) return [];
  const box = bounds(loops);
  if (!Number.isFinite(box.min.x) || !Number.isFinite(box.min.y)) return [];
  return families.flatMap((family) => familySegments(loops, family, box));
}
