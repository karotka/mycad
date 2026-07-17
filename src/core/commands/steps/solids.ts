/**
 * The primitive solids: pick where it goes, pick how big, and it exists.
 *
 * Six commands that were six near-identical cases, each building its mesh by
 * hand — the local builder, then the work plane transform, then the feature
 * describing the same thing a second time. `primitiveMesh` already does all of
 * that from the feature alone, so the feature is the only thing left to say. It
 * is the same duplication the properties panel had, and it had already drifted
 * there; here it had not yet, which is the only difference.
 */
import { ReplaceObjectsEdit } from '../../history/edits';
import type { PrimitiveFeature } from '../../entities/types';
import { primitiveMesh } from '../../solids/ManifoldEngine';
import { cloneWorkPlane } from '../../../math/workplane';
import { dist2, type Vec2 } from '../../../math/geometry';
import type { CommandRun, StepOutcome } from '../types';

/**
 * Builds the solid from its feature and hands it to the history. The mesh comes
 * from the engine rather than from the caller, so a primitive cannot be built
 * one way and described another.
 */
function place(run: CommandRun, name: string, feature: PrimitiveFeature, message: string): StepOutcome {
  const solid = run.ctx.doc.createSolid(primitiveMesh(feature), name, feature.height, [], undefined, feature);
  run.ctx.history.execute(new ReplaceObjectsEdit(name, [], [], [], [solid]));
  run.ctx.doc.viewMode = '3d';
  run.ctx.log(message);
  return 'advance';
}

const round = (value: number) => value.toFixed(3);

/** A box and a wedge are the same wizard: two corners, then a height. */
function boxLike(run: CommandRun, name: 'Box' | 'Wedge', primitive: 'box' | 'wedge'): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) { data.start = value; return 'advance'; }
  if (active.stepIndex === 1) { data.end = value; return 'advance'; }

  const start = data.start as Vec2, end = data.end as Vec2;
  const width = Math.abs(end.x - start.x);
  const depth = Math.abs(end.y - start.y);
  const height = Math.abs(value as number);
  if (width < 1e-9 || depth < 1e-9 || height < 1e-9) {
    ctx.log(`${name} dimensions must be greater than zero.`);
    return 'stay';
  }
  const center = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  return place(run, name,
    { kind: 'primitive', primitive, center, width, depth, height, workPlane: cloneWorkPlane(ctx.doc.activeWorkPlane) },
    `${name} created: ${round(width)} × ${round(depth)} × ${round(height)}`);
}

export const createBox = (run: CommandRun): StepOutcome => boxLike(run, 'Box', 'box');
export const createWedge = (run: CommandRun): StepOutcome => boxLike(run, 'Wedge', 'wedge');

/** A cylinder, a cone and a pyramid are the same wizard: centre, radius, height. */
function radialLike(run: CommandRun, name: 'Cylinder' | 'Cone' | 'Pyramid', primitive: 'cylinder' | 'cone' | 'pyramid'): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) { data.center = value; return 'advance'; }
  if (active.stepIndex === 1) { data.radiusPoint = value; return 'advance'; }

  const center = data.center as Vec2;
  const radius = dist2(center, data.radiusPoint as Vec2);
  const height = Math.abs(value as number);
  if (radius < 1e-9 || height < 1e-9) {
    ctx.log(`${name} radius and height must be greater than zero.`);
    return 'stay';
  }
  return place(run, name,
    { kind: 'primitive', primitive, center, radius, height, workPlane: cloneWorkPlane(ctx.doc.activeWorkPlane) },
    `${name} created: R${round(radius)}, H${round(height)}`);
}

export const createCylinder = (run: CommandRun): StepOutcome => radialLike(run, 'Cylinder', 'cylinder');
export const createCone = (run: CommandRun): StepOutcome => radialLike(run, 'Cone', 'cone');
export const createPyramid = (run: CommandRun): StepOutcome => radialLike(run, 'Pyramid', 'pyramid');

export function createSphere(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) { data.center = value; return 'advance'; }

  const center = data.center as Vec2;
  const radius = dist2(center, value as Vec2);
  if (radius < 1e-9) {
    ctx.log('Sphere radius must be greater than zero.');
    return 'stay';
  }
  return place(run, 'Sphere',
    // A sphere's height is twice its radius and follows it, which is the same
    // rule `primitiveParams` keeps: two ways to say one number disagree.
    { kind: 'primitive', primitive: 'sphere', center, radius, height: radius * 2, workPlane: cloneWorkPlane(ctx.doc.activeWorkPlane) },
    `Sphere created: R${round(radius)}`);
}

export function createTorus(run: CommandRun): StepOutcome {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) { data.center = value; return 'advance'; }
  if (active.stepIndex === 1) { data.radiusPoint = value; return 'advance'; }

  const center = data.center as Vec2;
  const radius = dist2(center, data.radiusPoint as Vec2);
  const tubeRadius = Math.abs(value as number);
  if (radius < 1e-9 || tubeRadius < 1e-9) {
    ctx.log('Torus radius and tube radius must be greater than zero.');
    return 'stay';
  }
  // A tube as fat as the ring has no hole, and past that it turns inside out.
  if (tubeRadius >= radius) {
    ctx.log('Tube radius must be smaller than the torus radius.');
    return 'stay';
  }
  return place(run, 'Torus',
    { kind: 'primitive', primitive: 'torus', center, radius, tubeRadius, height: tubeRadius * 2, workPlane: cloneWorkPlane(ctx.doc.activeWorkPlane) },
    `Torus created: R${round(radius)}, tube R${round(tubeRadius)}`);
}
