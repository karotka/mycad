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
import { featureRemovalForPoint } from '../../solids/featureRemoval';
import { solidPlanarFaces } from '../../solids/SolidTopology';
import { directionalExtrusionFeature, extrusionFeature } from '../../solids/extrusion';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal, type WorkPlane } from '../../../math/workplane';
import type { Vec2, Vec3 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';
import { apply2dCornerModification, sameWorkPlane } from './edit2d';
import { buildExactFeature, deleteExactSolidFace, modifyExactSolidEdge, pressPullExactSolid, promoteSolidToExact } from '../../geometry/ExactSolid';

/** What a sweep can follow: anything with a length, open or closed. */
const isSweepPath = (entity: Entity): boolean =>
  entity.type === 'line' || entity.type === 'arc' || entity.type === 'bezier'
  || entity.type === 'polyline' || entity.type === 'circle';

export async function extrudeProfileStep(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, step, ctx } = run;
  if (step.kind === 'entity' && active.stepIndex === 0) {
    if (!value) return 'advance';
    const profile = value as Entity;
    if (!isSweepProfileEntity(profile)) {
      ctx.log('Extrude profile must be a closed circle, rectangle, octagon or polyline.');
      return 'stay';
    }
    run.gather(profile);
    return 'stay';
  }

  const entities = (data.entities as Entity[]).filter(isSweepProfileEntity);
  if (entities.length === 0) {
    ctx.log('No profile selected.');
    return 'advance';
  }

  if (step.kind === 'number-or-option') {
    if (typeof value === 'number') return completeLinearExtrude(run, entities, value);
    const option = String(value).trim().toUpperCase().replace(/[\s_-]+/g, '');
    if (option === 'P' || option === 'PATH') {
      data.extrudeMode = 'path';
      active.steps.splice(active.stepIndex + 1, 0, { kind: 'entity', label: 'Select extrusion path:' });
      return 'advance';
    }
    if (option === 'D' || option === 'DIRECTION') {
      data.extrudeMode = 'direction';
      active.steps.splice(active.stepIndex + 1, 0,
        { kind: 'point', label: 'Specify first direction point:' },
        { kind: 'point', label: 'Specify second direction point:' },
      );
      return 'advance';
    }
    if (option === 'T' || option === 'TAPER' || option === 'TAPERANGLE') {
      data.extrudeMode = 'taper';
      active.steps.splice(active.stepIndex + 1, 0,
        { kind: 'number', label: 'Specify taper angle:', remember: true },
        { kind: 'number', label: 'Specify extrusion height:', remember: true },
      );
      return 'advance';
    }
    ctx.log('Unknown EXTRUDE option. Enter a height, Direction, Path, or Taper angle.');
    return 'stay';
  }

  if (data.extrudeMode === 'path' && step.kind === 'entity') {
    const path = value as Entity;
    if (!isSweepPath(path)) {
      ctx.log('Extrusion path must be a line, polyline, arc, circle or bezier.');
      return 'stay';
    }
    return completePathExtrude(run, entities, path);
  }

  if (data.extrudeMode === 'direction' && step.kind === 'point') {
    const profilePlane = entities[0].workPlane ?? WORLD_WORK_PLANE;
    const point = extrusionWorldPoint(value as Vec2 | Vec3, profilePlane);
    if (!data.directionStart) {
      data.directionStart = point;
      return 'advance';
    }
    const start = data.directionStart as Vec3;
    if (Math.hypot(point.x - start.x, point.y - start.y, point.z - start.z) < 1e-9) {
      ctx.log('Direction points must be different.');
      return 'stay';
    }
    return completeDirectionalExtrude(run, entities, start, point);
  }

  if (data.extrudeMode === 'taper' && step.kind === 'number') {
    const entered = value as number;
    if (data.taperAngle === undefined) {
      if (!Number.isFinite(entered) || Math.abs(entered) >= 89.9) {
        ctx.log('Taper angle must be between -89.9 and 89.9 degrees.');
        return 'stay';
      }
      data.taperAngle = entered;
      return 'advance';
    }
    return completeLinearExtrude(run, entities, entered, data.taperAngle as number);
  }

  return 'stay';
}

const extrusionWorldPoint = (point: Vec2 | Vec3, plane: WorkPlane): Vec3 =>
  'z' in point ? { x: point.x, y: point.y, z: point.z } : localToWorld(plane, point);

