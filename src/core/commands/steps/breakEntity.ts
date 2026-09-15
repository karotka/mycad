/**
 * BREAK: take a piece out of an object between two picked points.
 *
 * TRIM needs something to cut against; BREAK needs nothing but the two points,
 * which is what makes it the right tool for putting a gap in a line that
 * crosses another, or for opening a closed shape.
 *
 * The whole command is "where along this object is that point" and "what is
 * left of it when this span is taken out" — both per type, both exact. Nothing
 * is sampled except a Bezier, which has no closed form for the first question
 * and is already sampled everywhere else for the same reason.
 */
import { cloneEntity, genId, type ArcEntity, type BezierEntity, type CircleEntity, type Entity, type LineEntity, type PolylineEntity } from '../../entities/types';
import { bulgeArc, polylineSegments } from '../../entities/polylineArcs';
import { splitCubicBezier } from './edit2d';
import { lerpPoint, type Vec2 } from '../../../math/geometry';
import { ReplaceObjectsEdit } from '../../history/edits';
import type { CommandRun, StepOutcome } from '../types';

/** What BREAK can take a piece out of. */
export type BreakableEntity = LineEntity | ArcEntity | CircleEntity | PolylineEntity | BezierEntity;

export function isBreakableEntity(entity: Entity): entity is BreakableEntity {
  return entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle'
    || entity.type === 'polyline' || entity.type === 'bezier';
}

/** How far along the object a point is, as a number the same object's own
 *  `breakEntity` understands — or null when the object has no length. */
export function parameterAt(entity: BreakableEntity, point: Vec2): number | null {
  switch (entity.type) {
    case 'line': {
      const dx = entity.end.x - entity.start.x, dy = entity.end.y - entity.start.y;
      const length2 = dx * dx + dy * dy;
      if (length2 < 1e-18) return null;
      const t = ((point.x - entity.start.x) * dx + (point.y - entity.start.y) * dy) / length2;
      return Math.min(1, Math.max(0, t));
    }
    case 'arc': {
      const turn = normalizedTurn(Math.atan2(point.y - entity.center.y, point.x - entity.center.x) - entity.startAngle, entity.sweepAngle);
      return Math.min(1, Math.max(0, turn / entity.sweepAngle));
    }
    case 'circle':
      // A circle is parameterised from its own +X, counter-clockwise, which is
      // the direction AutoCAD breaks it in.
      return (((Math.atan2(point.y - entity.center.y, point.x - entity.center.x)) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2);
    case 'polyline':
      return nearestOnPolyline(entity, point);
    case 'bezier':
      return nearestOnSegments(bezierSpans(entity).map((span) => ({
        sample: (t: number) => pointOnCubic(span, t),
      })), point);
  }
}

/**
 * What is left of `entity` when the span between the two parameters is taken
 * out — nothing, one piece, or two. The originals are never edited; the caller
 * puts the pieces in and takes the old one out as one edit.
 */
export function breakEntity(entity: BreakableEntity, a: number, b: number): BreakableEntity[] {
  const [from, to] = a <= b ? [a, b] : [b, a];
  switch (entity.type) {
    case 'line': {
      const at = (t: number): Vec2 => lerpPoint(entity.start, entity.end, t);
      return [
        ...(from > 1e-9 ? [withPoints(entity, { start: entity.start, end: at(from) })] : []),
        ...(to < 1 - 1e-9 ? [withPoints(entity, { start: at(to), end: entity.end })] : []),
      ];
    }
    case 'arc':
      return [
        ...(from > 1e-9 ? [withPoints(entity, { startAngle: entity.startAngle, sweepAngle: entity.sweepAngle * from })] : []),
        ...(to < 1 - 1e-9 ? [withPoints(entity, {
          startAngle: entity.startAngle + entity.sweepAngle * to,
          sweepAngle: entity.sweepAngle * (1 - to),
        })] : []),
      ];
    case 'circle': {
      // A circle has no ends, so breaking it leaves exactly one arc: the way
      // round that the removed span is not on.
      const start = to * Math.PI * 2;
      const sweep = (1 - (to - from)) * Math.PI * 2;
      if (sweep < 1e-9) return [];
      const arc: ArcEntity = {
        ...cloneEntity(entity as unknown as ArcEntity),
        type: 'arc',
        center: { ...entity.center },
        radius: entity.radius,
        startAngle: start,
        sweepAngle: sweep,
      };
      return [arc];
    }
    case 'polyline':
      return breakPolyline(entity, from, to);
    case 'bezier':
      return breakBezier(entity, from, to);
  }
}

/** A copy of an entity with some of its fields replaced — the shape every case
 *  above needs, and the one place the clone happens. */
function withPoints<T extends BreakableEntity>(entity: T, fields: Partial<T>): T {
  return Object.assign(cloneEntity(entity), fields);
}

function normalizedTurn(turn: number, sweep: number): number {
  const full = Math.PI * 2;
  return sweep >= 0 ? ((turn % full) + full) % full : -((((-turn) % full) + full) % full);
}

/**
 * The nearest place on a polyline, exactly: a straight segment is projected on
 * and an arc segment is taken by angle, both in closed form. Sampling would
 * land a break a few ten-thousandths off where it was clicked, which shows up
 * the moment the pieces are measured.
 */
function nearestOnPolyline(entity: PolylineEntity, point: Vec2): number | null {
  const segments = polylineSegments(entity);
  if (segments.length === 0) return null;
  let best = 0;
  let bestDistance = Infinity;
  segments.forEach((segment, index) => {
    const arc = bulgeArc(segment.start, segment.end, segment.bulge);
    let t: number;
    if (arc) {
      const turn = normalizedTurn(Math.atan2(point.y - arc.center.y, point.x - arc.center.x) - arc.startAngle, arc.sweepAngle);
      t = Math.min(1, Math.max(0, turn / arc.sweepAngle));
    } else {
      const dx = segment.end.x - segment.start.x, dy = segment.end.y - segment.start.y;
      const length2 = dx * dx + dy * dy;
      t = length2 < 1e-18 ? 0
        : Math.min(1, Math.max(0, ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / length2));
    }
    const candidate = pointOnPolylineSegment(segment, t);
    const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (distance < bestDistance) { bestDistance = distance; best = index + t; }
  });
  return best;
}

interface Sampled { sample(t: number): Vec2 }

/** The nearest point on a chain of spans, as `index + t` — the parameter the
 *  polyline and Bezier cases below are written in. */
function nearestOnSegments(spans: readonly Sampled[], point: Vec2): number | null {
  if (spans.length === 0) return null;
  let best = 0;
  let bestDistance = Infinity;
  const steps = 64;
  spans.forEach((span, index) => {
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const candidate = span.sample(t);
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance < bestDistance) { bestDistance = distance; best = index + t; }
    }
  });
  // One refinement pass around the winner, so a break lands where it was
  // clicked rather than on the nearest of 64 samples.
  const index = Math.min(spans.length - 1, Math.floor(best));
  let local = best - index;
  for (let pass = 0, window = 1 / steps; pass < 6; pass++, window /= 4) {
    for (const t of [local - window, local + window]) {
      if (t < 0 || t > 1) continue;
      const candidate = spans[index].sample(t);
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance < bestDistance) { bestDistance = distance; local = t; }
    }
  }
  return index + local;
}

