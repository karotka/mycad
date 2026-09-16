/**
 * PROJECTGEOMETRY: a drawn curve laid onto a body, following its shape.
 *
 * The mark on a part: a line drawn flat and dropped onto a curved face so it
 * can be engraved, milled along, or used to divide the face up. The projection
 * is along the body's own normals rather than one fixed direction, which is
 * what makes a straight line wrap round a cylinder instead of smearing across
 * it.
 *
 * The curve you drew stays where it was — what lands on the body is a new one.
 */
import { entityKernelPath } from '../../geometry/EntityKernelGeometry';
import { entitiesFromKernelCurves } from '../../entities/fromKernelCurves';
import { openExactShape, promoteSolidToExact } from '../../geometry/ExactSolid';
import { openCascadeKernel } from '../../geometry/OpenCascadeRuntime';
import { ReplaceObjectsEdit } from '../../history/edits';
import { WORLD_WORK_PLANE } from '../../../math/workplane';
import type { Entity, Solid, Surface } from '../../entities/types';
import type { CommandRun, StepOutcome } from '../types';

export async function projectGeometry(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) {
    if (run.gather(value)) return 'stay';
    const curves = ((data.entities as Entity[] | undefined) ?? []).filter((entity) =>
      (entityKernelPath(entity, entity.workPlane ?? WORLD_WORK_PLANE) ?? []).length > 0);
    if (curves.length === 0) {
      ctx.log('PROJECTGEOMETRY: select curves to project — a line, arc, circle, polyline or spline.');
      return 'stay';
    }
    data.curves = curves;
    // The next step gathers its own pick, so the set this one filled has to be
    // put out of the way first.
    data.entities = [];
    return 'advance';
  }

  const target = ctx.doc.getSolid(value as string) ?? ctx.doc.getSurface(value as string);
  if (!target) { ctx.log('Select the solid or surface to project onto.'); return 'stay'; }
  const curves = (data.curves as Entity[] | undefined) ?? [];
  ctx.log(`Projecting ${curves.length} curve(s) onto ${target.name}…`);

  const open = !ctx.doc.getSolid((target as Solid | Surface).id);
  if (!await promoteSolidToExact(target, open)) { ctx.log('That object has no geometry to project onto.'); return 'stay'; }
  const kernel = await openCascadeKernel();
  const shape = await openExactShape(target, kernel);
  if (!shape) { ctx.log('That object could not be opened to project onto.'); return 'stay'; }

  const drawn: Entity[] = [];
  try {
    for (const curve of curves) {
      const edges = entityKernelPath(curve, curve.workPlane ?? WORLD_WORK_PLANE);
      if (!edges || edges.length === 0) continue;
      const wire = kernel.wireShape(edges);
      try {
        drawn.push(...entitiesFromKernelCurves(ctx.doc, kernel.projectOnto(wire, shape)));
      } catch {
        ctx.log(`${curve.type} ${curve.id}: could not be projected.`);
      } finally {
        wire.dispose();
      }
    }
  } finally {
    shape.dispose();
  }

  if (drawn.length === 0) {
    ctx.log('Nothing landed on the object — the curves may not lie over it.');
    return 'stay';
  }
  // The originals stay: a projection is a new mark, not a move.
  ctx.history.execute(new ReplaceObjectsEdit('Project geometry', [], [], drawn, []));
  ctx.doc.clearSelection();
  drawn.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
  ctx.log(`Projected onto ${target.name}: ${drawn.length} curve(s) drawn.`);
  return 'advance';
}