async function completeLinearExtrude(
  run: CommandRun,
  profiles: Entity[],
  entered: number,
  taperAngle = 0,
): Promise<StepOutcome> {
  const { ctx } = run;
  if (Math.abs(entered) < 1e-9) {
    ctx.log('Extrusion height cannot be zero.');
    return 'stay';
  }
  ctx.log('Extruding…');
  const results = await Promise.all(profiles.map(async (profile) => {
    const feature = extrusionFeature(profile, entered, taperAngle);
    // Built from the feature, not beside it: the mesh and its editable recipe
    // stay the same answer for every selected profile.
    const exact = await buildExactFeature(feature);
    return exact ? { profile, feature, mesh: exact.mesh, exact } : null;
  }));
  const completed = results.filter((result): result is NonNullable<typeof result> => result !== null);
  if (completed.length === 0) {
    ctx.log(taperAngle
      ? 'Extrusion failed — the taper is too large for this profile and height.'
      : 'Extrusion failed — select one or more closed profiles.');
    return 'advance';
  }
  const solids = completed.map(({ profile, feature, mesh, exact }) => {
    const solid = ctx.doc.createSolid(mesh, `Extrusion_${profile.id}`, feature.height, [profile.id], undefined, feature);
    if (exact) solid.exact = exact.exact;
    return solid;
  });
  ctx.history.execute(new ReplaceObjectsEdit('Extrude', completed.map(({ profile }) => profile), [], [], solids));
  ctx.doc.viewMode = '3d';
  ctx.log(`Extrusion complete: ${solids.length} solid(s), height=${entered}${taperAngle ? `, taper=${taperAngle}°` : ''}`);
  return 'advance';
}

async function completeDirectionalExtrude(
  run: CommandRun,
  profiles: Entity[],
  start: Vec3,
  end: Vec3,
): Promise<StepOutcome> {
  const { ctx } = run;
  ctx.log('Extruding in direction…');
  const results = await Promise.all(profiles.map(async (profile) => {
    const plane = profile.workPlane ?? WORLD_WORK_PLANE;
    const localStart = worldToLocal(plane, start);
    const localEnd = worldToLocal(plane, end);
    const direction = {
      x: localEnd.x - localStart.x,
      y: localEnd.y - localStart.y,
      z: localEnd.z - localStart.z,
    };
    if (Math.abs(direction.z) < 1e-9) return null;
    const feature = directionalExtrusionFeature(profile, direction);
    const exact = await buildExactFeature(feature);
    return exact ? { profile, feature, mesh: exact.mesh, exact } : null;
  }));
  const completed = results.filter((result): result is NonNullable<typeof result> => result !== null);
  if (completed.length === 0) {
    ctx.log('Extrusion failed — Direction must cross the profile plane.');
    return 'advance';
  }
  const solids = completed.map(({ profile, feature, mesh, exact }) => {
    const solid = ctx.doc.createSolid(mesh, `Extrusion_${profile.id}`, feature.height, [profile.id], undefined, feature);
    if (exact) solid.exact = exact.exact;
    return solid;
  });
  ctx.history.execute(new ReplaceObjectsEdit('Extrude Direction', completed.map(({ profile }) => profile), [], [], solids));
  ctx.doc.viewMode = '3d';
  ctx.log(`Directional extrusion complete: ${solids.length} solid(s).`);
  return 'advance';
}

