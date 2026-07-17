/**
 * Moving what is already drawn: mirror, erase, rotate, scale.
 *
 * They are one family and it shows once they sit together — each gathers
 * objects, asks where from, and replaces them. What used to be repeated in every
 * one of them is `applyTo` now: the edit, the reselection of the results, and
 * saying how many. Two of them had also grown their own copy of the gathering
 * branch that `run.gather` already does.
 */
import { AddEntitiesEdit, ReplaceObjectsEdit, cloneSolid } from '../../history/edits';
import { cloneEntity, closedVertices, genId, transformEntityPoints, type Entity, type Solid } from '../../entities/types';
import { rotatedFeature, scaledFeature, translatedFeature } from '../../solids/featureTransform';
import { cloneWorkPlane, localToWorld, worldToLocal, WORLD_WORK_PLANE } from '../../../math/workplane';
import { dist2, formatPoint, mirrorPoint2, rotatePoint, type Vec2, type Vec3 } from '../../../math/geometry';
import type { Document } from '../../Document';
import type { CommandRun, StepOutcome } from '../types';

export function scaleEntity(entity: Entity, base: Vec2, factor: number): Entity {
  const scaled = transformEntityPoints(entity, (point) => ({
    x: base.x + (point.x - base.x) * factor,
    y: base.y + (point.y - base.y) * factor,
  }));
  if (scaled.type === 'circle' || scaled.type === 'arc' || scaled.type === 'octagon') scaled.radius *= factor;
  if (scaled.type === 'ellipse') { scaled.radiusX *= factor; scaled.radiusY *= factor; }
  if (scaled.type === 'text') scaled.height *= factor;
  scaled.selected = true;
  return scaled;
}

export function scaleSolid(solid: Solid, base: Vec3, factor: number): Solid {
  const scaled = cloneSolid(solid);
  for (let index = 0; index < scaled.mesh.positions.length; index += 3) {
    scaled.mesh.positions[index] = base.x + (scaled.mesh.positions[index] - base.x) * factor;
    scaled.mesh.positions[index + 1] = base.y + (scaled.mesh.positions[index + 1] - base.y) * factor;
    scaled.mesh.positions[index + 2] = base.z + (scaled.mesh.positions[index + 2] - base.z) * factor;
  }
  scaled.height *= factor;
  // The mesh is transformed rather than regenerated, because a uniform scale of
  // every vertex is exactly what regenerating would produce and it needs no
  // WASM to do it. The feature is carried along so that the shape and the story
  // of it stay the same shape — this used to end at `{ kind: 'mesh' }`, so
  // resizing a sphere cost you the radius that made it.
  scaled.feature = scaledFeature(scaled.feature, base, factor) ?? { kind: 'mesh' };
  scaled.revision++;
  scaled.selected = true;
  return scaled;
}

export function rotateEntity(entity: Entity, base: Vec2, angle: number, doc: Document): Entity {
  if (entity.type === 'rectangle') {
    const corners = closedVertices(entity)!;
    const polyline = doc.createPolyline(corners.map((point) => rotatePoint(point, base, angle)), true, entity.color);
    polyline.layer = entity.layer;
    polyline.workPlane = cloneEntity(entity).workPlane;
    return polyline;
  }
  const result = cloneEntity(entity);
  switch (result.type) {
    case 'line': result.start = rotatePoint(result.start, base, angle); result.end = rotatePoint(result.end, base, angle); break;
    case 'circle': result.center = rotatePoint(result.center, base, angle); break;
    case 'ellipse':
      result.center = rotatePoint(result.center, base, angle);
      result.rotation += angle;
      break;
    case 'octagon': result.center = rotatePoint(result.center, base, angle); result.vertices = result.vertices.map((point) => rotatePoint(point, base, angle)); break;
    case 'polyline': result.vertices = result.vertices.map((point) => rotatePoint(point, base, angle)); break;
    case 'arc': result.center = rotatePoint(result.center, base, angle); result.startAngle += angle; break;
    case 'bezier':
      result.start = rotatePoint(result.start, base, angle);
      result.control1 = rotatePoint(result.control1, base, angle);
      result.control2 = rotatePoint(result.control2, base, angle);
      result.end = rotatePoint(result.end, base, angle);
      break;
    case 'text': result.position = rotatePoint(result.position, base, angle); result.rotation = (result.rotation ?? 0) + angle; break;
    case 'dimension': result.start = rotatePoint(result.start, base, angle); result.end = rotatePoint(result.end, base, angle); result.offset = rotatePoint(result.offset, base, angle); break;
    case 'rectangle': break;
  }
  return result;
}

