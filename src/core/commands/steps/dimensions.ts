/**
 * The dimensions, and the coordinate system they are measured in.
 *
 * Two shapes between them: a linear or aligned dimension is two points and
 * where the line goes, and a radial one is a circle and where the text goes.
 * UCS sits here because it is the same question turned around — three points
 * that say what "horizontal" means for everything drawn after them.
 */
import { AddEntityEdit } from '../../history/edits';
import { dimensionGeometry, linearDimensionRotation, type Entity } from '../../entities/types';
import { cloneWorkPlane, workPlaneFromXYAxes, WORLD_WORK_PLANE } from '../../../math/workplane';
import { dist3, formatPoint, type Vec2, type Vec3 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

/** A dimension takes points that may carry a Z; what it measures is flat. */
const flat = (point: Vec2 | Vec3): Vec2 => ({ x: point.x, y: point.y });
const spatial = (point: Vec2 | Vec3): Vec3 => ({ x: point.x, y: point.y, z: 'z' in point ? point.z : 0 });

export function measureDistance(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) { data.start = value; return 'advance'; }
  if (active.stepIndex === 1) { data.end = value; return 'advance'; }
  if (active.stepIndex === 2) { data.offset = value; return 'advance'; }

  // The last step, so the dimension is built once and lands in the history as a
  // single entry — placing the text is part of drawing it, not an edit of
  // something already drawn.
  const start = data.start as Vec2 | Vec3;
  const end = data.end as Vec2 | Vec3;
  const offset = data.offset as Vec2;
  const aligned = active.name === 'DIMALIGNED';
  const dimension = ctx.doc.createDimension(
    flat(start), flat(end), offset,
    aligned ? 'aligned' : 'linear',
    aligned ? undefined : linearDimensionRotation(flat(start), flat(end), offset),
  );
  // Enter arrives as null, which is the step declining to move the text.
  const textPosition = value as Vec2 | null;
  if (textPosition) dimension.textPosition = { x: textPosition.x, y: textPosition.y };
  ctx.history.execute(new AddEntityEdit('Dimension', dimension));
  // An aligned dimension reads the true distance, which may run through Z; a
  // linear one reads the leg it drew, which the geometry already worked out.
  const measured = aligned ? dist3(spatial(start), spatial(end)) : Number(dimensionGeometry(dimension).text);
  ctx.log(`Dimension created: ${measured.toFixed(dimension.precision)} mm (${formatPoint(spatial(start))} -> ${formatPoint(spatial(end))})`);
  return 'advance';
}

export function measureRadius(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  const radial = active.name === 'DIMRADIUS';

  if (active.stepIndex === 0) {
    const entity = value as Entity;
    if (entity.type !== 'circle' && entity.type !== 'arc') {
      ctx.log('Dimension requires a circle or arc.');
      return 'stay';
    }
    data.entity = entity;
    return 'advance';
  }

  const entity = data.entity as Entity;
  if (entity.type !== 'circle' && entity.type !== 'arc') return 'stay';
  const cursor = value as Vec2;
  // The arrow lands on the rim under the cursor. Dead centre there is no
  // direction to take, so it points along X rather than dividing by nothing.
  let dx = cursor.x - entity.center.x, dy = cursor.y - entity.center.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-9) { dx = 1; dy = 0; } else { dx /= distance; dy /= distance; }

  const rim = { x: entity.center.x + dx * entity.radius, y: entity.center.y + dy * entity.radius };
  const dimension = ctx.doc.createDimension(entity.center, rim, cursor, radial ? 'radius' : 'diameter');
  // The dimension lives on the circle's plane, not on whatever is active now.
  dimension.workPlane = cloneWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE);
  ctx.history.execute(new AddEntityEdit(radial ? 'Radius dimension' : 'Diameter dimension', dimension));
  ctx.log(`${radial ? 'Radius' : 'Diameter'} dimension created.`);
  return 'advance';
}

export function setWorkPlane({ active, data, value, ctx }: CommandRun): StepOutcome {
  if (active.stepIndex === 0) { data.origin = value; return 'advance'; }
  if (active.stepIndex === 1) { data.xPoint = value; return 'advance'; }

  const origin = data.origin as Vec3;
  const xPoint = data.xPoint as Vec3;
  const yPoint = value as Vec3;
  ctx.doc.activeWorkPlane = workPlaneFromXYAxes(origin, xPoint, yPoint);
  ctx.doc.viewMode = '3d';
  ctx.workPlaneChanged?.();
  ctx.doc.notify();
  ctx.log(`UCS set: origin ${formatPoint(origin)}, X through ${formatPoint(xPoint)}, Y through ${formatPoint(yPoint)}`);
  return 'advance';
}
