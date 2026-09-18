/**
 * Moving what is already drawn: mirror, erase, rotate, scale.
 *
 * They are one family and it shows once they sit together — each gathers
 * objects, asks where from, and replaces them. What used to be repeated in every
 * one of them is `applyTo` now: the edit, the reselection of the results, and
 * saying how many. Two of them had also grown their own copy of the gathering
 * branch that `run.gather` already does.
 */
import { ReplaceObjectsEdit, cloneSolid } from '../../history/edits';
import { cloneEntity, cloneSurfaceValue, genId, transformEntityPoints, type Entity, type Solid, type Surface } from '../../entities/types';
import { rotateEntity, scaleEntity } from '../../entities/EntityTransform';
import { mirroredFeature, rotatedFeature, scaledFeature, translatedFeature } from '../../solids/featureTransform';
import { mirrorAffine, preserveExactTransform, rotationAffine, scaleAffine, translationAffine } from '../../geometry/ExactTransform';
import { cloneWorkPlane, localToWorld, worldToLocal, WORLD_WORK_PLANE, type WorkPlane } from '../../../math/workplane';
import { dist2, formatPoint, mirrorPoint2, type Vec2, type Vec3 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

export { rotateEntity, scaleEntity };

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
  preserveExactTransform(scaled, scaleAffine(base, { x: factor, y: factor, z: factor }));
  scaled.revision++;
  scaled.selected = true;
  return scaled;
}

/** Mirrors scaleSolid — a Surface has no `height` field to carry along, but
 *  is otherwise the same mesh-plus-feature-tree shape. */
export function scaleSurface(surface: Surface, base: Vec3, factor: number): Surface {
  const scaled = cloneSurfaceValue(surface);
  for (let index = 0; index < scaled.mesh.positions.length; index += 3) {
    scaled.mesh.positions[index] = base.x + (scaled.mesh.positions[index] - base.x) * factor;
    scaled.mesh.positions[index + 1] = base.y + (scaled.mesh.positions[index + 1] - base.y) * factor;
    scaled.mesh.positions[index + 2] = base.z + (scaled.mesh.positions[index + 2] - base.z) * factor;
  }
  scaled.feature = scaledFeature(scaled.feature, base, factor) ?? { kind: 'mesh' };
  preserveExactTransform(scaled, scaleAffine(base, { x: factor, y: factor, z: factor }));
  scaled.revision++;
  scaled.selected = true;
  return scaled;
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
  const rotationOrigin = localToWorld(plane, centerLocal, centerLocal.z);
  rotated.feature = rotatedFeature(rotated.feature, rotationOrigin, plane.zAxis, angle)
    ?? { kind: 'mesh' };
  preserveExactTransform(rotated, rotationAffine(rotationOrigin, plane.zAxis, angle));
  rotated.revision++;
  return rotated;
}

/** Mirrors rotateSolidAroundPlane for a Surface. */
export function rotateSurfaceAroundPlane(surface: Surface, centerLocal: Vec3, angle: number, plane: typeof WORLD_WORK_PLANE): Surface {
  const rotated = cloneSurfaceValue(surface);
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
  const rotationOrigin = localToWorld(plane, centerLocal, centerLocal.z);
  rotated.feature = rotatedFeature(rotated.feature, rotationOrigin, plane.zAxis, angle) ?? { kind: 'mesh' };
  preserveExactTransform(rotated, rotationAffine(rotationOrigin, plane.zAxis, angle));
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
  preserveExactTransform(copy, translationAffine(delta));
  copy.revision++;
  return copy;
}