async function completePathExtrude(run: CommandRun, profiles: Entity[], path: Entity): Promise<StepOutcome> {
  const { ctx } = run;
  ctx.log('Extruding along path…');
  const results = await Promise.all(profiles.map(async (profile) => {
    const plane = profile.workPlane ?? path.workPlane ?? WORLD_WORK_PLANE;
    const feature = {
      kind: 'sweep' as const,
      createdBy: 'extrude' as const,
      profile: cloneEntity(profile),
      path: cloneEntity(path),
      workPlane: cloneWorkPlane(plane),
    };
    const exact = await buildExactFeature(feature);
    return exact ? { profile, feature, mesh: exact.mesh, exact } : null;
  }));
  const completed = results.filter((result): result is NonNullable<typeof result> => result !== null);
  if (completed.length === 0) {
    ctx.log('Extrusion failed — select a valid path that starts at the profile.');
    return 'advance';
  }
  const solids = completed.map(({ profile, feature, mesh, exact }) => {
    const solid = ctx.doc.createSolid(
      mesh, `Extrusion_${profile.id}_along_${path.id}`, 0, [profile.id, path.id], undefined, feature,
    );
    if (exact) solid.exact = exact.exact;
    return solid;
  });
  ctx.history.execute(new ReplaceObjectsEdit('Extrude Path', completed.map(({ profile }) => profile), [], [], solids));
  ctx.doc.viewMode = '3d';
  ctx.log(`Path extrusion complete: ${solids.length} solid(s).`);
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
  const feature = { kind: 'sweep' as const, profile: cloneEntity(profile), path: cloneEntity(path), workPlane: cloneWorkPlane(plane) };
  const exact = await buildExactFeature(feature);
  if (!exact) {
    ctx.log('Sweep failed — select a valid path and closed profile.');
    return 'advance';
  }
  const solid = ctx.doc.createSolid(exact.mesh, `Sweep_${profile.id}_${path.id}`, 0, [profile.id, path.id], undefined, feature);
  solid.exact = exact.exact;
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
  let exact: Awaited<ReturnType<typeof buildExactFeature>> = null;
  let mesh: SolidMesh | undefined;
  if (face?.region) {
    exact = await pressPullExactSolid(solid, face.region, delta, solid.revision + 1);
    mesh = exact?.mesh;
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
    ctx.log('PressPull requires a bounded planar face region. Select the face again.');
    return 'stay';
  } else if (solid.feature.kind === 'extrusion') {
    // The whole solid, and its height is a number it already carries — so this
    // edits the feature and regenerates rather than dragging the mesh.
    const next = JSON.parse(JSON.stringify(solid.feature)) as typeof solid.feature;
    next.height = Math.max(0.01, next.height + delta);
    exact = await buildExactFeature(next, solid.revision + 1);
    mesh = exact?.mesh;
    if (mesh) solid.feature = next;
  }
  if (!mesh) {
    ctx.log(face
      ? 'PressPull could not modify this solid here — try a smaller distance or a different face. Press Escape to cancel.'
      : 'PressPull failed — select a bounded planar face region or use a smaller distance.');
    return 'stay';
  }

  solid.mesh = mesh;
  if (solid.feature.kind === 'extrusion') solid.height = solid.feature.height;
  else {
    const zValues = Array.from(mesh.positions).filter((_coordinate, index) => index % 3 === 2);
    solid.height = Math.max(0.01, Math.max(...zValues) - Math.min(...zValues));
  }
  solid.revision++;
  if (exact) solid.exact = exact.exact;
  ctx.history.recordApplied(new UpdateSolidEdit('Press/Pull', before, cloneSolid(solid)));
  ctx.doc.notify();
  ctx.log(`PressPull complete, delta=${delta}`);
  return 'advance';
}

/** A picked solid edge arrives as a selection object; a 2D line arrives as an entity. */
const isEntityValue = (value: unknown): value is Entity =>
  !!value && typeof value === 'object' && 'type' in value && 'id' in value;

