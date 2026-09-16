/**
 * SECTION: the outline a plane sees through a part, drawn as real curves.
 *
 * SLICE divides the body in two and keeps the pieces. This leaves the body
 * alone and hands back the cut itself — the shape you dimension, hatch, or
 * take away to make a drawing from. A cut through a cylinder comes back as a
 * circle, not as two hundred little chords, because the kernel is asked what
 * the curve IS rather than asked to walk along it.
 */
import { entitiesFromKernelCurves } from '../../entities/fromKernelCurves';
import { openExactShape, promoteSolidToExact } from '../../geometry/ExactSolid';
import { openCascadeKernel } from '../../geometry/OpenCascadeRuntime';
import { AddEntityEdit, ReplaceObjectsEdit } from '../../history/edits';
import type { Entity, Solid, Surface } from '../../entities/types';
import type { Vec3 } from '../../../math/geometry';
import type { CommandContext, CommandRun, StepOutcome } from '../types';
import { isFaceSelection, planeFromFace, planeFromPoints, pointInWorld, type CuttingPlane } from './slice';

/** The curves where `plane` cuts every selected body, as entities. */
async function sectionEntities(ctx: CommandContext, bodies: readonly (Solid | Surface)[], plane: CuttingPlane): Promise<Entity[]> {
  const kernel = await openCascadeKernel();
  const drawn: Entity[] = [];
  for (const body of bodies) {
    const open = !('height' in body) && !ctx.doc.getSolid(body.id);
    if (!await promoteSolidToExact(body, open)) continue;
    const shape = await openExactShape(body, kernel);
    if (!shape) continue;
    try {
      drawn.push(...entitiesFromKernelCurves(ctx.doc, kernel.sectionByPlane(shape, plane)));
    } catch {
      ctx.log(`${body.name}: the plane could not be taken through it.`);
    } finally {
      shape.dispose();
    }
  }
  return drawn;
}

async function applySection(ctx: CommandContext, bodies: readonly (Solid | Surface)[], plane: CuttingPlane): Promise<boolean> {
  ctx.log(`Sectioning ${bodies.length} object(s)…`);
  const drawn = await sectionEntities(ctx, bodies, plane);
  if (drawn.length === 0) {
    ctx.log('The plane does not pass through any of the selected objects. Specify another.');
    return false;
  }
  ctx.history.execute(drawn.length === 1
    ? new AddEntityEdit('Section', drawn[0])
    : new ReplaceObjectsEdit('Section', [], [], drawn, []));
  ctx.doc.clearSelection();
  drawn.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
  ctx.log(`Section complete: ${drawn.length} curve(s) drawn; the objects themselves are untouched.`);
  return true;
}

export async function sectionSolids(run: CommandRun): Promise<StepOutcome> {
  const { active, ctx, data, step, value } = run;
  if (active.stepIndex === 0) {
    if (run.gather(value)) return 'stay';
    const bodies = [...((data.solids as Solid[] | undefined) ?? []), ...((data.surfaces as Surface[] | undefined) ?? [])];
    if (bodies.length === 0) { ctx.log('SECTION: select at least one solid or surface.'); return 'stay'; }
    data.bodies = bodies;
    return 'advance';
  }

  const bodies = (data.bodies as (Solid | Surface)[] | undefined) ?? [];
  if (step.kind === 'plane') {
    if (isFaceSelection(value)) {
      const plane = planeFromFace(ctx, value);
      if (!plane) { ctx.log('Select a valid planar solid face.'); return 'stay'; }
      if (!await applySection(ctx, bodies, plane)) return 'stay';
      // A face answered the whole plane wizard, so skip the two point steps.
      active.stepIndex = active.steps.length - 2;
      return 'advance';
    }
    data.sectionFirst = pointInWorld(ctx, value);
    return 'advance';
  }

  if (step.kind === 'point' && active.stepIndex === 2) {
    data.sectionSecond = pointInWorld(ctx, value);
    return 'advance';
  }

  const plane = planeFromPoints(data.sectionFirst as Vec3, data.sectionSecond as Vec3, pointInWorld(ctx, value));
  if (!plane) { ctx.log('The three section-plane points must not be collinear.'); return 'stay'; }
  if (await applySection(ctx, bodies, plane)) return 'advance';
  delete data.sectionFirst;
  delete data.sectionSecond;
  active.stepIndex = 1;
  return 'stay';
}
