import type { Vec2, Vec3 } from '../../../math/geometry';
import { localToWorld } from '../../../math/workplane';
import type { SerializedSolidMesh, Solid, SolidFaceSelection, SolidFeature, SolidMesh, Surface } from '../../entities/types';
import { ReplaceObjectsEdit } from '../../history/edits';
import { exactResult, openExactShape, promoteSolidToExact, sliceExactSurface, slicePieceSide } from '../../geometry/ExactSolid';
import { openCascadeKernel } from '../../geometry/OpenCascadeRuntime';
import type { CommandContext, CommandRun, StepOutcome } from '../types';

export interface CuttingPlane {
  origin: Vec3;
  normal: Vec3;
}

/**
 * The geometry a slice was cut from, kept only when the source has no recipe
 * of its own to rebuild from — the same rule shell and draft follow, so a file
 * does not carry a mesh it will never read.
 */
function sliceSourceMesh(source: Solid): { sourceMesh?: SerializedSolidMesh } {
  if (source.feature.kind !== 'mesh') return {};
  return {
    sourceMesh: {
      positions: Array.from(source.mesh.positions),
      indices: Array.from(source.mesh.indices),
    },
  };
}

export function isFaceSelection(value: unknown): value is SolidFaceSelection {
  return Boolean(value && typeof value === 'object' && 'solidId' in value && 'vertexIndices' in value && 'normal' in value);
}

/** Command points are local to the active UCS; their optional z is its height. */
export function pointInWorld(ctx: CommandContext, value: unknown): Vec3 {
  const point = value as Vec2 & { z?: number };
  return localToWorld(ctx.doc.activeWorkPlane, point, point.z ?? 0);
}

export function planeFromFace(ctx: CommandContext, face: SolidFaceSelection): CuttingPlane | null {
  const solid = ctx.doc.getSolid(face.solidId);
  const vertex = face.vertexIndices.find((index) => index >= 0 && index * 3 + 2 < (solid?.mesh.positions.length ?? 0));
  if (!solid || vertex === undefined) return null;
  const offset = vertex * 3;
  return {
    origin: {
      x: solid.mesh.positions[offset],
      y: solid.mesh.positions[offset + 1],
      z: solid.mesh.positions[offset + 2],
    },
    normal: { ...face.normal },
  };
}