/** Mirrors copySolid for a Surface. */
export function copySurface(surface: Surface, delta: Vec3): Surface {
  const copy = cloneSurfaceValue(surface);
  copy.id = genId('surface');
  copy.name = `${surface.name}_copy`;
  copy.selected = false;
  for (let index = 0; index < copy.mesh.positions.length; index += 3) {
    copy.mesh.positions[index] += delta.x;
    copy.mesh.positions[index + 1] += delta.y;
    copy.mesh.positions[index + 2] += delta.z;
  }
  copy.feature = translatedFeature(copy.feature, delta) ?? { kind: 'mesh' };
  preserveExactTransform(copy, translationAffine(delta));
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
  before: { entities: Entity[]; solids: Solid[]; surfaces?: Surface[] },
  after: { entities: Entity[]; solids: Solid[]; surfaces?: Surface[] },
  message: (count: number) => string,
): StepOutcome {
  const { ctx } = run;
  const beforeSurfaces = before.surfaces ?? [];
  const afterSurfaces = after.surfaces ?? [];
  ctx.history.execute(new ReplaceObjectsEdit(
    label, before.entities, before.solids, after.entities, after.solids, beforeSurfaces, afterSurfaces,
  ));
  ctx.doc.clearSelection();
  after.entities.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
  after.solids.forEach((solid) => ctx.doc.selectSolid(solid.id, true));
  afterSurfaces.forEach((surface) => ctx.doc.selectSurface(surface.id, true));
  ctx.log(message(after.entities.length + after.solids.length + afterSurfaces.length));
  return 'advance';
}

/**
 * A point picked in the active work plane, read in the plane the entity being
 * transformed actually lives on.
 *
 * A base or axis point arrives in the plane the user picked it in; an entity's
 * own points are in its own. Where the two differ — anything drawn while the
 * UCS was somewhere else — applying one to the other turned, scaled or
 * mirrored the object about a line nowhere near the one picked, and it landed
 * far from where it belongs. Reported as MIRROR occasionally throwing a copy
 * a long way off, with no way to reproduce it: the distance is exactly how
 * far apart the two plane origins happen to be.
 *
 * Null when the entity's plane is not parallel to the active one. A flat
 * transform in one plane is not a flat transform in another facing a
 * different way, and an entity has only the one plane to lie on, so there is
 * no answer to give rather than a wrong one.
 */
function pickedPointInEntityPlane(point: Vec2, activePlane: WorkPlane, entity: Entity): Vec2 | null {
  const plane = entity.workPlane ?? WORLD_WORK_PLANE;
  const normals = plane.zAxis.x * activePlane.zAxis.x + plane.zAxis.y * activePlane.zAxis.y + plane.zAxis.z * activePlane.zAxis.z;
  if (Math.abs(Math.abs(normals) - 1) > 1e-9) return null;
  const local = worldToLocal(plane, localToWorld(activePlane, point));
  return { x: local.x, y: local.y };
}

/** What to say when a transform cannot reach an entity on a plane facing a
 *  different way — named, because silence there looked like the object had
 *  simply been skipped. */
function reportOffPlane(ctx: CommandRun['ctx'], command: string, count: number): void {
  if (count > 0) ctx.log(`${command}: ${count} object(s) lie on a work plane facing a different way and were left alone.`);
}

