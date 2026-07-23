/**
 * Making a solid out of a drawing, and changing one that exists.
 *
 * These are the commands that wait on the solid engine, which is why each of
 * them says what it is doing before it starts: a boolean blocks the frame for a
 * few hundred milliseconds, and silence for that long reads as nothing having
 * happened.
 */
import { ReplaceObjectsEdit, UpdateSolidEdit, cloneSolid } from '../../history/edits';
import { cloneEntity, isSweepProfileEntity, type Entity, type Solid, type SolidFaceSelection, type SolidEdgeSelection, type SolidMesh } from '../../entities/types';
import { deletePlanarSolidFace, modifySolidEdge, pressPullFace, pressPullRegion, pressPullSolid, regenerateSolidFeature, sweepProfile } from '../../solids/ManifoldEngine';
import { solidPlanarFaces } from '../../solids/SolidTopology';
import { extrusionFeature } from '../../solids/extrusion';
import { cloneWorkPlane, WORLD_WORK_PLANE } from '../../../math/workplane';
import type { CommandRun, StepOutcome } from '../types';

/** What a sweep can follow: anything with a length, open or closed. */
const isSweepPath = (entity: Entity): boolean =>
  entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier'
  || entity.type === 'polyline' || entity.type === 'circle';

export async function extrudeProfileStep(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, step, ctx } = run;
  if (step.kind === 'entity') {
    if (!value) return 'advance';
    const profile = value as Entity;
    if (!isSweepProfileEntity(profile)) {
      ctx.log('Extrude profile must be a closed circle, rectangle, octagon or polyline.');
      return 'stay';
    }
    run.gather(profile);
    return 'stay';
  }

  const entered = value as number;
  const entities = (data.entities as Entity[]).filter(isSweepProfileEntity);
  if (entities.length === 0) {
    ctx.log('No profile selected.');
    return 'advance';
  }
  if (Math.abs(entered) < 1e-9) {
    ctx.log('Extrusion height cannot be zero.');
    return 'stay';
  }
  ctx.log('Extruding…');
  const results = await Promise.all(entities.map(async (profile) => {
    const feature = extrusionFeature(profile, entered);
    // Built from the feature, not beside it: the mesh and its editable recipe
    // stay the same answer for every selected profile.
    const mesh = await regenerateSolidFeature(feature);
    return mesh ? { profile, feature, mesh } : null;
  }));
  const completed = results.filter((result): result is NonNullable<typeof result> => result !== null);
  if (completed.length === 0) {
    ctx.log('Extrusion failed — select one or more closed profiles.');
    return 'advance';
  }
  const solids = completed.map(({ profile, feature, mesh }) => ctx.doc.createSolid(
    mesh, `Extrusion_${profile.id}`, feature.height, [profile.id], undefined, feature,
  ));
  ctx.history.execute(new ReplaceObjectsEdit('Extrude', completed.map(({ profile }) => profile), [], [], solids));
  ctx.doc.viewMode = '3d';
  ctx.log(`Extrusion complete: ${solids.length} solid(s), height=${entered}`);
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
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) {
    ctx.log('PressPull distance must be greater than zero.');
    return 'stay';
  }
  const before = cloneSolid(solid);
  ctx.log('Applying PressPull…');

  const face = data.face as SolidFaceSelection | undefined;
  let mesh;
  if (face?.region) {
    mesh = await pressPullRegion(solid.mesh, face.region, delta);
    if (mesh) {
      solid.feature = {
        kind: 'presspull-region',
        source: JSON.parse(JSON.stringify(before.feature)),
        region: JSON.parse(JSON.stringify(face.region)),
        distance: delta,
        sourceMesh: {
          positions: Array.from(before.mesh.positions),
          indices: Array.from(before.mesh.indices),
        },
      };
    }
  } else if (face) {
    // Compatibility for selections stored by older projects. New picks always
    // carry a bounded planar region and take the parametric branch above.
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
  if (!mesh) {
    ctx.log('PressPull failed — select a bounded planar face region or use a smaller distance.');
    return 'stay';
  }

  solid.mesh = mesh;
  if (solid.feature.kind === 'extrusion') solid.height = solid.feature.height;
  else {
    const zValues = Array.from(mesh.positions).filter((_coordinate, index) => index % 3 === 2);
    solid.height = Math.max(0.01, Math.max(...zValues) - Math.min(...zValues));
  }
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

  const entered = rounded
    ? [Math.abs(value as number), Math.abs(value as number)] as const
    : (value as [number, number]).map(Math.abs) as [number, number];
  if (entered.some((distance) => !Number.isFinite(distance) || distance < 1e-6)) {
    ctx.log('Edge modification size must be greater than zero.');
    return 'stay';
  }
  const amount = entered[0];
  const amount2 = entered[1];
  const edge = data.edge as SolidEdgeSelection;
  const solid = ctx.doc.getSolid(edge.solidId);
  if (!solid) {
    ctx.log('Solid not found.');
    return 'stay';
  }
  const before = cloneSolid(solid);
  const mesh = await modifySolidEdge(solid.mesh, edge, amount, rounded, amount2);
  if (!mesh) {
    ctx.log(`${active.name} failed. Use a smaller value or select a convex edge.`);
    return 'stay';
  }
  solid.mesh = mesh;
  solid.feature = {
    kind: 'edge-modification',
    operation: rounded ? 'fillet' : 'chamfer',
    source: JSON.parse(JSON.stringify(solid.feature)),
    edge: JSON.parse(JSON.stringify(edge)),
    amount,
    ...(rounded ? {} : { amount2 }),
    // Plain arrays are intentional: the feature tree is serialized to JSON.
    sourceMesh: {
      positions: Array.from(before.mesh.positions),
      indices: Array.from(before.mesh.indices),
    },
  };
  solid.revision++;
  ctx.history.recordApplied(new UpdateSolidEdit(rounded ? 'Fillet edge' : 'Chamfer edge', before, cloneSolid(solid)));
  ctx.doc.notify();
  ctx.log(rounded
    ? `Fillet complete: R${amount.toFixed(3)} mm.`
    : `Chamfer complete: ${amount.toFixed(3)} × ${amount2.toFixed(3)} mm.`);
  return 'advance';
}