export async function modifyEdgeStep(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, ctx } = run;
  const rounded = active.name === 'FILLET';

  if (active.stepIndex === 0) {
    // Auto-detect: two 2D sides (each a line or a polyline) chamfer/fillet the
    // corner they meet at; a solid edge is the 3D operation and skips the
    // second-side step.
    if (isEntityValue(value)) {
      if (value.type === 'line' || value.type === 'polyline') {
        data.mode2d = true;
        data.first = { entity: value, pick: data.lastObjectPickPoint };
        ctx.doc.selectEntity(value.id);
        ctx.log('First side selected. Select the second side.');
        return 'advance'; // → second-side step
      }
      ctx.log(`${active.name} needs a 2D line, a polyline, or a solid edge.`);
      return 'stay';
    }
    const edge = value as SolidEdgeSelection;
    data.mode2d = false;
    data.edge = edge;
    ctx.doc.selectSolid(edge.solidId);
    ctx.log('Edge selected.');
    active.stepIndex = 1; // skip the 2D second-side step; finishStep lands on the size step
    return 'advance';
  }

  if (active.stepIndex === 1) {
    // Reached only in 2D mode: the second side (a line, or a side of the same polyline).
    if (!isEntityValue(value) || (value.type !== 'line' && value.type !== 'polyline')) {
      ctx.log('Select a second 2D side (line or polyline).');
      return 'stay';
    }
    const first = data.first as { entity: Entity };
    if (!sameWorkPlane(first.entity, value)) { ctx.log('Both sides must be on the same work plane.'); return 'stay'; }
    data.second = { entity: value, pick: data.lastObjectPickPoint };
    ctx.doc.selectEntity(value.id, true);
    return 'advance'; // → size step
  }

  if (data.mode2d) return apply2dCornerModification(run, rounded);

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
  const exact = await modifyExactSolidEdge(solid, edge, amount, rounded, amount2, solid.revision + 1);
  if (!exact) {
    ctx.log(`${active.name} failed. Use a smaller value or select a convex edge.`);
    return 'stay';
  }
  solid.mesh = exact.mesh;
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
  solid.exact = exact.exact;
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
  if (!feature.sourceMesh) return null;
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
  const nextRevision = solid.revision + 1;
  const exact = await buildExactFeature(after.feature, nextRevision);
  const fallback = feature.sourceMesh && {
    positions: new Float32Array(feature.sourceMesh.positions),
    indices: new Uint32Array(feature.sourceMesh.indices),
  };
  if (!exact && !fallback) return null;
  after.mesh = exact?.mesh ?? fallback!;
  after.height = after.feature.kind === 'primitive' || after.feature.kind === 'extrusion'
    ? after.feature.height
    : meshZSpan(after.mesh);
  after.revision = nextRevision;
  after.exact = exact?.exact;
  if (!exact && !await promoteSolidToExact(after)) return null;
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
  if (!face || typeof face.solidId !== 'string') {
    run.ctx.log('Delete Face requires a solid face.');
    return 'stay';
  }
  const solid = run.ctx.doc.getSolid(face.solidId);
  if (!solid) {
    run.ctx.log('Solid not found.');
    return 'stay';
  }

  const before = cloneSolid(solid);

  // First, try to remove whatever recorded feature made the surface under the
  // cursor — a hole's cutter, a bump's operand, a rounded edge. This is the only
  // path that can reach a curved face (a cylindrical hole wall), which the
  // planar heal below cannot select at all.
  if (face.hitPoint) {
    run.ctx.log('Finding the feature under the cursor…');
    let removal = await featureRemovalForPoint(solid, face.hitPoint, face.normal);
    // A raw curved hit comes from a rendered triangle rather than a planar face
    // region. Boolean subtraction can expose that triangle with the opposite
    // orientation to the cutter stored in the feature tree. Retry only this
    // curved-surface case; doing it for planar rim faces could mistake the top
    // of a block for the cap of the cylinder that cut its hole.
    if (!removal && face.vertexIndices.length === 0 && !face.region) {
      removal = await featureRemovalForPoint(solid, face.hitPoint, {
        x: -face.normal.x, y: -face.normal.y, z: -face.normal.z,
      });
    }
    if (removal) {
      const after = cloneSolid(solid);
      const exact = await buildExactFeature(removal.feature, solid.revision + 1);
      after.feature = removal.feature;
      after.mesh = exact?.mesh ?? removal.mesh;
      after.revision = solid.revision + 1;
      if (exact) after.exact = exact.exact;
      after.height = removal.feature.kind === 'extrusion' || removal.feature.kind === 'primitive'
        ? removal.feature.height
        : meshZSpan(removal.mesh);
      run.ctx.history.execute(new UpdateSolidEdit('Delete face', before, after));
      run.ctx.doc.clearSelection();
      run.ctx.doc.selectSolid(after.id);
      run.ctx.log('Delete Face complete — removed the feature under the cursor.');
      return 'advance';
    }
  }


  if (face.topologyFaceId !== undefined || face.hitPoint) {
    run.ctx.log('Removing and healing exact face…');
    const exact = await deleteExactSolidFace(solid, face, solid.revision + 1);
    if (exact) {
      const after = cloneSolid(solid);
      after.mesh = exact.mesh;
      after.exact = exact.exact;
      after.feature = { kind: 'mesh' };
      after.height = meshZSpan(exact.mesh);
      after.revision = solid.revision + 1;
      run.ctx.history.execute(new UpdateSolidEdit('Delete face', before, after));
      run.ctx.doc.clearSelection();
      run.ctx.doc.selectSolid(after.id);
      run.ctx.log('Delete Face complete — neighbouring B-rep surfaces were extended and healed.');
      return 'advance';
    }
  }

  // Fallback: heal a planar face by extending its neighbours. Needs a real
  // planar face, so a curved hit that found no feature to remove ends here.
  if (!Array.isArray(face.vertexIndices) || face.vertexIndices.length === 0) {
    run.ctx.log('Delete Face: nothing removable here. Click a hole, a rounded edge, or a planar face.');
    return 'stay';
  }
  const source = savedSourceMesh(solid);
  let after: Solid | null = null;
  let removedLatestFeature = false;
  if (source && !sourceHasFacePlane(source, face)) {
    after = await withoutLatestFeature(solid);
    removedLatestFeature = after !== null;
  }
  if (!after) {
    run.ctx.log('Delete Face cannot heal this face. Select a removable feature face or a face bounded by extendable B-rep surfaces.');
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