export function mirrorObjects(run: CommandRun): StepOutcome {
  const { active, data, value, step, ctx } = run;
  if (step.kind === 'entity') {
    if (run.gather(value)) return 'stay';
    return 'advance';
  }
  if (active.stepIndex === 1) { data.axisStart = value; return 'advance'; }
  if (active.stepIndex === 2) { data.axisEnd = value; return 'advance'; }

  // The last step asks whether the originals go. Enter takes last time's
  // answer, and No the first time — AutoCAD's own default, since a mirror
  // that quietly deleted what it was given would be a surprise.
  const eraseSource = /^y/i.test(typeof value === 'string' ? value.trim() : '');
  const axisStart = data.axisStart as Vec2;
  const axisEnd = data.axisEnd as Vec2;
  const entities = data.entities as Entity[];
  const solids = (data.solids as Solid[] | undefined) ?? [];
  const surfaces = (data.surfaces as Surface[] | undefined) ?? [];
  const plane = ctx.doc.activeWorkPlane;
  // A mirror keeps the originals, so the copies need ids of their own.
  let offPlane = 0;
  const mirrored = entities.flatMap((entity) => {
    const start = pickedPointInEntityPlane(axisStart, plane, entity);
    const end = pickedPointInEntityPlane(axisEnd, plane, entity);
    if (!start || !end) { offPlane++; return []; }
    const copy = transformEntityPoints(entity, (point) => mirrorPoint2(point, start, end));
    // A reflection reverses the way round every arc turns, and a polyline says
    // that with the sign of its bulge — left alone, a mirrored slot's caps bow
    // into the slot instead of out of it.
    if (copy.type === 'polyline' && copy.bulges) copy.bulges = copy.bulges.map((bulge) => -bulge);
    copy.id = genId(entity.type);
    return [copy];
  });
  reportOffPlane(ctx, 'MIRROR', offPlane);
  const mirrorMesh = <T extends Solid | Surface>(clone: T): T => {
    for (let index = 0; index < clone.mesh.positions.length; index += 3) {
      const local = worldToLocal(plane, {
        x: clone.mesh.positions[index],
        y: clone.mesh.positions[index + 1],
        z: clone.mesh.positions[index + 2],
      });
      const reflected = mirrorPoint2(local, axisStart, axisEnd);
      const world = localToWorld(plane, reflected, local.z);
      clone.mesh.positions[index] = world.x;
      clone.mesh.positions[index + 1] = world.y;
      clone.mesh.positions[index + 2] = world.z;
    }
    // A reflection reverses handedness, so restore outward triangle winding.
    for (let index = 0; index + 2 < clone.mesh.indices.length; index += 3) {
      const second = clone.mesh.indices[index + 1];
      clone.mesh.indices[index + 1] = clone.mesh.indices[index + 2];
      clone.mesh.indices[index + 2] = second;
    }
    clone.feature = mirroredFeature(clone.feature, plane, axisStart, axisEnd) ?? { kind: 'mesh' };
    preserveExactTransform(clone, mirrorAffine(plane, axisStart, axisEnd));
    clone.revision++;
    clone.selected = false;
    return clone;
  };
  const mirroredSolids = solids.map((solid) => {
    const copy = cloneSolid(solid);
    copy.id = genId('solid');
    copy.name = `${solid.name}_mirror`;
    return mirrorMesh(copy);
  });
  const mirroredSurfaces = surfaces.map((surface) => {
    const copy = cloneSurfaceValue(surface);
    copy.id = genId('surface');
    copy.name = `${surface.name}_mirror`;
    return mirrorMesh(copy);
  });
  // Erasing the source is the same edit, undone in one step with the copies:
  // what goes on the "before" side of the replacement.
  ctx.history.execute(new ReplaceObjectsEdit(
    'Mirror',
    eraseSource ? entities.map(cloneEntity) : [],
    eraseSource ? solids.map(cloneSolid) : [],
    mirrored, mirroredSolids,
    eraseSource ? surfaces.map(cloneSurfaceValue) : [], mirroredSurfaces,
  ));
  const count = mirrored.length + mirroredSolids.length + mirroredSurfaces.length;
  ctx.log(`Mirrored ${count} object(s)${eraseSource ? ', source erased' : ''}.`);
  return 'advance';
}