export function rotateSolidAroundPlane(solid: Solid, centerLocal: Vec3, angle: number, plane: typeof WORLD_WORK_PLANE): Solid {
  const rotated = cloneSolid(solid);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let index = 0; index < rotated.mesh.positions.length; index += 3) {
    const local = worldToLocal(plane, {
      x: rotated.mesh.positions[index],
      y: rotated.mesh.positions[index + 1],
      z: rotated.mesh.positions[index + 2],
    });
    const dx = local.x - centerLocal.x;
    const dy = local.y - centerLocal.y;
    const x = centerLocal.x + dx * cos - dy * sin;
    const y = centerLocal.y + dx * sin + dy * cos;
    const world = localToWorld(plane, { x, y }, local.z);
    rotated.mesh.positions[index] = world.x;
    rotated.mesh.positions[index + 1] = world.y;
    rotated.mesh.positions[index + 2] = world.z;
  }
  // A rotation is the work plane turned, which every feature already carries,
  // so this one never needed to bake at all.
  rotated.feature = rotatedFeature(rotated.feature, localToWorld(plane, centerLocal, centerLocal.z), plane.zAxis, angle)
    ?? { kind: 'mesh' };
  rotated.revision++;
  return rotated;
}

export function copyEntity(entity: Entity, localDelta: Vec2, worldDelta?: Vec3): Entity {
  let copy: Entity;
  if (worldDelta) {
    copy = cloneEntity(entity);
    const plane = cloneWorkPlane(copy.workPlane ?? WORLD_WORK_PLANE);
    plane.origin.x += worldDelta.x;
    plane.origin.y += worldDelta.y;
    plane.origin.z += worldDelta.z;
    copy.workPlane = plane;
  } else {
    copy = transformEntityPoints(entity, (point) => ({ x: point.x + localDelta.x, y: point.y + localDelta.y }));
  }
  copy.id = genId(copy.type);
  copy.selected = false;
  return copy;
}

export function copySolid(solid: Solid, delta: Vec3): Solid {
  const copy = cloneSolid(solid);
  copy.id = genId('solid');
  copy.name = `${solid.name}_copy`;
  copy.selected = false;
  for (let index = 0; index < copy.mesh.positions.length; index += 3) {
    copy.mesh.positions[index] += delta.x;
    copy.mesh.positions[index + 1] += delta.y;
    copy.mesh.positions[index + 2] += delta.z;
  }
  // Its own history moves with it: a copy that forgot how it was made would
  // be a mesh sitting beside the parametric solid it came from.
  copy.feature = translatedFeature(copy.feature, delta) ?? { kind: 'mesh' };
  copy.revision++;
  return copy;
}

/**
 * The end every one of these shares: one undoable edit, and the results left
 * selected so the next command can act on what this one just made.
 */
function applyTo(
  run: CommandRun,
  label: string,
  before: { entities: Entity[]; solids: Solid[] },
  after: { entities: Entity[]; solids: Solid[] },
  message: (count: number) => string,
): StepOutcome {
  const { ctx } = run;
  ctx.history.execute(new ReplaceObjectsEdit(label, before.entities, before.solids, after.entities, after.solids));
  ctx.doc.clearSelection();
  after.entities.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
  after.solids.forEach((solid) => ctx.doc.selectSolid(solid.id, true));
  ctx.log(message(after.entities.length + after.solids.length));
  return 'advance';
}

export function mirrorObjects(run: CommandRun): StepOutcome {
  const { active, data, value, step, ctx } = run;
  if (step.kind === 'entity') {
    if (run.gather(value)) return 'stay';
    return 'advance';
  }
  if (active.stepIndex === 1) { data.axisStart = value; return 'advance'; }

  const axisStart = data.axisStart as Vec2;
  const axisEnd = value as Vec2;
  const entities = data.entities as Entity[];
  // A mirror keeps the originals, so the copies need ids of their own.
  const mirrored = entities.map((entity) => {
    const copy = transformEntityPoints(entity, (point) => mirrorPoint2(point, axisStart, axisEnd));
    copy.id = genId(entity.type);
    return copy;
  });
  ctx.history.execute(new AddEntitiesEdit('Mirror', mirrored));
  ctx.log(`Mirrored ${entities.length} object(s).`);
  return 'advance';
}

export function eraseObjects(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0 && run.gather(value)) return 'stay';

  // Enter: everything gathered goes in one undoable edit.
  const entities = (data.entities as Entity[]).map(cloneEntity);
  const solids = (data.solids as Solid[]).map(cloneSolid);
  if (entities.length + solids.length === 0) {
    ctx.log('Nothing to delete.');
    run.cancel();
    return 'advance';
  }
  ctx.history.execute(new ReplaceObjectsEdit('Delete objects', entities, solids, [], []));
  ctx.log(`Deleted ${entities.length + solids.length} object(s).`);
  return 'advance';
}

export function rotateObjects(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) return run.gather(value) ? 'stay' : 'advance';
  if (active.stepIndex === 1) { data.basePoint = value; return 'advance'; }

  const base = data.basePoint as Vec2;
  const target = value as Vec2;
  const angle = Math.atan2(target.y - base.y, target.x - base.x);
  const entities = data.entities as Entity[];
  const solids = (data.solids as Solid[] | undefined) ?? [];
  // Solids turn about the same axis the drawing does: the work plane's normal,
  // through the base point.
  const plane = ctx.doc.activeWorkPlane;
  return applyTo(run, 'Rotate',
    { entities, solids },
    {
      entities: entities.map((entity) => rotateEntity(entity, base, angle, ctx.doc)),
      solids: solids.map((solid) => rotateSolidAroundPlane(cloneSolid(solid), { x: base.x, y: base.y, z: 0 }, angle, plane)),
    },
    (count) => `Rotated ${count} object(s) by ${(angle * 180 / Math.PI).toFixed(3)}°.`);
}