export function planeFromPoints(first: Vec3, second: Vec3, third: Vec3): CuttingPlane | null {
  const a = { x: second.x - first.x, y: second.y - first.y, z: second.z - first.z };
  const b = { x: third.x - first.x, y: third.y - first.y, z: third.z - first.z };
  const normal = {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
  return Math.hypot(normal.x, normal.y, normal.z) < 1e-9
    ? null
    : { origin: first, normal };
}

function slicedPiece(
  ctx: CommandContext,
  source: Solid,
  mesh: SolidMesh,
  index: number,
  feature: SolidFeature,
  exact?: NonNullable<Solid['exact']>,
): Solid {
  const piece = ctx.doc.createSolid(
    mesh,
    `${source.name}_Slice${index}`,
    source.height,
    [...source.sourceEntityIds],
    source.color,
    feature,
  );
  // A cut changes shape, not ownership or appearance.
  piece.layer = source.layer;
  piece.aci = source.aci;
  piece.color = source.color;
  piece.exact = exact;
  return piece;
}

async function applySlice(ctx: CommandContext, sources: readonly Solid[], plane: CuttingPlane): Promise<boolean> {
  ctx.log(`Slicing ${sources.length} solid(s)…`);
  const removed: Solid[] = [];
  const pieces: Solid[] = [];
  const exactKernel = await openCascadeKernel();
  for (const source of sources) {
    const current = ctx.doc.getSolid(source.id);
    if (!current) continue;
    if (!await promoteSolidToExact(current)) continue;
    const exactSource = await openExactShape(current, exactKernel);
    if (!exactSource) continue;
    try {
      const exactPieces = exactKernel.splitByPlane(exactSource, plane);
      if (exactPieces.length < 2) {
        exactPieces.forEach((piece) => piece.dispose());
        continue;
      }
      removed.push(current);
      // A cut into exactly two keeps its recipe: each piece is "the source,
      // cut by this plane, the half on this side", so an earlier feature can
      // still be edited and both halves follow. A cut into more than two has
      // no such name for a piece (see SliceFeature), so those stay baked.
      const sides = exactPieces.map((piece) => slicePieceSide(exactKernel, piece, plane));
      const nameable = exactPieces.length === 2 && sides[0] !== sides[1];
      const sourceFeature = current.feature;
      const keptMesh = sliceSourceMesh(current);
      exactPieces.forEach((pieceShape, index) => {
        try {
          const geometry = exactResult(exactKernel, pieceShape, 0);
          const feature: SolidFeature = nameable
            ? {
              kind: 'slice',
              source: sourceFeature,
              plane: { origin: { ...plane.origin }, normal: { ...plane.normal } },
              side: sides[index],
              ...keptMesh,
            }
            : { kind: 'mesh' };
          pieces.push(slicedPiece(ctx, current, geometry.mesh, index + 1, feature, geometry.exact));
        } finally {
          pieceShape.dispose();
        }
      });
    } finally {
      exactSource.dispose();
    }
  }

  if (removed.length === 0) {
    ctx.log('Slice plane does not pass through any selected solid. Specify another plane.');
    return false;
  }

  ctx.history.execute(new ReplaceObjectsEdit('Slice', [], removed, [], pieces));
  ctx.doc.clearSelection();
  for (const piece of pieces) ctx.doc.selectSolid(piece.id, true);
  const missed = sources.length - removed.length;
  ctx.log(`Slice complete: ${removed.length} solid(s) became ${pieces.length} closed solid(s)${missed ? `; ${missed} missed by the plane` : ''}.`);
  return true;
}

/**
 * The surface half of SLICE: each selected surface cut by the one picked as
 * the knife, into however many pieces it falls into.
 *
 * The pieces are baked rather than kept as a recipe, the same as THICKEN and
 * SURFSCULPT — a piece of a cut has no name of its own to rebuild from the way
 * "the half this side of that plane" does, and a surface can fall into more
 * than two.
 */
async function applySurfaceSlice(ctx: CommandContext, targets: readonly Surface[], tool: Surface): Promise<boolean> {
  ctx.log(`Cutting ${targets.length} surface(s)…`);
  const removed: Surface[] = [];
  const pieces: Surface[] = [];
  for (const target of targets) {
    const current = ctx.doc.getSurface(target.id);
    if (!current || current.id === tool.id) continue;
    const cut = await sliceExactSurface(current, tool, 0);
    if (!cut) continue;
    removed.push(current);
    cut.forEach((piece, index) => {
      const surface = ctx.doc.createSurface(piece.mesh, `${current.name}_${index + 1}`, [current.id], undefined, { kind: 'mesh' });
      surface.layer = current.layer;
      surface.aci = current.aci;
      surface.color = current.color;
      surface.exact = piece.exact;
      pieces.push(surface);
    });
  }
  if (removed.length === 0) {
    ctx.log('The cutting surface does not pass through any selected surface. Select another.');
    return false;
  }
  ctx.history.execute(new ReplaceObjectsEdit('Slice', [], [], [], [], removed, pieces));
  ctx.doc.clearSelection();
  for (const piece of pieces) ctx.doc.selectSurface(piece.id, true);
  ctx.log(`Slice complete: ${removed.length} surface(s) became ${pieces.length} surface(s).`);
  return true;
}

export async function sliceSolids(run: CommandRun): Promise<StepOutcome> {
  const { active, ctx, data, step, value } = run;
  if (active.stepIndex === 0) {
    if (run.gather(value)) return 'stay';
    const solids = (data.solids as Solid[] | undefined) ?? [];
    const surfaces = (data.surfaces as Surface[] | undefined) ?? [];
    if (solids.length + surfaces.length === 0) return 'stay';
    // What is being cut decides what does the cutting. A surface has no inside
    // for a plane to divide usefully, so it is cut by another surface, which
    // is a different question and so a different next step.
    if (surfaces.length > 0) {
      if (solids.length > 0) ctx.log(`Slicing the ${surfaces.length} selected surface(s); ${solids.length} solid(s) ignored.`);
      active.steps[1] = { kind: 'surface', label: 'Select the surface to cut with:' };
      active.steps[2] = { kind: 'done' };
    }
    return 'advance';
  }

  if (step.kind === 'surface') {
    // A surface step answers with the id — that is all the viewport can name
    // it by — so it has to be looked up, not used as the object itself.
    const tool = ctx.doc.getSurface(value as string);
    if (!tool) { ctx.log('Select the surface to cut with.'); return 'stay'; }
    if (!await applySurfaceSlice(ctx, (data.surfaces as Surface[] | undefined) ?? [], tool)) return 'stay';
    return 'advance';
  }

  const sources = (data.solids as Solid[] | undefined) ?? [];
  if (step.kind === 'plane') {
    if (isFaceSelection(value)) {
      const plane = planeFromFace(ctx, value);
      if (!plane) {
        ctx.log('Select a valid planar solid face.');
        return 'stay';
      }
      if (!await applySlice(ctx, sources, plane)) return 'stay';
      // The face answered the whole plane wizard; finish after this step.
      active.stepIndex = active.steps.length - 2;
      return 'advance';
    }
    data.sliceFirst = pointInWorld(ctx, value);
    return 'advance';
  }

  if (step.kind === 'point' && active.stepIndex === 2) {
    data.sliceSecond = pointInWorld(ctx, value);
    return 'advance';
  }

  const first = data.sliceFirst as Vec3;
  const second = data.sliceSecond as Vec3;
  const third = pointInWorld(ctx, value);
  const plane = planeFromPoints(first, second, third);
  if (!plane) {
    ctx.log('The three slice-plane points must not be collinear.');
    return 'stay';
  }
  if (await applySlice(ctx, sources, plane)) return 'advance';

  // A missing plane is easier to retry from scratch than by keeping two stale
  // points and asking only for a different third one.
  delete data.sliceFirst;
  delete data.sliceSecond;
  active.stepIndex = 1;
  return 'stay';
}