const meshZSpan = (mesh: SolidMesh): number => {
  let min = Infinity, max = -Infinity;
  for (let index = 2; index < mesh.positions.length; index += 3) {
    min = Math.min(min, mesh.positions[index]);
    max = Math.max(max, mesh.positions[index]);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? Math.max(0.01, max - min) : 0.01;
};

function savedSourceMesh(solid: Solid): SolidMesh | null {
  const feature = solid.feature;
  if (feature.kind !== 'edge-modification' && feature.kind !== 'presspull-region') return null;
  return {
    positions: new Float32Array(feature.sourceMesh.positions),
    indices: new Uint32Array(feature.sourceMesh.indices),
  };
}

async function withoutLatestFeature(solid: Solid): Promise<Solid | null> {
  const feature = solid.feature;
  if (feature.kind !== 'edge-modification' && feature.kind !== 'presspull-region') return null;
  const after = cloneSolid(solid);
  after.feature = JSON.parse(JSON.stringify(feature.source));
  after.mesh = (await regenerateSolidFeature(after.feature)) ?? {
    positions: new Float32Array(feature.sourceMesh.positions),
    indices: new Uint32Array(feature.sourceMesh.indices),
  };
  after.height = after.feature.kind === 'primitive' || after.feature.kind === 'extrusion'
    ? after.feature.height
    : meshZSpan(after.mesh);
  after.revision = solid.revision + 1;
  return after;
}

/** Whether the selected support plane was already present before the latest feature. */
function sourceHasFacePlane(source: SolidMesh, selected: SolidFaceSelection): boolean {
  const normalLength = Math.hypot(selected.normal.x, selected.normal.y, selected.normal.z);
  if (normalLength < 1e-9) return false;
  const normal = {
    x: selected.normal.x / normalLength,
    y: selected.normal.y / normalLength,
    z: selected.normal.z / normalLength,
  };
  const origin = selected.region?.plane.origin ?? selected.hitPoint;
  if (!origin) return false;
  const offset = normal.x * origin.x + normal.y * origin.y + normal.z * origin.z;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < source.positions.length; index += 3) {
    minX = Math.min(minX, source.positions[index]); maxX = Math.max(maxX, source.positions[index]);
    minY = Math.min(minY, source.positions[index + 1]); maxY = Math.max(maxY, source.positions[index + 1]);
    minZ = Math.min(minZ, source.positions[index + 2]); maxZ = Math.max(maxZ, source.positions[index + 2]);
  }
  const extent = Math.max(1, maxX - minX, maxY - minY, maxZ - minZ);
  const tolerance = extent * 1e-5;
  return solidPlanarFaces(source).some((face) => {
    const parallel = face.normal.x * normal.x + face.normal.y * normal.y + face.normal.z * normal.z > 1 - 1e-6;
    const faceOffset = normal.x * face.plane.origin.x + normal.y * face.plane.origin.y + normal.z * face.plane.origin.z;
    return parallel && Math.abs(faceOffset - offset) <= tolerance;
  });
}

/**
 * Deletes a picked face. A face introduced by the latest reversible modelling
 * feature removes that feature exactly; a baked convex body takes the geometric
 * half-space healing path.
 */
export async function deleteFaceStep(run: CommandRun): Promise<StepOutcome> {
  const face = run.value as SolidFaceSelection | undefined;
  if (!face || !Array.isArray(face.vertexIndices)) {
    run.ctx.log('Delete Face requires a planar solid face.');
    return 'stay';
  }
  const solid = run.ctx.doc.getSolid(face.solidId);
  if (!solid) {
    run.ctx.log('Solid not found.');
    return 'stay';
  }

  const before = cloneSolid(solid);
  const source = savedSourceMesh(solid);
  let after: Solid | null = null;
  let removedLatestFeature = false;
  if (source && !sourceHasFacePlane(source, face)) {
    after = await withoutLatestFeature(solid);
    removedLatestFeature = after !== null;
  }
  if (!after) {
    run.ctx.log('Healing face…');
    const mesh = await deletePlanarSolidFace(solid.mesh, face.vertexIndices);
    if (mesh) {
      after = cloneSolid(solid);
      after.mesh = mesh;
      after.feature = { kind: 'mesh' };
      after.height = meshZSpan(mesh);
      after.revision = solid.revision + 1;
    }
  }
  if (!after) {
    run.ctx.log('Delete Face cannot heal this face. Select a latest Chamfer/Fillet/PressPull face or a bounded face on a convex planar body.');
    return 'stay';
  }

  run.ctx.history.execute(new UpdateSolidEdit('Delete face', before, after));
  run.ctx.doc.clearSelection();
  run.ctx.doc.selectSolid(after.id);
  run.ctx.log(removedLatestFeature
    ? 'Delete Face complete — the latest modelling feature was removed.'
    : 'Delete Face complete — adjacent planes were extended and the body was healed.');
  return 'advance';
}
