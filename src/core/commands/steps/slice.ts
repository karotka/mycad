import type { Vec2, Vec3 } from '../../../math/geometry';
import { localToWorld } from '../../../math/workplane';
import type { Solid, SolidFaceSelection, SolidMesh } from '../../entities/types';
import { ReplaceObjectsEdit } from '../../history/edits';
import { exactResult, openExactShape, promoteSolidToExact } from '../../geometry/ExactSolid';
import { openCascadeKernel } from '../../geometry/OpenCascadeRuntime';
import type { CommandContext, CommandRun, StepOutcome } from '../types';

interface CuttingPlane {
  origin: Vec3;
  normal: Vec3;
}

function isFaceSelection(value: unknown): value is SolidFaceSelection {
  return Boolean(value && typeof value === 'object' && 'solidId' in value && 'vertexIndices' in value && 'normal' in value);
}

/** Command points are local to the active UCS; their optional z is its height. */
function pointInWorld(ctx: CommandContext, value: unknown): Vec3 {
  const point = value as Vec2 & { z?: number };
  return localToWorld(ctx.doc.activeWorkPlane, point, point.z ?? 0);
}

function planeFromFace(ctx: CommandContext, face: SolidFaceSelection): CuttingPlane | null {
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

function planeFromPoints(first: Vec3, second: Vec3, third: Vec3): CuttingPlane | null {
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
  exact?: NonNullable<Solid['exact']>,
): Solid {
  const piece = ctx.doc.createSolid(
    mesh,
    `${source.name}_Slice${index}`,
    source.height,
    [...source.sourceEntityIds],
    source.color,
    { kind: 'mesh' },
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
      exactPieces.forEach((pieceShape, index) => {
        try {
          const geometry = exactResult(exactKernel, pieceShape, 0);
          pieces.push(slicedPiece(ctx, current, geometry.mesh, index + 1, geometry.exact));
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

export async function sliceSolids(run: CommandRun): Promise<StepOutcome> {
  const { active, ctx, data, step, value } = run;
  if (step.kind === 'solid') {
    if (run.gather(value)) return 'stay';
    return ((data.solids as Solid[] | undefined)?.length ?? 0) > 0 ? 'advance' : 'stay';
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
