/**
 * FLATSHOT: the 3D model as it would be drawn on paper, from one direction.
 *
 * What separates a drawing from a wire model is knowing which edges are behind
 * something. The flat view here has always drawn every edge of every solid, so
 * you see the back of a part through the front of it. This asks OpenCascade
 * which edges can actually be seen, and draws the rest dashed on their own
 * layer — which is what a projected view is, and what AutoCAD's own FLATSHOT
 * produces.
 *
 * The outline of a curved face comes with it: the two sides of a cylinder are
 * not edges of the solid at all, but they are the lines anyone would draw.
 */
import { entitiesFromKernelCurves } from '../../entities/fromKernelCurves';
import { openExactShape, promoteSolidToExact } from '../../geometry/ExactSolid';
import { openCascadeKernel } from '../../geometry/OpenCascadeRuntime';
import { ReplaceObjectsEdit } from '../../history/edits';
import type { Entity, Solid, Surface } from '../../entities/types';
import { aciToRgb, ACI_BYLAYER, ACI_WHITE } from '../../../io/DxfAci';
import type { Point3 } from '../../geometry/GeometryKernel';
import type { CommandContext, CommandRun, StepOutcome } from '../types';

/** Where the viewer stands for each named view, and which way is up there. */
const VIEWS: Record<string, { direction: Point3; up: Point3 }> = {
  TOP: { direction: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } },
  BOTTOM: { direction: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
  FRONT: { direction: { x: 0, y: -1, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  BACK: { direction: { x: 0, y: 1, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  LEFT: { direction: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  RIGHT: { direction: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 0, z: 1 } },
  /** Looking down the corner, the way a pictorial view is drawn. */
  ISO: { direction: { x: 1, y: -1, z: 1 }, up: { x: 0, y: 0, z: 1 } },
};

/** The name each view answers to, for the prompt and for what was typed. */
export function viewNamed(answer: string): { direction: Point3; up: Point3 } | null {
  const key = answer.trim().toUpperCase();
  if (key === '') return VIEWS.FRONT;
  // A single letter is enough while it names only one view: T, B is ambiguous
  // between Back and Bottom, so that one has to be spelled further.
  const matches = Object.keys(VIEWS).filter((name) => name.startsWith(key));
  return matches.length === 1 ? VIEWS[matches[0]] : null;
}

/** The layer the hidden lines go on, made if it is not there — dashed,
 *  because that is what a hidden line is drawn as on every drawing. */
function hiddenLayer(ctx: CommandContext): string {
  const name = 'HIDDEN';
  if (!ctx.doc.layers.includes(name)) {
    ctx.doc.layers.push(name);
    ctx.doc.layerAci[name] = ACI_WHITE;
    ctx.doc.layerColors[name] = aciToRgb(ACI_WHITE)!;
    ctx.doc.layerLinetype[name] = 'Hidden';
  }
  return name;
}

export async function flatShot(run: CommandRun): Promise<StepOutcome> {
  const { active, data, value, ctx } = run;
  if (active.stepIndex === 0) {
    if (run.gather(value)) return 'stay';
    const bodies = [...((data.solids as Solid[] | undefined) ?? []), ...((data.surfaces as Surface[] | undefined) ?? [])];
    if (bodies.length === 0) { ctx.log('FLATSHOT: select the solids or surfaces to draw.'); return 'stay'; }
    data.bodies = bodies;
    return 'advance';
  }

  const view = viewNamed(String(value ?? ''));
  if (!view) {
    ctx.log('Name one view: Top, Bottom, Front, Back, Left, Right or Iso.');
    return 'stay';
  }
  const bodies = (data.bodies as (Solid | Surface)[] | undefined) ?? [];
  ctx.log('Working out what can be seen…');

  const kernel = await openCascadeKernel();
  const shapes = [];
  for (const body of bodies) {
    const open = !ctx.doc.getSolid(body.id);
    if (!await promoteSolidToExact(body, open)) continue;
    const shape = await openExactShape(body, kernel);
    if (shape) shapes.push(shape);
  }
  if (shapes.length === 0) { ctx.log('None of the selected objects has geometry to draw.'); return 'stay'; }

  let drawn: Entity[] = [];
  try {
    const { visible, hidden } = kernel.hiddenLineView(shapes, view.direction, view.up);
    const seen = entitiesFromKernelCurves(ctx.doc, visible);
    const behind = entitiesFromKernelCurves(ctx.doc, hidden);
    if (behind.length > 0) {
      const layer = hiddenLayer(ctx);
      for (const entity of behind) {
        entity.layer = layer;
        entity.aci = ACI_BYLAYER;
        entity.color = ctx.doc.layerColorFor(layer);
      }
    }
    drawn = [...seen, ...behind];
    if (drawn.length === 0) { ctx.log('Nothing came out of that view.'); return 'stay'; }
    ctx.history.execute(new ReplaceObjectsEdit('Flatshot', [], [], drawn, []));
    ctx.doc.clearSelection();
    drawn.forEach((entity, index) => ctx.doc.selectEntity(entity.id, index > 0));
    ctx.doc.viewMode = '2d';
    ctx.log(`Flatshot drawn: ${seen.length} visible line(s), ${behind.length} hidden on layer HIDDEN.`);
  } catch {
    ctx.log('Flatshot failed — the view could not be worked out.');
    return 'stay';
  } finally {
    for (const shape of shapes) shape.dispose();
  }
  return 'advance';
}
