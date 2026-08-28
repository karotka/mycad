import type { Vec2 } from './geometry';

export interface CubicBezierFit { start: Vec2; control1: Vec2; control2: Vec2; end: Vec2 }

/** Fits one or more cubic Beziers to sampled points within the requested error. */
export function fitCubicBeziers(input: readonly Vec2[], tolerance: number): CubicBezierFit[] {
  const points = input.filter((point, index) => index === 0 || distance(point, input[index - 1]) > 1e-12);
  return points.length < 2 ? [] : fitRange(points, Math.max(tolerance, 1e-9), 0);
}

function fitRange(points: Vec2[], tolerance: number, depth: number): CubicBezierFit[] {
  if (points.length === 2) return [straightBezier(points[0], points[1])];
  const parameters = chordParameters(points);
  const curve = leastSquaresCurve(points, parameters);
  let worstIndex = 1, worstError = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const error = distance(points[index], cubicPoint(curve, parameters[index]));
    if (error > worstError) { worstError = error; worstIndex = index; }
  }
  if (worstError <= tolerance || depth >= 24) return [curve];
  return [...fitRange(points.slice(0, worstIndex + 1), tolerance, depth + 1), ...fitRange(points.slice(worstIndex), tolerance, depth + 1)];
}

function chordParameters(points: Vec2[]): number[] {
  const result = [0];
  for (let index = 1; index < points.length; index++) result.push(result[index - 1] + distance(points[index], points[index - 1]));
  const total = result[result.length - 1];
  return total > 0 ? result.map((value) => value / total) : result;
}

function leastSquaresCurve(points: Vec2[], parameters: number[]): CubicBezierFit {
  const start = points[0], end = points[points.length - 1];
  let aa = 0, ab = 0, bb = 0, ax = 0, ay = 0, bx = 0, by = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const t = parameters[index], u = 1 - t;
    const b0 = u ** 3, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t ** 3;
    const rx = points[index].x - b0 * start.x - b3 * end.x;
    const ry = points[index].y - b0 * start.y - b3 * end.y;
    aa += b1 * b1; ab += b1 * b2; bb += b2 * b2;
    ax += b1 * rx; ay += b1 * ry; bx += b2 * rx; by += b2 * ry;
  }
  const determinant = aa * bb - ab * ab;
  if (Math.abs(determinant) < 1e-12) return straightBezier(start, end);
  return {
    start: { ...start },
    control1: { x: (ax * bb - bx * ab) / determinant, y: (ay * bb - by * ab) / determinant },
    control2: { x: (bx * aa - ax * ab) / determinant, y: (by * aa - ay * ab) / determinant },
    end: { ...end },
  };
}

/**
 * One cubic Bezier segment per pair of consecutive points, always passing
 * exactly through every one of them with a continuous tangent (Catmull-Rom).
 *
 * Unlike `fitCubicBeziers`, which is free to redraw its segment boundaries
 * across the *whole* point set to keep their count down, each segment here
 * depends only on its own two immediate neighbours on either side. Appending
 * one more point to the chain reshapes at most the segment next to it —
 * everything already drawn stays exactly as it was, which matters for a
 * spline built by clicking one point at a time.
 */
export function interpolatingBeziers(input: readonly Vec2[]): CubicBezierFit[] {
  const points = input.filter((point, index) => index === 0 || distance(point, input[index - 1]) > 1e-12);
  if (points.length < 2) return [];
  const tangentAt = (index: number): Vec2 => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    return { x: (next.x - previous.x) / 2, y: (next.y - previous.y) / 2 };
  };
  const segments: CubicBezierFit[] = [];
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index], end = points[index + 1];
    const startTangent = tangentAt(index), endTangent = tangentAt(index + 1);
    segments.push({
      start: { ...start },
      control1: { x: start.x + startTangent.x / 3, y: start.y + startTangent.y / 3 },
      control2: { x: end.x - endTangent.x / 3, y: end.y - endTangent.y / 3 },
      end: { ...end },
    });
  }
  return segments;
}

function straightBezier(start: Vec2, end: Vec2): CubicBezierFit {
  return { start: { ...start }, control1: { x: start.x + (end.x - start.x) / 3, y: start.y + (end.y - start.y) / 3 }, control2: { x: start.x + 2 * (end.x - start.x) / 3, y: start.y + 2 * (end.y - start.y) / 3 }, end: { ...end } };
}

function cubicPoint(curve: CubicBezierFit, t: number): Vec2 {
  const u = 1 - t, b0 = u ** 3, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t ** 3;
  return { x: b0 * curve.start.x + b1 * curve.control1.x + b2 * curve.control2.x + b3 * curve.end.x, y: b0 * curve.start.y + b1 * curve.control1.y + b2 * curve.control2.y + b3 * curve.end.y };
}

function distance(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y); }