export function eraseObjects(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0 && run.gather(value)) return 'stay';

  // Enter: everything gathered goes in one undoable edit.
  const entities = (data.entities as Entity[]).map(cloneEntity);
  const solids = (data.solids as Solid[]).map(cloneSolid);
  const surfaces = ((data.surfaces as Surface[] | undefined) ?? []).map(cloneSurfaceValue);
  if (entities.length + solids.length + surfaces.length === 0) {
    ctx.log('Nothing to delete.');
    run.cancel();
    return 'advance';
  }
  ctx.history.execute(new ReplaceObjectsEdit('Delete objects', entities, solids, [], [], surfaces, []));
  ctx.log(`Deleted ${entities.length + solids.length + surfaces.length} object(s).`);
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
  const surfaces = (data.surfaces as Surface[] | undefined) ?? [];
  // Solids turn about the same axis the drawing does: the work plane's normal,
  // through the base point.
  const plane = ctx.doc.activeWorkPlane;
  return applyTo(run, 'Rotate',
    { entities, solids, surfaces },
    {
      entities: entities.map((entity) => {
        // The base was picked in the active plane; each entity turns about it
        // read in its own — see pickedPointInEntityPlane.
        const centre = pickedPointInEntityPlane(base, plane, entity);
        return centre ? rotateEntity(entity, centre, angle) : cloneEntity(entity);
      }),
      solids: solids.map((solid) => rotateSolidAroundPlane(cloneSolid(solid), { x: base.x, y: base.y, z: 0 }, angle, plane)),
      surfaces: surfaces.map((surface) => rotateSurfaceAroundPlane(cloneSurfaceValue(surface), { x: base.x, y: base.y, z: 0 }, angle, plane)),
    },
    (count) => `Rotated ${count} object(s) by ${(angle * 180 / Math.PI).toFixed(3)}°.`);
}

/**
 * AutoCAD-style scaling. Picking a factor by distance can only ever grow (any
 * point is more than one unit from the base), so this works by reference: the
 * base is also the reference origin, the next point sets the current length,
 * and the final point sets its new length. The factor is new/reference.
 */
export function scaleObjects(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) return run.gather(value) ? 'stay' : 'advance';
  if (active.stepIndex === 1) {
    data.basePoint = value;
    data.baseWorldPoint = data.pendingMoveWorldPoint;
    delete data.pendingMoveWorldPoint;
    return 'advance';
  }
  if (active.stepIndex === 2) {
    const base = data.basePoint as Vec2;
    const length = (data.enteredReferenceLength as number | undefined) ?? dist2(base, value as Vec2);
    delete data.enteredReferenceLength;
    if (!Number.isFinite(length) || length <= 1e-9) {
      ctx.log('Reference length must be greater than zero. Pick a point away from the base point.');
      return 'stay';
    }
    data.referenceLength = length;
    return 'advance';
  }

  // New length (step 3): the factor is new length ÷ reference length.
  const base = data.basePoint as Vec2;
  const reference = data.referenceLength as number;
  const newLength = (data.enteredNewLength as number | undefined) ?? dist2(base, value as Vec2);
  delete data.enteredNewLength;
  return applyScale(run, newLength / reference);
}

