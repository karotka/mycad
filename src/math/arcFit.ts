import type { Vec2 } from './geometry';

const TAU = Math.PI * 2;
const wrap = (angle: number): number => ((angle % TAU) + TAU) % TAU;

export interface ArcFromSagittaResult {
  center: Vec2;
  radius: number;
  startAngle: number;
  sweepAngle: number;
}

/** The chord's own perpendicular unit vector and midpoint, shared by every
 *  function below so they all agree on which side is "positive". */
function chordFrame(start: Vec2, end: Vec2): { mid: Vec2; nx: number; ny: number; half: number } | null {
  const dx = end.x - start.x, dy = end.y - start.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return null;
  return {
    mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    nx: -dy / chord,
    ny: dx / chord,
    half: chord / 2,
  };
}

/** `third`'s signed perpendicular distance from the chord — positive on
 *  whichever side `(nx, ny)` (rotate start→end by +90°) points toward. */
export function signedSagitta(start: Vec2, end: Vec2, third: Vec2): number {
  const frame = chordFrame(start, end);
  if (!frame) return 0;
  return (third.x - frame.mid.x) * frame.nx + (third.y - frame.mid.y) * frame.ny;
}

/** The point on the chord's perpendicular bisector at the given sagitta —
 *  the inverse of `signedSagitta`, so a typed radius can be turned back into
 *  a point and fed through the exact same path a live cursor position is. */
export function sagittaPoint(start: Vec2, end: Vec2, sagitta: number): Vec2 {
  const frame = chordFrame(start, end);
  if (!frame) return { ...start };
  return { x: frame.mid.x + frame.nx * sagitta, y: frame.mid.y + frame.ny * sagitta };
}

/**
 * The arc through `start` and `end` that bulges toward `third` — the classic
 * rubber-band arc drag: `third`'s perpendicular distance from the chord (its
 * sagitta) sets the radius, and which side of the chord it's on sets which
 * way the arc bulges. A small sagitta gives a gentle, large-radius arc; one
 * exceeding the resulting radius gives a major arc automatically, with no
 * separate mode needed to reach it. Null when `third` sits (near enough) on
 * the chord itself, or `start`/`end` coincide — no arc is determined yet.
 */
export function arcFromSagitta(start: Vec2, end: Vec2, third: Vec2): ArcFromSagittaResult | null {
  const frame = chordFrame(start, end);
  if (!frame) return null;
  const sagitta = signedSagitta(start, end, third);
  if (Math.abs(sagitta) < 1e-9) return null;
  const { mid, nx, ny, half } = frame;
  const signedRadius = (half * half + sagitta * sagitta) / (2 * sagitta);
  const radius = Math.abs(signedRadius);
  const k = sagitta - signedRadius;
  const center = { x: mid.x + nx * k, y: mid.y + ny * k };
  const apex = { x: mid.x + nx * sagitta, y: mid.y + ny * sagitta };
  const angleStart = Math.atan2(start.y - center.y, start.x - center.x);
  const angleEnd = Math.atan2(end.y - center.y, end.x - center.x);
  const angleApex = Math.atan2(apex.y - center.y, apex.x - center.x);
  const relEnd = wrap(angleEnd - angleStart);
  const relApex = wrap(angleApex - angleStart);
  // The direct CCW sweep from start to end doesn't necessarily pass through
  // the bulge (it only does when the apex's own CCW offset from start falls
  // within that sweep) — when it doesn't, the arc that actually bulges
  // toward `third` is the complementary one, rooted at `end` instead.
  if (relApex <= relEnd) return { center, radius, startAngle: angleStart, sweepAngle: relEnd };
  return { center, radius, startAngle: angleEnd, sweepAngle: wrap(angleStart - angleEnd) };
}

/**
 * The sagitta that reaches a given radius, on the same side (and in the same
 * minor/major regime) as `liveSagitta` — used when the user types a radius
 * instead of dragging: a positive typed radius keeps the minor-arc solution,
 * a negative one the major arc, both on `liveSagitta`'s side (i.e. its
 * sign). Null when the radius is too small to reach both points at all.
 */
export function sagittaForRadius(chordHalf: number, liveSagitta: number, typedRadius: number): number | null {
  const radius = Math.abs(typedRadius);
  if (radius < chordHalf - 1e-9) return null;
  const spread = Math.sqrt(Math.max(0, radius * radius - chordHalf * chordHalf));
  const magnitude = typedRadius < 0 ? radius + spread : radius - spread;
  const side = liveSagitta < 0 ? -1 : 1;
  return magnitude * side;
}

/**
 * Where the arc's free "point on arc" should currently be: the live cursor
 * with no typed override, or the point reaching the typed radius (on the
 * live cursor's own side) with one. Mirrors `dynamicLengthPoint`'s shape —
 * a typed value swaps out one measurement while everything else about the
 * live cursor (here, which side of the chord) still drives the result.
 */
export function dynamicArcPoint(start: Vec2, end: Vec2, cursor: Vec2, radiusText: string): Vec2 {
  const trimmed = radiusText.trim();
  if (trimmed === '') return cursor;
  const typed = Number(trimmed);
  if (!Number.isFinite(typed)) return cursor;
  const frame = chordFrame(start, end);
  if (!frame) return cursor;
  const liveSagitta = signedSagitta(start, end, cursor);
  const sagitta = sagittaForRadius(frame.half, liveSagitta, typed);
  if (sagitta === null) return cursor;
  return sagittaPoint(start, end, sagitta);
}
