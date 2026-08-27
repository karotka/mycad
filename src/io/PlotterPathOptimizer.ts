import type { Vec2 } from '../math/geometry';

export interface PlotterPath {
  points: Vec2[];
  closed: boolean;
}

/**
 * Joins paths which share an end point, then orders the resulting pen strokes
 * by their nearest end. Reversing an open path is safe for a plotter and often
 * avoids both a pen lift and a long rapid move.
 */
export function optimizePlotterPaths(paths: readonly PlotterPath[], tolerance = 1e-6): PlotterPath[] {
  const remaining = paths
    .filter((path) => path.points.length >= 2)
    .map((path) => ({ points: path.points.map((point) => ({ ...point })), closed: path.closed }));
  const strokes: PlotterPath[] = [];

  while (remaining.length > 0) {
    const stroke = remaining.shift()!;
    if (!stroke.closed) extendStroke(stroke, remaining, tolerance);
    strokes.push(stroke);
  }

  return orderByNearestEnd(strokes);
}

function extendStroke(stroke: PlotterPath, remaining: PlotterPath[], tolerance: number): void {
  while (true) {
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];
    let match: { index: number; atStart: boolean; reverse: boolean } | undefined;

    for (let index = 0; index < remaining.length && !match; index++) {
      const candidate = remaining[index];
      if (candidate.closed) continue;
      const a = candidate.points[0];
      const b = candidate.points[candidate.points.length - 1];
      if (near(last, a, tolerance)) match = { index, atStart: false, reverse: false };
      else if (near(last, b, tolerance)) match = { index, atStart: false, reverse: true };
      else if (near(first, b, tolerance)) match = { index, atStart: true, reverse: false };
      else if (near(first, a, tolerance)) match = { index, atStart: true, reverse: true };
    }

    if (!match) break;
    const [candidate] = remaining.splice(match.index, 1);
    const points = match.reverse ? [...candidate.points].reverse() : candidate.points;
    if (match.atStart) stroke.points.unshift(...points.slice(0, -1));
    else stroke.points.push(...points.slice(1));
    if (near(stroke.points[0], stroke.points[stroke.points.length - 1], tolerance)) {
      stroke.points.pop();
      stroke.closed = true;
      break;
    }
  }
}

function orderByNearestEnd(paths: PlotterPath[]): PlotterPath[] {
  if (paths.length < 2) return paths;
  const ordered: PlotterPath[] = [];
  let cursor: Vec2 | undefined;
  while (paths.length > 0) {
    let bestIndex = 0;
    let reverse = false;
    let bestDistance = Infinity;
    for (let index = 0; index < paths.length; index++) {
      const path = paths[index];
      const start = path.points[0];
      const end = path.points[path.points.length - 1];
      const startDistance = cursor ? squaredDistance(cursor, start) : 0;
      if (startDistance < bestDistance) {
        bestIndex = index; reverse = false; bestDistance = startDistance;
      }
      if (!path.closed && cursor) {
        const endDistance = squaredDistance(cursor, end);
        if (endDistance < bestDistance) {
          bestIndex = index; reverse = true; bestDistance = endDistance;
        }
      }
    }
    const [next] = paths.splice(bestIndex, 1);
    if (reverse) next.points.reverse();
    ordered.push(next);
    cursor = next.closed ? next.points[0] : next.points[next.points.length - 1];
  }
  return ordered;
}

function near(a: Vec2, b: Vec2, tolerance: number): boolean {
  return squaredDistance(a, b) <= tolerance * tolerance;
}

function squaredDistance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