/** Commit a scale by `factor`. */
function applyScale(run: CommandRun, factor: number): StepOutcome {
  const { data, ctx } = run;
  if (!Number.isFinite(factor) || factor <= 1e-9) {
    ctx.log('Scale factor must be greater than zero.');
    return 'stay';
  }
  const base = data.basePoint as Vec2;
  const entities = data.entities as Entity[];
  const solids = data.solids as Solid[];
  const surfaces = (data.surfaces as Surface[] | undefined) ?? [];
  const baseWorld = (data.baseWorldPoint as Vec3 | undefined) ?? localToWorld(ctx.doc.activeWorkPlane, base);
  return applyTo(run, 'Scale',
    { entities, solids, surfaces },
    {
      entities: entities.map((entity) => {
        const origin = pickedPointInEntityPlane(base, ctx.doc.activeWorkPlane, entity);
        const scaled = origin ? scaleEntity(entity, origin, factor) : cloneEntity(entity);
        scaled.selected = true;
        return scaled;
      }),
      solids: solids.map((solid) => scaleSolid(solid, baseWorld, factor)),
      surfaces: surfaces.map((surface) => scaleSurface(surface, baseWorld, factor)),
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
    ...((data.surfaces as Surface[] | undefined) ?? []).map((surface) => surface.id),
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
  const surfaceCopies = ((data.surfaces as Surface[] | undefined) ?? []).map((surface) => copySurface(surface, solidDelta));
  delete data.pendingMoveWorldPoint;
  applyTo(run, 'Copy', { entities: [], solids: [] }, { entities: copies, solids: solidCopies, surfaces: surfaceCopies },
    (count) => `Copied ${count} object(s) by ${formatPoint(localDelta)}.`);
  // Back to asking for a target, so one selection can be copied again and again.
  // The step model has no way to say "repeat", so this walks the index back and
  // lets the manager step it forward again — the same trick POLYLINE uses.
  active.stepIndex = 1;
  return 'advance';
}

/**
 * MATCHPROP: give objects the look of another one.
 *
 * Layer, colour and linetype scale — the three things that decide how an object
 * is drawn without changing where it is. Not its geometry, and not the style
 * fields a dimension carries: those belong to the dimension style, which has
 * its own way of reaching every dimension at once.
 */
export function matchProperties(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) {
    data.source = value;
    const source = value as Entity;
    ctx.log(`Properties taken from ${source.type} on layer ${source.layer}. Select objects to paint, then press Enter.`);
    return 'advance';
  }
  if (run.gather(value)) return 'stay';
  const source = data.source as Entity;
  const targets = ((data.entities as Entity[] | undefined) ?? []).filter((entity) => entity.id !== source.id);
  if (targets.length === 0) {
    ctx.log('MATCHPROP: select at least one object to paint.');
    return 'stay';
  }
  const painted = targets.map((entity) => {
    const copy = cloneEntity(entity);
    copy.layer = source.layer;
    copy.aci = source.aci;
    copy.color = source.color;
    if (source.linetypeScale === undefined) delete copy.linetypeScale;
    else copy.linetypeScale = source.linetypeScale;
    return copy;
  });
  return applyTo(run, 'Match properties',
    { entities: targets, solids: [] },
    { entities: painted, solids: [] },
    (count) => `Painted ${count} object(s) with the source's layer, colour and linetype scale.`);
}

/**
 * 3DROTATE: turn objects about any axis in space, not only about the work
 * plane's normal the way ROTATE does.
 *
 * The axis is the two picked points, which is the general case and needs no
 * keywords: pick along an edge for "turn about this edge", or use the UCS cross
 * to pick along an axis.
 *
 * An entity's points are stored in its own work plane, so turning the *plane*
 * turns the whole entity rigidly, whatever is drawn on it — including a curve
 * whose points carry their own elevation. A solid turns by its mesh, its
 * feature tree and its exact geometry together, as every other transform does.
 */
export function rotateObjects3d(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) return run.gather(value) ? 'stay' : 'advance';
  const plane = ctx.doc.activeWorkPlane;
  if (active.stepIndex === 1) {
    data.axisStart = localToWorld(plane, value as Vec2, ((value as Vec2 & { z?: number }).z) ?? 0);
    return 'advance';
  }
  if (active.stepIndex === 2) {
    const start = data.axisStart as Vec3;
    const end = localToWorld(plane, value as Vec2, ((value as Vec2 & { z?: number }).z) ?? 0);
    const axis = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
    if (Math.hypot(axis.x, axis.y, axis.z) < 1e-9) {
      ctx.log('The two axis points must be different. Specify the second point again.');
      return 'stay';
    }
    data.axis = axis;
    return 'advance';
  }
  const origin = data.axisStart as Vec3;
  const axis = data.axis as Vec3;
  const angle = Number(value) * Math.PI / 180;
  if (!Number.isFinite(angle)) { ctx.log('Enter a rotation angle in degrees.'); return 'stay'; }
  const entities = (data.entities as Entity[] | undefined) ?? [];
  const solids = (data.solids as Solid[] | undefined) ?? [];
  const surfaces = (data.surfaces as Surface[] | undefined) ?? [];
  return applyTo(run, '3D rotate',
    { entities, solids, surfaces },
    {
      entities: entities.map((entity) => rotateEntityAboutAxis(entity, origin, axis, angle)),
      solids: solids.map((solid) => rotateBodyAboutAxis(cloneSolid(solid), origin, axis, angle)),
      surfaces: surfaces.map((surface) => rotateBodyAboutAxis(cloneSurfaceValue(surface), origin, axis, angle)),
    },
    (count) => `Rotated ${count} object(s) by ${Number(value)}° about the picked axis.`);
}

