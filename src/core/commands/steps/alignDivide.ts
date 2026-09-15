/**
 * ALIGN and DIVIDE — two commands that place things rather than draw them.
 *
 * ALIGN moves objects by saying where two of their points should end up, which
 * is move, rotate and (optionally) scale decided at once instead of three
 * commands aimed by eye. DIVIDE marks an object at even intervals along its own
 * length, which is how a row of holes or posts gets set out.
 *
 * Both are arithmetic over things that already exist: the transforms ALIGN
 * needs are the ones MOVE, ROTATE and SCALE use, and the outline DIVIDE walks
 * is the one everything is drawn from.
 */
import { cloneEntity, transformEntityPoints, type Entity } from '../../entities/types';
import { entityToPaths } from '../../entities/paths';
import { ReplaceObjectsEdit } from '../../history/edits';
import type { Vec2 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

/**
 * The move that takes `sourceA` to `targetA` and `sourceB` toward `targetB`:
 * a turn, a shift, and a scale when the two spans differ in length and scaling
 * was asked for.
 *
 * Returned as a function rather than a matrix because that is what
 * `transformEntityPoints` takes, and going through it means a curve's own
 * per-point elevations ride along as they do for every other transform.
 */
export function alignTransform(
  sourceA: Vec2, sourceB: Vec2,
  targetA: Vec2, targetB: Vec2,
  scaleToFit: boolean,
): ((point: Vec2) => Vec2) | null {
  const sourceSpan = Math.hypot(sourceB.x - sourceA.x, sourceB.y - sourceA.y);
  const targetSpan = Math.hypot(targetB.x - targetA.x, targetB.y - targetA.y);
  if (sourceSpan < 1e-12) return null;
  const angle = Math.atan2(targetB.y - targetA.y, targetB.x - targetA.x)
    - Math.atan2(sourceB.y - sourceA.y, sourceB.x - sourceA.x);
  const factor = scaleToFit ? targetSpan / sourceSpan : 1;
  if (scaleToFit && targetSpan < 1e-12) return null;
  const cos = Math.cos(angle) * factor, sin = Math.sin(angle) * factor;
  return (point) => {
    const dx = point.x - sourceA.x, dy = point.y - sourceA.y;
    return { x: targetA.x + dx * cos - dy * sin, y: targetA.y + dx * sin + dy * cos };
  };
}

/**
 * ALIGN: pick a point on the objects and where it should go, twice. The second
 * pair decides the rotation, and — if asked — the scale.
 */
export function alignObjects(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) return run.gather(value) ? 'stay' : 'advance';
  if (active.stepIndex >= 1 && active.stepIndex <= 4) {
    const key = (['sourceA', 'targetA', 'sourceB', 'targetB'] as const)[active.stepIndex - 1];
    data[key] = value;
    return 'advance';
  }
  const scaleToFit = String(value ?? '').trim().toUpperCase().startsWith('Y');
  const transform = alignTransform(
    data.sourceA as Vec2, data.sourceB as Vec2,
    data.targetA as Vec2, data.targetB as Vec2,
    scaleToFit,
  );
  if (!transform) {
    ctx.log('ALIGN failed: the two source points must be different, and the target points too when scaling.');
    return 'stay';
  }
  const entities = (data.entities as Entity[] | undefined) ?? [];
  if (entities.length === 0) { ctx.log('ALIGN: select at least one object.'); return 'stay'; }
  const moved = entities.map((entity) => transformEntityPoints(entity, transform));
  ctx.history.execute(new ReplaceObjectsEdit('Align', entities, [], moved, []));
  ctx.doc.clearSelection();
  moved.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
  ctx.log(`Aligned ${moved.length} object(s)${scaleToFit ? ', scaled to fit' : ''}.`);
  return 'advance';
}

/**
 * The points that cut an entity's own outline into `count` equal lengths —
 * `count - 1` of them, since the ends are not divisions.
 *
 * Measured along the drawn curve rather than between vertices, so dividing an
 * arc gives points evenly spaced round it and not evenly spaced across its
 * chords.
 */
export function divisionPoints(entity: Entity, count: number): Vec2[] {
  if (!Number.isInteger(count) || count < 2) return [];
  const paths = entityToPaths(entity, 256);
  if (paths.length === 0) return [];
  const points: Vec2[] = [];
  for (const path of paths) {
    const walk = path.closed && path.points.length > 1 ? [...path.points, path.points[0]] : path.points;
    if (walk.length < 2) continue;
    const spans = walk.slice(1).map((point, index) => Math.hypot(point.x - walk[index].x, point.y - walk[index].y));
    const total = spans.reduce((sum, span) => sum + span, 0);
    if (total < 1e-12) continue;
    for (let division = 1; division < count; division++) {
      let remaining = total * division / count;
      for (let index = 0; index < spans.length; index++) {
        if (remaining > spans[index] && index < spans.length - 1) { remaining -= spans[index]; continue; }
        const t = spans[index] < 1e-12 ? 0 : Math.min(1, remaining / spans[index]);
        points.push({
          x: walk[index].x + (walk[index + 1].x - walk[index].x) * t,
          y: walk[index].y + (walk[index + 1].y - walk[index].y) * t,
        });
        break;
      }
    }
  }
  return points;
}

/** DIVIDE: mark an object at even intervals along its length. */
export function divideObject(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) {
    data.target = value;
    ctx.doc.selectEntity((value as Entity).id);
    return 'advance';
  }
  const count = Number(value);
  if (!Number.isInteger(count) || count < 2 || count > 32767) {
    ctx.log('Enter a whole number of segments between 2 and 32767.');
    return 'stay';
  }
  const target = data.target as Entity;
  const points = divisionPoints(target, count);
  if (points.length === 0) {
    ctx.log('DIVIDE failed: that object has no length to divide.');
    return 'stay';
  }
  const markers = points.map((point) => {
    const marker = ctx.doc.createPoint(point);
    // The marks belong with what they divide: same layer, same plane, so they
    // are hidden and moved with it rather than floating in the world.
    marker.layer = target.layer;
    marker.aci = target.aci;
    marker.color = target.color;
    marker.workPlane = cloneEntity(target).workPlane;
    return marker;
  });
  ctx.history.execute(new ReplaceObjectsEdit('Divide', [], [], [target, ...markers], []));
  ctx.doc.clearSelection();
  markers.forEach((marker, index) => ctx.doc.selectEntity(marker.id, index > 0));
  ctx.log(`Divided into ${count} segments: ${markers.length} point(s) placed.`);
  return 'advance';
}