export function scaleObjects(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) return run.gather(value) ? 'stay' : 'advance';
  if (active.stepIndex === 1) {
    data.basePoint = value;
    data.baseWorldPoint = data.pendingMoveWorldPoint;
    delete data.pendingMoveWorldPoint;
    return 'advance';
  }

  const base = data.basePoint as Vec2;
  // A typed factor is the factor; a picked point is how far it was dragged.
  const factor = (data.enteredScaleFactor as number | undefined) ?? dist2(base, value as Vec2);
  delete data.enteredScaleFactor;
  if (!Number.isFinite(factor) || factor <= 1e-9) {
    ctx.log('Scale factor must be greater than zero.');
    return 'stay';
  }
  const entities = data.entities as Entity[];
  const solids = data.solids as Solid[];
  const baseWorld = (data.baseWorldPoint as Vec3 | undefined) ?? localToWorld(ctx.doc.activeWorkPlane, base);
  return applyTo(run, 'Scale',
    { entities, solids },
    {
      entities: entities.map((entity) => scaleEntity(entity, base, factor)),
      solids: solids.map((solid) => scaleSolid(solid, baseWorld, factor)),
    },
    (count) => `Scaled ${count} object(s) by factor ${factor.toFixed(4)}.`);
}

/**
 * Both MOVE and COPY ask the same first two questions, and both need the world
 * point behind the second: a drag across the screen is a distance in the work
 * plane, but the objects may live in three dimensions, so the exact world delta
 * is kept when the viewport could supply one.
 */
function takeBasePoint(run: CommandRun): StepOutcome {
  const { data, value } = run;
  data.basePoint = value;
  data.baseWorldPoint = data.pendingMoveWorldPoint;
  delete data.pendingMoveWorldPoint;
  return 'advance';
}

/** The exact world delta of the drag, when the viewport gave one for both ends. */
function worldDeltaOf(data: Record<string, unknown>): Vec3 | undefined {
  const from = data.baseWorldPoint as Vec3 | undefined;
  const to = data.pendingMoveWorldPoint as Vec3 | undefined;
  return from && to ? { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z } : undefined;
}

export function moveObjects(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) return run.gather(value) ? 'stay' : 'advance';
  if (active.stepIndex === 1) return takeBasePoint(run);

  const base = data.basePoint as Vec2;
  const target = value as Vec2;
  const delta = { x: target.x - base.x, y: target.y - base.y };
  const objects: Array<Entity | string> = [
    ...(data.entities as Entity[]),
    ...(data.solids as Solid[]).map((solid) => solid.id),
  ];
  if (objects.length === 0) {
    ctx.log('Nothing to move.');
    return 'stay';
  }
  // One drag is one thing the user did, so it is one step in the history.
  ctx.moveObjects(objects, delta, worldDeltaOf(data));
  delete data.pendingMoveWorldPoint;
  ctx.log(`${objects.length} object(s) moved by ${formatPoint(delta)}`);
  return 'advance';
}

export function copyObjects(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) return run.gather(value) ? 'stay' : 'advance';
  if (active.stepIndex === 1) return takeBasePoint(run);

  const base = data.basePoint as Vec2;
  const target = value as Vec2;
  const localDelta = { x: target.x - base.x, y: target.y - base.y };
  // Exact if the viewport gave both ends in world space; otherwise what the view
  // makes of the drag; otherwise the work plane's own axes, which is the answer
  // when the drawing and the plane are the same thing.
  const plane = ctx.doc.activeWorkPlane;
  const viewWorldDelta = worldDeltaOf(data) ?? ctx.copyWorldDelta(localDelta);
  const solidDelta = viewWorldDelta ?? {
    x: plane.xAxis.x * localDelta.x + plane.yAxis.x * localDelta.y,
    y: plane.xAxis.y * localDelta.x + plane.yAxis.y * localDelta.y,
    z: plane.xAxis.z * localDelta.x + plane.yAxis.z * localDelta.y,
  };
  const copies = (data.entities as Entity[]).map((entity) => copyEntity(entity, localDelta, viewWorldDelta));
  const solidCopies = (data.solids as Solid[]).map((solid) => copySolid(solid, solidDelta));
  delete data.pendingMoveWorldPoint;
  applyTo(run, 'Copy', { entities: [], solids: [] }, { entities: copies, solids: solidCopies },
    (count) => `Copied ${count} object(s) by ${formatPoint(localDelta)}.`);
  // Back to asking for a target, so one selection can be copied again and again.
  // The step model has no way to say "repeat", so this walks the index back and
  // lets the manager step it forward again — the same trick POLYLINE uses.
  active.stepIndex = 1;
  return 'advance';
}
