import type { Vec2 } from '../math/geometry';

export interface SplineData {
  degree: number;
  controlPoints: Vec2[];
  knots: number[];
  /** Rational splines carry a weight per control point; most drawings have none. */
  weights?: number[];
  closed: boolean;
}

/**
 * A DXF SPLINE is a NURBS curve. Our BezierEntity is a single cubic, which fits
 * exactly only when the spline is one cubic segment — degree 3, four control
 * points, no weights. Everything else has to be evaluated and kept as a
 * polyline, which is an approximation and must be reported as one.
 */
export function isSingleCubic(spline: SplineData): boolean {
  return spline.degree === 3
    && spline.controlPoints.length === 4
    && !spline.closed
    && !hasWeights(spline);
}

function hasWeights(spline: SplineData): boolean {
  return Boolean(spline.weights?.some((weight) => Math.abs(weight - 1) > 1e-9));
}

/** Samples the curve, including both ends. Returns [] when the spline is unusable. */
export function sampleSpline(spline: SplineData, samplesPerSegment = 12): Vec2[] {
  const { degree, controlPoints } = spline;
  if (degree < 1 || controlPoints.length <= degree) return [];
  if (degree === 1) return controlPoints.map((point) => ({ ...point }));

  const knots = usableKnots(spline);
  if (!knots) return [];
  const first = knots[degree];
  const last = knots[controlPoints.length];
  if (!(last > first)) return [];

  const spans = controlPoints.length - degree;
  const steps = Math.max(2, spans * samplesPerSegment);
  const points: Vec2[] = [];
  for (let step = 0; step <= steps; step++) {
    // Nudge the final sample inside the domain: t === last falls outside the
    // last span and de Boor would index past the end.
    const t = step === steps ? last - (last - first) * 1e-9 : first + ((last - first) * step) / steps;
    points.push(deBoor(t, spline, knots));
  }
  return points;
}

/** A knot vector is only usable if it has the length the curve implies. */
function usableKnots(spline: SplineData): number[] | null {
  const expected = spline.controlPoints.length + spline.degree + 1;
  if (spline.knots.length === expected) return spline.knots;
  // Some writers omit the knots; a clamped uniform vector is the standard default.
  const knots: number[] = [];
  const spans = spline.controlPoints.length - spline.degree;
  for (let index = 0; index < expected; index++) {
    if (index <= spline.degree) knots.push(0);
    else if (index >= spline.controlPoints.length) knots.push(spans);
    else knots.push(index - spline.degree);
  }
  return knots;
}

function deBoor(t: number, spline: SplineData, knots: number[]): Vec2 {
  const { degree, controlPoints, weights } = spline;
  let span = degree;
  while (span < controlPoints.length - 1 && knots[span + 1] <= t) span++;

  // Work in homogeneous coordinates so rational splines come out right.
  const points: Array<{ x: number; y: number; w: number }> = [];
  for (let index = 0; index <= degree; index++) {
    const control = controlPoints[span - degree + index];
    const weight = weights?.[span - degree + index] ?? 1;
    points.push({ x: control.x * weight, y: control.y * weight, w: weight });
  }

  for (let round = 1; round <= degree; round++) {
    for (let index = degree; index >= round; index--) {
      const knotIndex = span - degree + index;
      const span0 = knots[knotIndex + degree - round + 1] - knots[knotIndex];
      const alpha = Math.abs(span0) < 1e-12 ? 0 : (t - knots[knotIndex]) / span0;
      const a = points[index - 1];
      const b = points[index];
      points[index] = {
        x: a.x * (1 - alpha) + b.x * alpha,
        y: a.y * (1 - alpha) + b.y * alpha,
        w: a.w * (1 - alpha) + b.w * alpha,
      };
    }
  }

  const result = points[degree];
  const weight = Math.abs(result.w) < 1e-12 ? 1 : result.w;
  return { x: result.x / weight, y: result.y / weight };
}
