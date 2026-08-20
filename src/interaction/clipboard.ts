import { cloneEntity, genId, type Entity, type Solid } from '../core/entities/types';
import { cloneSolid } from '../core/history/edits';

/**
 * A process-wide copy buffer for whole objects, separate from the OS text
 * clipboard. It holds deep clones so the copied objects are frozen at copy
 * time, and it outlives a New File (the document is cleared in place, this is
 * not), so you can copy from one drawing and paste into a fresh one.
 */
interface ClipboardData { entities: Entity[]; solids: Solid[] }

let store: ClipboardData = { entities: [], solids: [] };

/** Replace the buffer with clones of the given objects. Returns how many were held. */
export function setClipboard(entities: Entity[], solids: Solid[]): number {
  store = { entities: entities.map(cloneEntity), solids: solids.map(cloneSolid) };
  return store.entities.length + store.solids.length;
}

export function clipboardSize(): number {
  return store.entities.length + store.solids.length;
}

/**
 * A fresh set of clones carrying new ids, ready to drop into a document. Each
 * read is independent, so the same buffer pastes any number of times without
 * the copies sharing ids or state.
 */
export function readClipboard(): ClipboardData {
  const reid = <T extends Entity | Solid>(object: T, type: string): T => {
    object.id = genId(type);
    object.selected = false;
    return object;
  };
  return {
    entities: store.entities.map((entity) => reid(cloneEntity(entity), entity.type)),
    solids: store.solids.map((solid) => reid(cloneSolid(solid), 'solid')),
  };
}