function pointOnPolylineSegment(segment: { start: Vec2; end: Vec2; bulge: number }, t: number): Vec2 {
  const arc = bulgeArc(segment.start, segment.end, segment.bulge);
  if (!arc) {
    return lerpPoint(segment.start, segment.end, t);
  }
  const angle = arc.startAngle + arc.sweepAngle * t;
  return { x: arc.center.x + Math.cos(angle) * arc.radius, y: arc.center.y + Math.sin(angle) * arc.radius };
}

type Cubic = [Vec2, Vec2, Vec2, Vec2];

function bezierSpans(entity: BezierEntity): Cubic[] {
  let previous = entity.start;
  return entity.segments.map((segment) => {
    const span: Cubic = [previous, segment.control1, segment.control2, segment.end];
    previous = segment.end;
    return span;
  });
}

function pointOnCubic([p0, p1, p2, p3]: Cubic, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/**
 * A polyline broken between two parameters. An open one keeps the runs either
 * side; a closed one opens up, keeping the single run the other way round —
 * the same rule TRIM follows, because it is the same question.
 */
function breakPolyline(entity: PolylineEntity, from: number, to: number): PolylineEntity[] {
  const segments = polylineSegments(entity);
  const cut = (parameter: number): { index: number; t: number; point: Vec2 } => {
    const index = Math.min(segments.length - 1, Math.max(0, Math.floor(parameter)));
    const t = Math.min(1, Math.max(0, parameter - index));
    return { index, t, point: pointOnPolylineSegment(segments[index], t) };
  };
  const first = cut(from), second = cut(to);
  /** The run of the polyline from one cut to the other, the short way. */
  const run = (start: { index: number; t: number; point: Vec2 }, end: { index: number; t: number; point: Vec2 }, wrap: boolean): PolylineEntity | null => {
    const vertices: Vec2[] = [{ ...start.point }];
    const bulges: number[] = [];
    let index = start.index;
    let t = start.t;
    const limit = segments.length + 1;
    for (let step = 0; step < limit; step++) {
      const segment = segments[index];
      const endsHere = index === end.index && (wrap ? step > 0 || end.t >= t : true);
      const until = endsHere ? end.t : 1;
      bulges.push(segment.bulge === 0 ? 0 : Math.tan(4 * Math.atan(segment.bulge) * (until - t) / 4));
      vertices.push(endsHere ? { ...end.point } : { ...segment.end });
      if (endsHere) break;
      index = (index + 1) % segments.length;
      t = 0;
      if (!wrap && index === 0) break;
    }
    if (vertices.length < 2) return null;
    const piece = withPoints(entity, { vertices, closed: false } as Partial<PolylineEntity>);
    piece.bulges = bulges.some((bulge) => Math.abs(bulge) > 1e-9) ? bulges : undefined;
    return piece;
  };
  if (entity.closed) {
    const kept = run(second, first, true);
    return kept ? [kept] : [];
  }
  const head = from > 1e-9 ? run({ index: 0, t: 0, point: entity.vertices[0] }, first, false) : null;
  const tail = to < segments.length - 1e-9
    ? run(second, { index: segments.length - 1, t: 1, point: entity.vertices[entity.vertices.length - 1] }, false)
    : null;
  return [head, tail].filter((piece): piece is PolylineEntity => piece !== null);
}

/** A Bezier chain broken between two parameters, split exactly rather than
 *  refitted — the same de Casteljau split TRIM uses. */
function breakBezier(entity: BezierEntity, from: number, to: number): BezierEntity[] {
  const spans = bezierSpans(entity);
  const head = from > 1e-9 ? chainFrom(entity, spans.slice(0, Math.floor(from)), splitHead(spans, from)) : null;
  const tail = to < spans.length - 1e-9 ? chainFrom(entity, [], splitTail(spans, to)) : null;
  return [head, tail].filter((piece): piece is BezierEntity => piece !== null);
}

function splitHead(spans: readonly Cubic[], parameter: number): Cubic[] {
  const index = Math.min(spans.length - 1, Math.floor(parameter));
  const local = parameter - index;
  if (local <= 1e-9) return [];
  const { left } = splitCubicBezier(spans[index][0], spans[index][1], spans[index][2], spans[index][3], local);
  return [left];
}

function splitTail(spans: readonly Cubic[], parameter: number): Cubic[] {
  const index = Math.min(spans.length - 1, Math.floor(parameter));
  const local = parameter - index;
  const { right } = splitCubicBezier(spans[index][0], spans[index][1], spans[index][2], spans[index][3], local);
  return [...(local >= 1 - 1e-9 ? [] : [right]), ...spans.slice(index + 1)];
}

function chainFrom(entity: BezierEntity, whole: readonly Cubic[], extra: readonly Cubic[]): BezierEntity | null {
  const spans = [...whole, ...extra];
  if (spans.length === 0) return null;
  return withPoints(entity, {
    start: { ...spans[0][0] },
    segments: spans.map((span) => ({ control1: { ...span[1] }, control2: { ...span[2] }, end: { ...span[3] } })),
  } as Partial<BezierEntity>);
}

/**
 * The command: pick the object, then the two points the gap runs between.
 *
 * The points are taken as "wherever along the object that is", so they need not
 * be exactly on it — which is how it is used, aiming near the object with a
 * snap if there is one and by eye if there is not.
 */
export function breakObject(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) {
    const entity = value as Entity;
    if (!isBreakableEntity(entity)) {
      ctx.log('BREAK accepts a line, arc, circle, polyline or spline.');
      return 'stay';
    }
    data.target = entity;
    ctx.doc.selectEntity(entity.id);
    return 'advance';
  }
  const target = data.target as BreakableEntity;
  if (active.stepIndex === 1) {
    const first = parameterAt(target, value as Vec2);
    if (first === null) { ctx.log('BREAK failed: that object has no length.'); return 'stay'; }
    data.firstParameter = first;
    return 'advance';
  }
  const second = parameterAt(target, value as Vec2);
  const first = data.firstParameter as number;
  if (second === null || Math.abs(second - first) < 1e-9) {
    // Two points at the same place would take nothing out. AutoCAD's own
    // BREAKATPOINT is the command for splitting without a gap.
    ctx.log('BREAK failed: the two points must be different places along the object.');
    return 'stay';
  }
  const pieces = breakEntity(target, first, second);
  if (pieces.length === 0) {
    ctx.log('BREAK failed: nothing would be left of the object.');
    return 'stay';
  }
  for (const piece of pieces) piece.id = genId(piece.type);
  ctx.history.execute(new ReplaceObjectsEdit('Break', [target], [], pieces, []));
  ctx.doc.clearSelection();
  pieces.forEach((piece, index) => ctx.doc.selectEntity(piece.id, index > 0));
  ctx.log(`Broken into ${pieces.length} piece(s).`);
  return 'advance';
}
