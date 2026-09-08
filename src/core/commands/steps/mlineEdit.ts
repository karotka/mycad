/**
 * MLEDIT, scoped to the three operations an AutoCAD user reaches for most:
 * cutting one multiline into two, welding two multilines end-to-end back
 * into one, and clipping two multilines back to the corner where they
 * cross. AutoCAD's own MLEDIT offers about a dozen variants (cross/tee in
 * three styles, add/delete vertex, single-element cut/weld); the rest is
 * deliberately out of scope here.
 *
 * All three work purely on the stored centerline plus the entity's already-
 * resolved `elements` snapshot — none of them touch offset-line geometry
 * directly, since every element just carries the same edit as the centerline
 * (see mlineOffsetLines, computed fresh from it wherever it is drawn).
 */
import { CompositeEdit, ReplaceObjectsEdit, UpdateEntityEdit } from '../../history/edits';
import { cloneEntity, genId, type Entity, type MlineEntity } from '../../entities/types';
import { closePolyline, dist2, type Vec2 } from '../../../math/geometry';
import { lineIntersectionParameters } from './edit2d';
import type { CommandRun, StepOutcome } from '../types';

/** Same endpoint-matching distance JOIN uses (see edit2d.ts's own JOIN_TOLERANCE). */
const MLEDIT_TOLERANCE = 0.5;

function samePlane(a: Entity, b: Entity): boolean {
  return JSON.stringify(a.workPlane ?? null) === JSON.stringify(b.workPlane ?? null);
}

/** A fresh entity carrying `a`'s style/layer/colour but a new id and centerline. */
function mlinePiece(source: MlineEntity, vertices: Vec2[]): MlineEntity {
  return { ...cloneEntity(source), id: genId('mline'), vertices, closed: false, selected: false };
}

/**
 * Splits an open mline into two, at the point on its centerline nearest
 * `point` — every element follows, since they are all derived from this same
 * centerline. Refuses a closed mline (there is no natural head/tail to split
 * into) and a cut essentially on top of an existing end (nothing to split).
 */
export function cutMline(entity: MlineEntity, point: Vec2): [MlineEntity, MlineEntity] | null {
  if (entity.closed) return null;
  const vertices = entity.vertices;
  if (vertices.length < 2) return null;

  let segmentIndex = 0, bestT = 0, bestDistance = Infinity, splitPoint = vertices[0];
  for (let index = 0; index < vertices.length - 1; index++) {
    const a = vertices[index], b = vertices[index + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t = length2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
    const candidate = { x: a.x + t * dx, y: a.y + t * dy };
    const distance = dist2(point, candidate);
    if (distance < bestDistance) { bestDistance = distance; segmentIndex = index; bestT = t; splitPoint = candidate; }
  }
  const atStart = segmentIndex === 0 && bestT < 1e-6;
  const atEnd = segmentIndex === vertices.length - 2 && bestT > 1 - 1e-6;
  if (atStart || atEnd) return null;

  const head = [...vertices.slice(0, segmentIndex + 1), splitPoint];
  const tail = [splitPoint, ...vertices.slice(segmentIndex + 1)];
  if (head.length < 2 || tail.length < 2) return null;
  return [mlinePiece(entity, head), mlinePiece(entity, tail)];
}

/**
 * Joins two mlines into one, end to end — only when their MLSTYLE snapshots
 * actually line up (same element count, matching offsets): welding two
 * differently-laid-out multilines would produce a seam where the parallel
 * lines jump sideways, which is never what was intended.
 */
export function weldMlines(a: MlineEntity, b: MlineEntity): MlineEntity | null {
  if (a.closed || b.closed) return null;
  if (a.elements.length !== b.elements.length) return null;
  for (let index = 0; index < a.elements.length; index++) {
    if (Math.abs(a.elements[index].offset - b.elements[index].offset) > 1e-6) return null;
  }
  if (!samePlane(a, b)) return null;
  const av = a.vertices, bv = b.vertices;
  if (av.length < 2 || bv.length < 2) return null;
  const near = (p: Vec2, q: Vec2): boolean => dist2(p, q) <= MLEDIT_TOLERANCE;
  const aStart = av[0], aEnd = av.at(-1)!;
  const bStart = bv[0], bEnd = bv.at(-1)!;

  let vertices: Vec2[] | null = null;
  if (near(aEnd, bStart)) vertices = [...av, ...bv.slice(1)];
  else if (near(aEnd, bEnd)) vertices = [...av, ...[...bv].reverse().slice(1)];
  else if (near(aStart, bEnd)) vertices = [...bv, ...av.slice(1)];
  else if (near(aStart, bStart)) vertices = [...[...bv].reverse(), ...av.slice(1)];
  if (!vertices) return null;

  const closed = vertices.length > 2 && near(vertices[0], vertices.at(-1)!);
  const finalVertices = closed ? closePolyline(vertices.slice(0, -1)) : vertices;
  return { ...cloneEntity(a), id: genId('mline'), vertices: finalVertices, closed, selected: false };
}

/**
 * Trims (or extends — the intersection can lie beyond either's own end)
 * both open mlines back to where their centerlines cross, keeping on each
 * one whichever side the corresponding pick point fell on. The closest
 * analog TRIM has is `trimPolylineTarget`'s boundary-intersection idea; this
 * is the simplified two-object version of it, since a corner clip is always
 * exactly two objects meeting at exactly one point.
 */
export function cornerClipMlines(a: MlineEntity, pickA: Vec2, b: MlineEntity, pickB: Vec2): [MlineEntity, MlineEntity] | null {
  if (a.closed || b.closed) return null;
  if (!samePlane(a, b)) return null;
  const av = a.vertices, bv = b.vertices;
  if (av.length < 2 || bv.length < 2) return null;

  let best: { point: Vec2; aIndex: number; bIndex: number } | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < av.length - 1; i++) {
    for (let j = 0; j < bv.length - 1; j++) {
      const hit = lineIntersectionParameters(av[i], av[i + 1], bv[j], bv[j + 1]);
      if (!hit) continue;
      const score = dist2(hit.point, pickA) + dist2(hit.point, pickB);
      if (score < bestScore) { bestScore = score; best = { point: hit.point, aIndex: i, bIndex: j }; }
    }
  }
  if (!best) return null;

  // Whichever side (head toward the start, or tail toward the end) holds the
  // point nearest this object's own pick is the side that survives.
  const keptSide = (vertices: Vec2[], segmentIndex: number, point: Vec2, pick: Vec2): Vec2[] => {
    const head = [...vertices.slice(0, segmentIndex + 1), point];
    const tail = [point, ...vertices.slice(segmentIndex + 1)];
    const headDistance = Math.min(...head.map((vertex) => dist2(vertex, pick)));
    const tailDistance = Math.min(...tail.map((vertex) => dist2(vertex, pick)));
    return headDistance <= tailDistance ? head : tail;
  };
  const newA = keptSide(av, best.aIndex, best.point, pickA);
  const newB = keptSide(bv, best.bIndex, best.point, pickB);
  if (newA.length < 2 || newB.length < 2) return null;
  return [{ ...cloneEntity(a), vertices: newA }, { ...cloneEntity(b), vertices: newB }];
}

