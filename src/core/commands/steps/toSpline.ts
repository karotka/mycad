/**
 * TOSPLINE: a drawn shape replaced by the spline that traces it.
 *
 * An arc holds its radius and a circle its centre, which is exactly why
 * neither can be reshaped — an arc's grips move its ends and its centre, and
 * that is all an arc is allowed to be. Turning one into a spline gives up the
 * exactness and gains a curve that can be pulled anywhere, which is the whole
 * point of asking.
 *
 * A Surface asks the same question of the rails it was lofted through: they
 * live on inside its feature, they can already be grip-dragged, but an arc
 * among them is as rigid there as it was in the drawing. Converting those
 * rebuilds the surface through the splines they become.
 */
import { entityAsSpline, isSplineConvertible } from '../../entities/toSpline';
import { cloneSurfaceValue, type Entity, type LoftFeature, type Surface } from '../../entities/types';
import { ReplaceObjectsEdit, UpdateSurfaceEdit } from '../../history/edits';
import { buildExactFeature } from '../../geometry/ExactSolid';
import type { CommandRun, StepOutcome } from '../types';

/** The same object, drawn as a spline — its layer, colour and plane carried
 *  over, since nothing about it changed but the kind of curve it is. */
function splineFrom(run: CommandRun, entity: Entity): Entity | null {
  const geometry = entityAsSpline(entity);
  if (!geometry) return null;
  const spline = run.ctx.doc.createSpline(geometry.start, geometry.segments);
  spline.layer = entity.layer;
  spline.aci = entity.aci;
  spline.color = entity.color;
  spline.linetypeScale = entity.linetypeScale;
  if (entity.workPlane) spline.workPlane = entity.workPlane;
  return spline;
}

/** A loft feature with every rail and guide that can be a spline made one.
 *  Null when they all already are, so nothing is rebuilt for nothing. */
function loftThroughSplines(run: CommandRun, feature: LoftFeature): LoftFeature | null {
  let changed = false;
  const convert = (entity: Entity): Entity => {
    if (!isSplineConvertible(entity)) return entity;
    const spline = splineFrom(run, entity);
    if (!spline) return entity;
    changed = true;
    return spline;
  };
  const converted: LoftFeature = {
    ...feature,
    profiles: feature.profiles.map(convert),
    guides: feature.guides?.map(convert),
    path: feature.path ? convert(feature.path) : undefined,
  };
  return changed ? converted : null;
}

export async function convertToSpline(run: CommandRun): Promise<StepOutcome> {
  const { data, value, ctx } = run;
  if (run.gather(value)) return 'stay';

  const entities = (data.entities as Entity[] | undefined) ?? [];
  const surfaces = (data.surfaces as Surface[] | undefined) ?? [];
  if (entities.length + surfaces.length === 0) {
    ctx.log('TOSPLINE: select a line, arc, circle, ellipse, rectangle, polygon, polyline or surface.');
    return 'stay';
  }

  const replaced: Entity[] = [];
  const splines: Entity[] = [];
  const refused: string[] = [];
  for (const entity of entities) {
    if (entity.type === 'bezier') continue;
    const spline = splineFrom(run, entity);
    if (!spline) { refused.push(entity.type); continue; }
    replaced.push(entity);
    splines.push(spline);
  }
  if (replaced.length > 0) {
    ctx.history.execute(new ReplaceObjectsEdit('To spline', replaced, [], splines, []));
    ctx.doc.clearSelection();
    splines.forEach((spline, index) => ctx.doc.selectEntity(spline.id, index > 0));
  }

  let rebuilt = 0;
  for (const selected of surfaces) {
    const surface = ctx.doc.getSurface(selected.id);
    if (!surface) continue;
    // Only a lofted surface keeps its rails as things that can be shaped; an
    // extruded or offset one has a profile it is derived from, and nothing a
    // spline there would let you do that you cannot already do to the profile.
    if (surface.feature.kind !== 'loft') { refused.push(`${surface.feature.kind} surface`); continue; }
    const feature = loftThroughSplines(run, surface.feature);
    if (!feature) continue;
    const exact = await buildExactFeature(feature, surface.revision + 1, /* allowOpenShell */ true);
    if (!exact) { ctx.log(`${surface.name}: the surface could not be rebuilt through splines.`); continue; }
    const before = cloneSurfaceValue(surface);
    const after = cloneSurfaceValue(surface);
    after.feature = feature;
    after.mesh = exact.mesh;
    after.exact = exact.exact;
    after.revision = surface.revision + 1;
    ctx.history.execute(new UpdateSurfaceEdit('To spline', before, after));
    rebuilt++;
  }

  const done = splines.length + rebuilt;
  if (done === 0) {
    ctx.log(refused.length > 0
      ? `Nothing to convert: ${[...new Set(refused)].join(', ')} cannot be drawn as a single spline.`
      : 'Nothing to convert: everything selected is already a spline.');
    return 'stay';
  }
  ctx.log(`Converted to spline: ${splines.length} object(s)`
    + (rebuilt > 0 ? `, and the rails of ${rebuilt} surface(s)` : '')
    // What was left behind is worth a word: silence reads as "all done".
    + (refused.length > 0 ? `. Left alone: ${[...new Set(refused)].join(', ')}` : '') + '.');
  return 'advance';
}
