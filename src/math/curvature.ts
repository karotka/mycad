import type { Vec2 } from './geometry';

/**
 * The tightest bend along a sampled curve, as a radius.
 *
 * Every consecutive triple of samples has one circle through it; the smallest
 * of those radii is where the curve turns hardest. Straight runs contribute
 * nothing (three points in a line have no circle) and are skipped, so a
 * perfectly straight path has no answer at all rather than an infinite one.
 *
 * Why it matters: a pipe swept along a path folds through itself wherever the
 * profile reaches further than the bend it is going round, and the result is
 * a solid the kernel reports as invalid without saying why. This is what
 * turns that into a sentence with numbers in it.
 */
export function minimumCurvatureRadius(points: readonly Vec2[]): number | null {
  let tightest: number | null = null;
  for (let index = 1; index + 1 < points.length; index++) {
    const a = points[index - 1], b = points[index], c = points[index + 1];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    // Twice the triangle's area, via the cross product of two of its sides.
    const twiceArea = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
    if (twiceArea < 1e-12) continue; // collinear: no bend here
    const radius = (ab * bc * ca) / (2 * twiceArea);
    if (tightest === null || radius < tightest) tightest = radius;
  }
  return tightest;
}
