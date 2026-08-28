import { entityToPaths } from '../../entities/paths';
import type { BezierEntity, Entity } from '../../entities/types';
import { ReplaceObjectsEdit } from '../../history/edits';
import type { CommandContext, CommandRun, StepOutcome } from '../types';
import { optimizePlotterPaths } from '../../../io/PlotterPathOptimizer';
import { fitCubicBeziers } from '../../../math/bezierFit';

const SUPPORTED = new Set<Entity['type']>(['line', 'polyline', 'arc', 'bezier']);

// Small enough to preserve an illustration at plotter scale while allowing
// fragmented SVG curves to collapse meaningfully. Reported to the user because
// this is an approximation, not an exact algebraic merge.
const DEFAULT_TOLERANCE = 0.2;

/** Re-fits connected curve fragments as a smaller set of cubic Beziers. */
export function optimizeDrawingPaths(ctx: CommandContext, tolerance = DEFAULT_TOLERANCE): void {
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    ctx.log('Tolerance must be greater than zero.');
    return;
  }
  const selected = ctx.doc.getSelectedEntities().filter(isSupported);
  const source = selected.length > 0
    ? selected
    : ctx.doc.entities.filter((entity) => isSupported(entity) && !ctx.doc.hiddenLayers.has(entity.layer));

  if (source.length < 2) {
    ctx.log('OPTIMIZEPATHS requires at least two line or curve objects.');
    return;
  }

  // A stroke must not silently change layer, colour or work plane. Each such
  // combination is optimized independently and gets the source appearance.
  const groups = new Map<string, Entity[]>();
  for (const entity of source) {
    const key = JSON.stringify([entity.layer, entity.aci, entity.workPlane ?? null]);
    const group = groups.get(key) ?? [];
    group.push(entity);
    groups.set(key, group);
  }

  const replacements: BezierEntity[] = [];
  for (const entities of groups.values()) {
    const first = entities[0];
    const paths = entities.flatMap((entity) => entityToPaths(entity, ctx.doc.gcode.segments));
    // The same tolerance intentionally governs both operations: endpoints
    // closer than it are snapped together, and the refitted curve may deviate
    // from the sampled source by at most that amount.
    for (const path of optimizePlotterPaths(paths, tolerance)) {
      const points = path.closed ? [...path.points, path.points[0]] : path.points;
      const fits = fitCubicBeziers(points, tolerance);
      if (fits.length === 0) continue;
      // One continuous stroke becomes one spline, however many cubic segments
      // it needed — not one separate Bezier entity per segment, which used to
      // turn "fewer objects" into "just as many, only shorter."
      const bezier = ctx.doc.createSpline(fits[0].start, fits.map((fit) => ({ control1: fit.control1, control2: fit.control2, end: fit.end })));
      bezier.layer = first.layer;
      bezier.aci = first.aci;
      bezier.color = first.color;
      bezier.workPlane = first.workPlane;
      replacements.push(bezier);
    }
  }

  if (replacements.length >= source.length) {
    ctx.log(`No connected paths to optimize (${source.length} objects).`);
    return;
  }

  ctx.history.execute(new ReplaceObjectsEdit('Optimize paths', source, [], replacements, []));
  ctx.redraw();
  ctx.log(`Optimized ${source.length} objects into ${replacements.length} Bezier curve(s) (tolerance ${tolerance} mm, nearby endpoints joined). UNDO restores the originals.`);
}

export function optimizeDrawingPathsCommand({ ctx, value }: CommandRun): StepOutcome {
  const tolerance = value as number;
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    ctx.log('Tolerance must be greater than zero.');
    return 'stay';
  }
  optimizeDrawingPaths(ctx, tolerance);
  return 'advance';
}

function isSupported(entity: Entity): boolean {
  return SUPPORTED.has(entity.type);
}
