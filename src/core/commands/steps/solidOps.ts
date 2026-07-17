/**
 * Making a solid out of a drawing, and changing one that exists.
 *
 * These are the commands that wait on the solid engine, which is why each of
 * them says what it is doing before it starts: a boolean blocks the frame for a
 * few hundred milliseconds, and silence for that long reads as nothing having
 * happened.
 */
import { ReplaceObjectsEdit, UpdateSolidEdit, cloneSolid } from '../../history/edits';
import { cloneEntity, isSweepProfileEntity, type Entity, type SolidFaceSelection, type SolidEdgeSelection } from '../../entities/types';
import { modifySolidEdge, pressPullFace, pressPullSolid, regenerateSolidFeature, sweepProfile } from '../../solids/ManifoldEngine';
import { extrusionFeature } from '../../solids/extrusion';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../../../math/workplane';
import type { CommandRun, StepOutcome } from '../types';

/** What a sweep can follow: anything with a length, open or closed. */
const isSweepPath = (entity: Entity): boolean =>
  entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier'
  || entity.type === 'polyline' || entity.type === 'circle';

export async function extrudeProfileStep(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, step, ctx } = run;
  if (step.kind === 'entity' && value) {
    (data.entities as Entity[]).push(value as Entity);
    ctx.log(`Profile added: ${(value as Entity).type} (${(value as Entity).id})`);
    // One profile is enough, so this jumps straight to asking for the height
    // rather than gathering more.
    active.stepIndex = 1;
    return 'stay';
  }

  const entered = value as number;
  const entities = data.entities as Entity[];
  if (entities.length === 0) {
    ctx.log('No profile selected.');
    return 'advance';
  }
  if (Math.abs(entered) < 1e-9) {
    ctx.log('Extrusion height cannot be zero.');
    return 'stay';
  }
  ctx.log('Extruding…');
  const feature = extrusionFeature(entities[0], entered);
  // Built from the feature, not beside it: the mesh used to come from
  // extrudeProfile while the feature described the same solid a second time, so
  // the shape you got and the shape it regenerated into were two answers that
  // only happened to agree.
  const mesh = await regenerateSolidFeature(feature);
  if (!mesh) {
    ctx.log('Extrusion failed — select a closed profile.');
    return 'advance';
  }
  const solid = ctx.doc.createSolid(
    mesh, `Extrusion_${entities.map((entity) => entity.id).join('_')}`,
    feature.height, entities.map((entity) => entity.id), undefined, feature,
  );
  ctx.history.execute(new ReplaceObjectsEdit('Extrude', entities, [], [], [solid]));
  ctx.doc.viewMode = '3d';
  ctx.log(`Extrusion complete, height=${entered}`);
  return 'advance';
}

export async function sweepProfileStep(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, step, ctx } = run;
  if (step.kind !== 'entity' || !value) return 'advance';

  if (active.stepIndex === 0) {
    const entity = value as Entity;
    if (!isSweepProfileEntity(entity)) {
      ctx.log('Sweep profile must be a closed 2D object.');
      return 'stay';
    }
    data.profile = entity;
    ctx.log(`Profile selected: ${entity.type} (${entity.id})`);
    return 'advance';
  }

  const profile = data.profile as Entity | undefined;
  const path = value as Entity;
  if (!profile) {
    ctx.log('No profile selected.');
    return 'advance';
  }
  if (!isSweepPath(path)) {
    ctx.log('Sweep path must be a line, arc, bezier, polyline or circle.');
    return 'stay';
  }
  ctx.log('Sweeping…');
  const plane = profile.workPlane ?? path.workPlane ?? WORLD_WORK_PLANE;
  const mesh = await sweepProfile(profile, path, plane);
  if (!mesh) {
    ctx.log('Sweep failed — select a valid path and closed profile.');
    return 'advance';
  }
  const solid = ctx.doc.createSolid(
    mesh, `Sweep_${profile.id}_${path.id}`, 0, [profile.id, path.id], undefined,
    { kind: 'sweep', profile: cloneEntity(profile), path: cloneEntity(path), workPlane: cloneWorkPlane(plane) },
  );
  ctx.history.execute(new ReplaceObjectsEdit('Sweep', [profile], [], [], [solid]));
  ctx.doc.clearSelection();
  ctx.doc.selectSolid(solid.id);
  ctx.doc.viewMode = '3d';
  ctx.log(`Sweep complete (${profile.id} along ${path.id}).`);
  return 'advance';
}

