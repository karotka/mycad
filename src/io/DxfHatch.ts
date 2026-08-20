/**
 * DXF HATCH → plottable geometry. mycad has no fill primitive and a pen plotter
 * cannot fill, so a hatch is imported as lines: a SOLID fill gives back its
 * boundary loops (the region outline), and a pattern gives back the actual hatch
 * lines — each pattern-line family generated from the definition the DXF carries
 * (angle, base, offset) and clipped to the boundary. That is the geometry you
 * would draw or plot.
 */
import type { Vec2 } from '../math/geometry';

export interface DxfPair { code: number; value: string }

export interface HatchGeometry {
  /** Boundary loops (outer first), in drawing units already scaled to mm. */
  loops: Vec2[][];
  solid: boolean;
  /** Generated hatch-line segments for a pattern fill; empty for a solid fill. */
  lines: Array<[Vec2, Vec2]>;
}

interface PatternLine { angle: number; base: Vec2; offset: Vec2 }

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

const bbox = (loops: Vec2[][]): { min: Vec2; max: Vec2 } => {
  const min = { x: Infinity, y: Infinity }, max = { x: -Infinity, y: -Infinity };
  for (const loop of loops) for (const p of loop) {
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y);
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y);
  }
  return { min, max };
};

/** The t values (along a line through `p` with direction `d`) where it crosses the loops. */
function crossings(loops: Vec2[][], p: Vec2, d: Vec2): number[] {
  const ts: number[] = [];
  for (const loop of loops) {
    for (let k = 0; k < loop.length; k++) {
      const a = loop[k], b = loop[(k + 1) % loop.length];
      const ex = b.x - a.x, ey = b.y - a.y;
      const denom = d.x * ey - d.y * ex;
      if (Math.abs(denom) < 1e-12) continue; // parallel
      // Solve p + t d = a + s e, for t (along line) and s in [0,1) on the edge.
      const rx = a.x - p.x, ry = a.y - p.y;
      const s = (rx * d.y - ry * d.x) / denom;
      if (s < 0 || s >= 1) continue;
      const t = (rx * ey - ry * ex) / denom;
      ts.push(t);
    }
  }
  return ts.sort((m, n) => m - n);
}

/** Generate the hatch lines for one pattern-line family, clipped to the boundary. */
function familyLines(loops: Vec2[][], line: PatternLine, box: { min: Vec2; max: Vec2 }): Array<[Vec2, Vec2]> {
  const out: Array<[Vec2, Vec2]> = [];
  const d = { x: Math.cos(line.angle), y: Math.sin(line.angle) };
  const n = { x: -d.y, y: d.x }; // unit normal to the line direction
  // Codes 45/46 are the world offset from one pattern line to the next parallel
  // one. Only its component across the line (offPerp) separates the lines — the
  // along-line component just staggers dashes — so the family index k must be
  // measured by perpendicular position, not by the full offset vector, or a
  // pattern whose offset leans along the line lands its lines off the region.
  const off = line.offset;
  const offPerp = off.x * n.x + off.y * n.y;
  if (Math.hypot(off.x, off.y) < 1e-9 || Math.abs(offPerp) < 1e-6) return out;
  // Range of family index k that reaches the bounding box, by perpendicular position.
  const corners = [box.min, { x: box.max.x, y: box.min.y }, box.max, { x: box.min.x, y: box.max.y }];
  let kMin = Infinity, kMax = -Infinity;
  for (const c of corners) {
    const k = ((c.x - line.base.x) * n.x + (c.y - line.base.y) * n.y) / offPerp;
    kMin = Math.min(kMin, k); kMax = Math.max(kMax, k);
  }
  const guard = 100000; // never loop unboundedly on a degenerate pattern
  const total = Math.ceil(kMax) - Math.floor(kMin);
  if (total > guard || total < 0) return out;
  for (let k = Math.floor(kMin) - 1; k <= Math.ceil(kMax) + 1; k++) {
    const p = { x: line.base.x + k * off.x, y: line.base.y + k * off.y };
    const ts = crossings(loops, p, d);
    for (let m = 0; m + 1 < ts.length; m += 2) {
      const t0 = ts[m], t1 = ts[m + 1];
      if (t1 - t0 < 1e-6) continue;
      out.push([
        { x: p.x + d.x * t0, y: p.y + d.y * t0 },
        { x: p.x + d.x * t1, y: p.y + d.y * t1 },
      ]);
    }
  }
  return out;
}

/** Turn one HATCH entity's fields into loops (always) and hatch lines (patterns only). */
export function hatchGeometry(fields: DxfPair[], scale: number): HatchGeometry {
  const solid = num(fields.find((f) => f.code === 70)?.value ?? '0') === 1;
  const loops = readBoundaries(fields, scale);
  if (solid || loops.length === 0) return { loops, solid, lines: [] };
  const box = bbox(loops);
  const lines: Array<[Vec2, Vec2]> = [];
  for (const family of readPatternLines(fields, scale)) lines.push(...familyLines(loops, family, box));
  return { loops, solid, lines };
}
