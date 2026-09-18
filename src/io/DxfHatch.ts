/**
 * DXF HATCH parsing and lazy stroke generation. The importer keeps the boundary
 * and pattern definition as one native entity; rendering, EXPLODE and plotting
 * call the generator only when they need clipped line segments.
 */
import type { Vec2 } from '../math/geometry';
import { hatchPatternSegments } from '../core/entities/hatch';
export { hatchPatternSegments } from '../core/entities/hatch';

export interface DxfPair { code: number; value: string }

export interface HatchGeometry {
  /** Boundary loops (outer first), in drawing units already scaled to mm. */
  loops: Vec2[][];
  solid: boolean;
  /** Generated hatch-line segments for a pattern fill; empty for a solid fill. */
  lines: Array<[Vec2, Vec2]>;
}

export interface PatternLine { angle: number; base: Vec2; offset: Vec2 }

const num = (value: string): number => { const n = Number(value); return Number.isFinite(n) ? n : 0; };

/** Flatten an arc (degrees, CCW when ccw) into a short polyline of points. */
function arcPoints(cx: number, cy: number, r: number, a0: number, a1: number, ccw: boolean): Vec2[] {
  let start = (a0 * Math.PI) / 180;
  let end = (a1 * Math.PI) / 180;
  if (ccw) { while (end < start) end += Math.PI * 2; } else { while (end > start) end -= Math.PI * 2; }
  const span = Math.abs(end - start);
  const steps = Math.max(2, Math.ceil(span / (Math.PI / 24)));
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (end - start) * (i / steps);
    out.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) });
  }
  return out;
}

/** Flatten a HATCH ellipse edge (parameter angles in degrees) into points. */
function ellipsePoints(cx: number, cy: number, mx: number, my: number, ratio: number, a0: number, a1: number, ccw: boolean): Vec2[] {
  const major = Math.hypot(mx, my);
  const minor = major * ratio;
  const rot = Math.atan2(my, mx);
  let start = (a0 * Math.PI) / 180;
  let end = (a1 * Math.PI) / 180;
  if (ccw) { while (end < start) end += Math.PI * 2; } else { while (end > start) end -= Math.PI * 2; }
  const steps = Math.max(4, Math.ceil(Math.abs(end - start) / (Math.PI / 24)));
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + (end - start) * (i / steps);
    const ex = major * Math.cos(t), ey = minor * Math.sin(t);
    out.push({ x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos });
  }
  return out;
}

/** One point of a B-spline (de Boor). Robust to short/degenerate knot vectors. */
function deBoor(u: number, degree: number, knots: number[], ctrl: Vec2[]): Vec2 {
  const clampIndex = (idx: number): Vec2 => ctrl[Math.min(Math.max(idx, 0), ctrl.length - 1)];
  let k = degree;
  while (k < knots.length - 1 && knots[k + 1] <= u) k++;
  k = Math.min(Math.max(k, degree), ctrl.length - 1);
  const d: Vec2[] = [];
  for (let j = 0; j <= degree; j++) d[j] = { ...clampIndex(j + k - degree) };
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const lo = knots[Math.min(Math.max(j + k - degree, 0), knots.length - 1)];
      const hi = knots[Math.min(Math.max(j + 1 + k - r, 0), knots.length - 1)];
      const denom = hi - lo;
      const alpha = Math.abs(denom) < 1e-12 ? 0 : (u - lo) / denom;
      d[j] = { x: (1 - alpha) * d[j - 1].x + alpha * d[j].x, y: (1 - alpha) * d[j - 1].y + alpha * d[j].y };
    }
  }
  return d[degree];
}

/** Sample a B-spline edge into points; falls back to the control polygon if degenerate. */
function splinePoints(degree: number, knots: number[], ctrl: Vec2[]): Vec2[] {
  if (degree < 1 || ctrl.length < degree + 1 || knots.length < ctrl.length + degree + 1) return ctrl.slice();
  const u0 = knots[degree];
  const u1 = knots[knots.length - 1 - degree];
  if (!(u1 > u0)) return ctrl.slice();
  const steps = Math.max(12, ctrl.length * 6);
  const out: Vec2[] = [];
  for (let s = 0; s <= steps; s++) {
    const u = Math.min(u0 + (u1 - u0) * (s / steps), u1 - 1e-9);
    out.push(deBoor(u, degree, knots, ctrl));
  }
  return out;
}