export function mlineCut(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) {
    const entity = value as Entity | undefined;
    if (!entity || entity.type !== 'mline') { ctx.log('MLCUT: select a multiline.'); return 'stay'; }
    data.entity = entity;
    ctx.doc.selectEntity(entity.id);
    ctx.log('Multiline selected. Specify the cut point.');
    return 'advance';
  }
  const entity = data.entity as MlineEntity;
  const pieces = cutMline(entity, value as Vec2);
  if (!pieces) {
    ctx.log('MLCUT failed: pick a point along an open multiline, away from its ends.');
    return 'stay';
  }
  ctx.history.execute(new ReplaceObjectsEdit('Cut', [entity], [], pieces, []));
  pieces.forEach((piece, index) => ctx.doc.selectEntity(piece.id, index > 0));
  ctx.log('Multiline cut into two.');
  return 'advance';
}

export function mlineWeld(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  const entity = value as Entity | undefined;
  if (active.stepIndex === 0) {
    if (!entity || entity.type !== 'mline') { ctx.log('MLWELD: select a multiline.'); return 'stay'; }
    data.first = entity;
    ctx.doc.selectEntity(entity.id);
    ctx.log('First multiline selected. Select the second.');
    return 'advance';
  }
  if (!entity || entity.type !== 'mline') { ctx.log('MLWELD: select a second multiline.'); return 'stay'; }
  const first = data.first as MlineEntity;
  if (first.id === entity.id) { ctx.log('MLWELD: select two different multilines.'); return 'stay'; }
  const welded = weldMlines(first, entity);
  if (!welded) {
    ctx.log('MLWELD failed: the two multilines must share an endpoint and use matching MLSTYLE offsets.');
    return 'stay';
  }
  ctx.history.execute(new ReplaceObjectsEdit('Weld', [first, entity], [], [welded], []));
  ctx.doc.selectEntity(welded.id);
  ctx.log('Multilines welded into one.');
  return 'advance';
}

export function mlineCorner(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  const entity = value as Entity | undefined;
  if (active.stepIndex === 0) {
    if (!entity || entity.type !== 'mline') { ctx.log('MLCORNER: select a multiline.'); return 'stay'; }
    data.first = { entity, pick: data.lastObjectPickPoint };
    ctx.doc.selectEntity(entity.id);
    ctx.log('First multiline selected. Select the second.');
    return 'advance';
  }
  if (!entity || entity.type !== 'mline') { ctx.log('MLCORNER: select a second multiline.'); return 'stay'; }
  const first = data.first as { entity: MlineEntity; pick?: Vec2 };
  if (first.entity.id === entity.id) { ctx.log('MLCORNER: select two different multilines.'); return 'stay'; }
  const pickA = first.pick, pickB = data.lastObjectPickPoint as Vec2 | undefined;
  if (!pickA || !pickB) { ctx.log('MLCORNER failed: no pick location recorded for one of the objects.'); return 'stay'; }
  const result = cornerClipMlines(first.entity, pickA, entity, pickB);
  if (!result) { ctx.log('MLCORNER failed: the two multilines do not cross.'); return 'stay'; }
  const [updatedA, updatedB] = result;
  ctx.history.execute(new CompositeEdit('Corner', [
    new UpdateEntityEdit('Corner', first.entity, updatedA),
    new UpdateEntityEdit('Corner', entity, updatedB),
  ]));
  ctx.doc.selectEntity(updatedA.id);
  ctx.doc.selectEntity(updatedB.id, true);
  ctx.log('Multilines joined at the corner.');
  return 'advance';
}