export async function pressPullStep(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) {
    if (typeof value === 'string') {
      data.solidId = value;
    } else {
      const face = value as SolidFaceSelection;
      data.solidId = face.solidId;
      data.face = face;
    }
    return 'advance';
  }

  const solid = ctx.doc.getSolid(data.solidId as string);
  if (!solid) {
    ctx.log('Solid not found.');
    return 'advance';
  }
  const delta = value as number;
  const before = cloneSolid(solid);
  ctx.log('Applying PressPull…');

  const face = data.face as SolidFaceSelection | undefined;
  let mesh;
  if (face) {
    // An arbitrary face push is not a parameter of anything, so this is one of
    // the two places that honestly has to bake. See BACKLOG.md.
    mesh = pressPullFace(solid.mesh, face.vertexIndices, face.normal, delta);
    if (mesh) solid.feature = { kind: 'mesh' };
  } else if (solid.feature.kind === 'extrusion') {
    // The whole solid, and its height is a number it already carries — so this
    // edits the feature and regenerates rather than dragging the mesh.
    const next = JSON.parse(JSON.stringify(solid.feature)) as typeof solid.feature;
    next.height = Math.max(0.01, next.height + delta);
    mesh = await regenerateSolidFeature(next);
    if (mesh) solid.feature = next;
  } else {
    mesh = await pressPullSolid(solid.mesh, delta);
  }
  if (!mesh) return 'advance';

  solid.mesh = mesh;
  solid.height = solid.feature.kind === 'extrusion' ? solid.feature.height : Math.max(0.01, solid.height + delta);
  solid.revision++;
  ctx.history.recordApplied(new UpdateSolidEdit('Press/Pull', before, cloneSolid(solid)));
  ctx.doc.notify();
  ctx.log(`PressPull complete, delta=${delta}`);
  return 'advance';
}

export async function modifyEdgeStep(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, ctx } = run;
  const rounded = active.name === 'FILLET';

  if (active.stepIndex === 0) {
    const edge = value as SolidEdgeSelection;
    data.edge = edge;
    ctx.doc.selectSolid(edge.solidId);
    ctx.log('Edge selected.');
    return 'advance';
  }

  const amount = Math.abs(value as number);
  if (amount < 1e-6) {
    ctx.log('Edge modification size must be greater than zero.');
    return 'stay';
  }
  const edge = data.edge as SolidEdgeSelection;
  const solid = ctx.doc.getSolid(edge.solidId);
  if (!solid) {
    ctx.log('Solid not found.');
    return 'stay';
  }
  const before = cloneSolid(solid);
  const mesh = await modifySolidEdge(solid.mesh, edge, amount, rounded);
  if (!mesh) {
    ctx.log(`${active.name} failed. Use a smaller value or select a convex edge.`);
    return 'stay';
  }
  solid.mesh = mesh;
  // There is no fillet feature to write to, and the mesh is cut rather than
  // rebuilt, so this is the other honest bake. See BACKLOG.md.
  solid.feature = { kind: 'mesh' };
  solid.revision++;
  ctx.history.recordApplied(new UpdateSolidEdit(rounded ? 'Fillet edge' : 'Chamfer edge', before, cloneSolid(solid)));
  ctx.doc.notify();
  ctx.log(`${rounded ? 'Fillet' : 'Chamfer'} complete: ${amount.toFixed(3)} mm.`);
  return 'advance';
}
