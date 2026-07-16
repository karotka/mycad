import type { Vec2 } from '../math/geometry';

/** A polyline vertex as DXF stores it: a point plus the bulge of the segment leaving it. */
export interface BulgeVertex extends Vec2 {
  bulge: number;
}

/**
 * DXF encodes an arc inside a polyline as a `bulge` on the segment's first
 * vertex: bulge = tan(θ/4), where θ is the arc's included angle and a positive
 * value turns counter-clockwise. Our PolylineEntity only holds straight
 * segments, so the arc has to be expanded into vertices — dropping the bulge,
 * as the import used to, silently replaces the arc with a chord.
 */
export function expandBulges(
  vertices: readonly BulgeVertex[],
  closed: boolean,
  segmentAngle = Math.PI / 16,
): { points: Vec2[]; arcs: number } {
  const points: Vec2[] = [];
  let arcs = 0;
  const segments = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < segments; index++) {
    const from = vertices[index];
    const to = vertices[(index + 1) % vertices.length];
    points.push({ x: from.x, y: from.y });
    const interior = arcInteriorPoints(from, to, from.bulge, segmentAngle);
    if (interior.length > 0) arcs++;
    points.push(...interior);
  }
  if (!closed) {
    const last = vertices[vertices.length - 1];
    points.push({ x: last.x, y: last.y });
  }
  return { points, arcs };
}

/** The points strictly between `from` and `to` along the bulge arc. */
function arcInteriorPoints(from: Vec2, to: Vec2, bulge: number, segmentAngle: number): Vec2[] {
  if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-9) return [];
  const chord = Math.hypot(to.x - from.x, to.y - from.y);
  if (chord < 1e-12) return [];

  const theta = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // The centre sits on the perpendicular bisector of the chord; the signed
  // apothem puts it on the correct side for the arc's direction.
  const ux = (to.x - from.x) / chord;
  const uy = (to.y - from.y) / chord;
  const apothem = radius * Math.cos(theta / 2);
  const centre = {
    x: (from.x + to.x) / 2 - uy * apothem,
    y: (from.y + to.y) / 2 + ux * apothem,
  };

  const startAngle = Math.atan2(from.y - centre.y, from.x - centre.x);
  const count = Math.max(1, Math.ceil(Math.abs(theta) / segmentAngle));
  const points: Vec2[] = [];
  for (let step = 1; step < count; step++) {
    const angle = startAngle + (theta * step) / count;
    points.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
  }
  return points;
}
