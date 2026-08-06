/**
 * Object-level visibility and a one-click layer move — the "isolate" lightbulb
 * and the layer paw. Visibility is a view state (a set of ids the renderer
 * skips) that is never saved; the layer move is a real, undoable edit.
 */
import { ReplaceObjectsEdit, cloneSolid } from '../../history/edits';
import { cloneEntity } from '../../entities/types';
import type { CommandContext } from '../types';

const selectedIds = (ctx: CommandContext): string[] => [
  ...ctx.doc.getSelectedEntities().map((entity) => entity.id),
  ...ctx.doc.getSelectedSolids().map((solid) => solid.id),
];

/** Hide the selected objects; Show All brings them back. */
export function hideSelectedObjects(ctx: CommandContext): void {
  const ids = selectedIds(ctx);
  if (ids.length === 0) { ctx.log('Select object(s) to hide first.'); return; }
  for (const id of ids) ctx.doc.hiddenObjects.add(id);
  ctx.doc.clearSelection();
  ctx.log(`Hidden ${ids.length} object(s). Use Show All to bring them back.`);
  ctx.redraw();
}

/** Hide everything except the selection. */
export function isolateSelectedObjects(ctx: CommandContext): void {
  const keep = new Set(selectedIds(ctx));
  if (keep.size === 0) { ctx.log('Select object(s) to isolate first.'); return; }
  ctx.doc.hiddenObjects.clear();
  for (const entity of ctx.doc.entities) if (!keep.has(entity.id)) ctx.doc.hiddenObjects.add(entity.id);
  for (const solid of ctx.doc.solids) if (!keep.has(solid.id)) ctx.doc.hiddenObjects.add(solid.id);
  ctx.log(`Isolated ${keep.size} object(s). Use Show All to end isolation.`);
  ctx.redraw();
}

/** End isolation — bring every hidden object back. */
export function showAllObjects(ctx: CommandContext): void {
  const count = ctx.doc.hiddenObjects.size;
  if (count === 0) { ctx.log('No hidden objects.'); return; }
  ctx.doc.hiddenObjects.clear();
  ctx.log(`Showing all objects (${count} restored).`);
  ctx.redraw();
}

/** Move the selected objects onto the current layer (AutoCAD's LAYCUR). */
export function changeToCurrentLayer(ctx: CommandContext): void {
  const entities = ctx.doc.getSelectedEntities();
  const solids = ctx.doc.getSelectedSolids();
  if (entities.length + solids.length === 0) {
    ctx.log('Select object(s) to move to the current layer.');
    return;
  }
  const layer = ctx.doc.currentLayer;
  const beforeEntities = entities.map(cloneEntity);
  const beforeSolids = solids.map(cloneSolid);
  const afterEntities = beforeEntities.map((entity) => ({ ...entity, layer }));
  const afterSolids = beforeSolids.map((solid) => ({ ...solid, layer }));
  ctx.history.execute(new ReplaceObjectsEdit('Change to current layer', beforeEntities, beforeSolids, afterEntities, afterSolids));
  ctx.log(`Moved ${entities.length + solids.length} object(s) to layer "${layer}".`);
  ctx.redraw();
}
