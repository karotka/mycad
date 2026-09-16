/**
 * DISTOBJECTS: the shortest distance between two objects, and where.
 *
 * DIST measures between two points you name. This measures between two whole
 * objects and finds the nearest place itself — the clearance between a shaft
 * and a bore, the gap a cable has to pass through, how far a bracket is off a
 * wall. Anything can be either side: a solid, a surface, or a drawn curve,
 * since all three reach the kernel as shapes.
 *
 * Zero means they touch or overlap. How far INTO each other they reach is a
 * different question, and INTERFERE is the one that answers it.
 */
import { entityKernelPath } from '../../geometry/EntityKernelGeometry';
import { openExactShape, promoteSolidToExact } from '../../geometry/ExactSolid';
import { openCascadeKernel } from '../../geometry/OpenCascadeRuntime';
import type { OpenCascadeKernel, OpenCascadeSolid } from '../../geometry/OpenCascadeKernel';
import { WORLD_WORK_PLANE } from '../../../math/workplane';
import type { Entity } from '../../entities/types';
import type { CommandContext, CommandRun, StepOutcome } from '../types';

/** What the pick actually was: an entity arrives whole, a solid or a surface
 *  as its id — that is all the viewport can name either by. */
function resolve(ctx: CommandContext, value: unknown): { name: string; shape: Promise<OpenCascadeSolid | null> } | null {
  const kernel = openCascadeKernel();
  if (value && typeof value === 'object' && 'type' in value) {
    const entity = value as Entity;
    const edges = entityKernelPath(entity, entity.workPlane ?? WORLD_WORK_PLANE);
    if (!edges || edges.length === 0) return null;
    return {
      name: `${entity.type} ${entity.id}`,
      shape: kernel.then((k) => k.wireShape(edges)),
    };
  }
  if (typeof value !== 'string') return null;
  const body = ctx.doc.getSolid(value) ?? ctx.doc.getSurface(value);
  if (!body) return null;
  const open = !ctx.doc.getSolid(value);
  return {
    name: body.name,
    shape: (async () => {
      if (!await promoteSolidToExact(body, open)) return null;
      return openExactShape(body, await kernel as OpenCascadeKernel);
    })(),
  };
}

const format = (value: number): string => Number(value.toFixed(4)).toString();

export async function measureObjectDistance(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) {
    const first = resolve(ctx, value);
    if (!first) { ctx.log('Select a solid, a surface, or a curve with some length.'); return 'stay'; }
    data.first = first;
    return 'advance';
  }

  const second = resolve(ctx, value);
  if (!second) { ctx.log('Select a solid, a surface, or a curve with some length.'); return 'stay'; }
  const first = data.first as { name: string; shape: Promise<OpenCascadeSolid | null> };
  const kernel = await openCascadeKernel();
  const [one, other] = await Promise.all([first.shape, second.shape]);
  if (!one || !other) {
    one?.dispose();
    other?.dispose();
    ctx.log('Distance failed: one of the objects has no geometry to measure.');
    return 'stay';
  }
  try {
    const closest = kernel.closestPoints(one, other);
    if (!closest) { ctx.log('Distance failed: no closest point could be found.'); return 'stay'; }
    const delta = {
      x: closest.onSecond.x - closest.onFirst.x,
      y: closest.onSecond.y - closest.onFirst.y,
      z: closest.onSecond.z - closest.onFirst.z,
    };
    ctx.log(`Distance from ${first.name} to ${second.name}: ${format(closest.distance)}`
      + (closest.distance < 1e-9 ? ' — they touch or overlap' : ''));
    ctx.log(`  Nearest points: (${format(closest.onFirst.x)}, ${format(closest.onFirst.y)}, ${format(closest.onFirst.z)})`
      + ` to (${format(closest.onSecond.x)}, ${format(closest.onSecond.y)}, ${format(closest.onSecond.z)})`);
    ctx.log(`  Delta X = ${format(delta.x)}, Delta Y = ${format(delta.y)}, Delta Z = ${format(delta.z)}`);
    return 'advance';
  } finally {
    one.dispose();
    other.dispose();
  }
}