/** Read the boundary loops out of a HATCH's fields, following the DXF field order. */
function readBoundaries(fields: DxfPair[], scale: number): Vec2[][] {
  const loops: Vec2[][] = [];
  let i = fields.findIndex((f) => f.code === 91);
  if (i < 0) return loops;
  const paths = num(fields[i].value); i++;
  const seek = (code: number): number => { while (i < fields.length && fields[i].code !== code) i++; return i; };
  for (let p = 0; p < paths && i < fields.length; p++) {
    if (seek(92) >= fields.length) break;
    const flag = num(fields[i].value); i++;
    const loop: Vec2[] = [];
    if ((flag & 2) !== 0) {
      // Polyline boundary: 72 hasBulge, 73 closed, 93 count, then 10/20[/42].
      if (seek(93) >= fields.length) break;
      const count = num(fields[i].value); i++;
      for (let v = 0; v < count; v++) {
        if (seek(10) >= fields.length) break;
        const x = num(fields[i].value) * scale; i++;
        if (seek(20) >= fields.length) break;
        const y = num(fields[i].value) * scale; i++;
        loop.push({ x, y });
      }
    } else {
      // Edge boundary: 93 edge count, then per edge 72 type + geometry.
      if (seek(93) >= fields.length) break;
      const edges = num(fields[i].value); i++;
      for (let e = 0; e < edges; e++) {
        if (seek(72) >= fields.length) break;
        const type = num(fields[i].value); i++;
        const read = (code: number): number => { seek(code); const val = i < fields.length ? num(fields[i].value) : 0; i++; return val; };
        if (type === 1) {
          const sx = read(10) * scale, sy = read(20) * scale, ex = read(11) * scale, ey = read(21) * scale;
          loop.push({ x: sx, y: sy }, { x: ex, y: ey });
        } else if (type === 2) {
          const cx = read(10) * scale, cy = read(20) * scale, r = read(40) * scale, a0 = read(50), a1 = read(51);
          const ccw = read(73) !== 0;
          loop.push(...arcPoints(cx, cy, r, a0, a1, ccw));
        } else if (type === 3) {
          const cx = read(10) * scale, cy = read(20) * scale, mx = read(11) * scale, my = read(21) * scale;
          const ratio = read(40), a0 = read(50), a1 = read(51), ccw = read(73) !== 0;
          loop.push(...ellipsePoints(cx, cy, mx, my, ratio, a0, a1, ccw));
        } else if (type === 4) {
          const degree = read(94);
          read(73); read(74); // rational, periodic — unused
          const nKnots = read(95);
          const nCtrl = read(96);
          const knots: number[] = [];
          for (let kk = 0; kk < nKnots; kk++) { seek(40); knots.push(i < fields.length ? num(fields[i].value) : 0); i++; }
          const ctrl: Vec2[] = [];
          for (let cc = 0; cc < nCtrl; cc++) {
            seek(10); const x = (i < fields.length ? num(fields[i].value) : 0) * scale; i++;
            seek(20); const y = (i < fields.length ? num(fields[i].value) : 0) * scale; i++;
            ctrl.push({ x, y });
          }
          loop.push(...splinePoints(degree, knots, ctrl));
        }
      }
    }
    if (loop.length >= 2) loops.push(loop);
  }
  return loops;
}

/** Read the pattern-line families (after code 78) from a non-solid HATCH. */
function readPatternLines(fields: DxfPair[], scale: number): PatternLine[] {
  let i = fields.findIndex((f) => f.code === 78);
  if (i < 0) return [];
  const count = num(fields[i].value); i++;
  const lines: PatternLine[] = [];
  const seek = (code: number): number => { while (i < fields.length && fields[i].code !== code) i++; return i; };
  for (let n = 0; n < count; n++) {
    if (seek(53) >= fields.length) break;
    const angle = (num(fields[i].value) * Math.PI) / 180; i++;
    const bx = (seek(43) < fields.length ? num(fields[i].value) : 0) * scale; i++;
    const by = (seek(44) < fields.length ? num(fields[i].value) : 0) * scale; i++;
    const ox = (seek(45) < fields.length ? num(fields[i].value) : 0) * scale; i++;
    const oy = (seek(46) < fields.length ? num(fields[i].value) : 0) * scale; i++;
    // 79 dash count then 49 dashes — dashes are ignored (drawn as solid lines).
    lines.push({ angle, base: { x: bx, y: by }, offset: { x: ox, y: oy } });
  }
  return lines;
}

/** Turn one HATCH entity's fields into loops (always) and hatch lines (patterns only). */
export function hatchGeometry(fields: DxfPair[], scale: number): HatchGeometry {
  const solid = num(fields.find((f) => f.code === 70)?.value ?? '0') === 1;
  const loops = readBoundaries(fields, scale);
  if (solid || loops.length === 0) return { loops, solid, lines: [] };
  const lines = hatchPatternSegments(loops, readPatternLines(fields, scale));
  return { loops, solid, lines };
}

/** Native definition retained by the importer instead of exploding to LINEs. */
export function hatchDefinition(fields: DxfPair[], scale: number): { loops: Vec2[][]; solid: boolean; pattern: string; lines: PatternLine[] } {
  const solid = num(fields.find((f) => f.code === 70)?.value ?? '0') === 1;
  return {
    loops: readBoundaries(fields, scale),
    solid,
    pattern: fields.find((field) => field.code === 2)?.value || (solid ? 'solid' : 'lines'),
    lines: solid ? [] : readPatternLines(fields, scale),
  };
}