/** Turns a point about an axis through `origin` (Rodrigues' rotation). */
function turnedPoint(point: Vec3, origin: Vec3, unit: Vec3, angle: number): Vec3 {
  const relative = { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z };
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dot = relative.x * unit.x + relative.y * unit.y + relative.z * unit.z;
  const cross = {
    x: unit.y * relative.z - unit.z * relative.y,
    y: unit.z * relative.x - unit.x * relative.z,
    z: unit.x * relative.y - unit.y * relative.x,
  };
  return {
    x: origin.x + relative.x * cos + cross.x * sin + unit.x * dot * (1 - cos),
    y: origin.y + relative.y * cos + cross.y * sin + unit.y * dot * (1 - cos),
    z: origin.z + relative.z * cos + cross.z * sin + unit.z * dot * (1 - cos),
  };
}

function unitAxis(axis: Vec3): Vec3 {
  const length = Math.hypot(axis.x, axis.y, axis.z);
  return { x: axis.x / length, y: axis.y / length, z: axis.z / length };
}

/**
 * An entity turned rigidly: its own work plane turns, its stored points do not.
 * Rotating the points instead would only ever turn it within its own plane,
 * which is what ROTATE already does.
 */
export function rotateEntityAboutAxis(entity: Entity, origin: Vec3, axis: Vec3, angle: number): Entity {
  const unit = unitAxis(axis);
  const plane = cloneWorkPlane(entity.workPlane ?? WORLD_WORK_PLANE);
  const turnedDirection = (direction: Vec3): Vec3 => {
    const moved = turnedPoint({ x: plane.origin.x + direction.x, y: plane.origin.y + direction.y, z: plane.origin.z + direction.z }, origin, unit, angle);
    const movedOrigin = turnedPoint(plane.origin, origin, unit, angle);
    return { x: moved.x - movedOrigin.x, y: moved.y - movedOrigin.y, z: moved.z - movedOrigin.z };
  };
  const copy = cloneEntity(entity);
  copy.workPlane = {
    xAxis: turnedDirection(plane.xAxis),
    yAxis: turnedDirection(plane.yAxis),
    zAxis: turnedDirection(plane.zAxis),
    origin: turnedPoint(plane.origin, origin, unit, angle),
  };
  return copy;
}

/** A solid or surface turned about the same axis: mesh, recipe and exact
 *  geometry together, so it can still be rebuilt afterwards. */
function rotateBodyAboutAxis<T extends Solid | Surface>(body: T, origin: Vec3, axis: Vec3, angle: number): T {
  const unit = unitAxis(axis);
  for (let index = 0; index + 2 < body.mesh.positions.length; index += 3) {
    const turned = turnedPoint(
      { x: body.mesh.positions[index], y: body.mesh.positions[index + 1], z: body.mesh.positions[index + 2] },
      origin, unit, angle,
    );
    body.mesh.positions[index] = turned.x;
    body.mesh.positions[index + 1] = turned.y;
    body.mesh.positions[index + 2] = turned.z;
  }
  body.feature = rotatedFeature(body.feature, origin, unit, angle) ?? { kind: 'mesh' };
  preserveExactTransform(body, rotationAffine(origin, unit, angle));
  body.revision++;
  body.selected = false;
  return body;
}
