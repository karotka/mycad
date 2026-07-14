import type { Document } from '../Document';
import { cloneEntity, type Entity, type Solid } from '../entities/types';
import type { DocumentEdit } from './CommandHistory';

export function cloneSolid(solid: Solid): Solid {
  return {
    ...solid,
    mesh: {
      positions: solid.mesh.positions.slice(),
      indices: solid.mesh.indices.slice(),
    },
    sourceEntityIds: [...solid.sourceEntityIds],
    feature: JSON.parse(JSON.stringify(solid.feature)),
  };
}

function replaceEntity(doc: Document, value: Entity): void {
  const index = doc.entities.findIndex((entity) => entity.id === value.id);
  const copy = cloneEntity(value);
  if (index >= 0) doc.entities[index] = copy;
  else doc.entities.push(copy);
  doc.notify();
}

function replaceSolid(doc: Document, value: Solid): void {
  const index = doc.solids.findIndex((solid) => solid.id === value.id);
  const copy = cloneSolid(value);
  if (index >= 0) doc.solids[index] = copy;
  else doc.solids.push(copy);
  doc.notify();
}

export class AddEntityEdit implements DocumentEdit {
  constructor(readonly label: string, private readonly entity: Entity) {}
  apply(doc: Document): void { replaceEntity(doc, this.entity); }
  revert(doc: Document): void { doc.removeEntity(this.entity.id); }
}

export class AddEntitiesEdit implements DocumentEdit {
  constructor(readonly label: string, private readonly entities: Entity[]) {}
  apply(doc: Document): void { for (const entity of this.entities) replaceEntity(doc, entity); }
  revert(doc: Document): void { for (const entity of this.entities) doc.removeEntity(entity.id); }
}

export class RemoveEntityEdit implements DocumentEdit {
  constructor(readonly label: string, private readonly entity: Entity) {}
  apply(doc: Document): void { doc.removeEntity(this.entity.id); }
  revert(doc: Document): void { replaceEntity(doc, this.entity); }
}

export class RemoveSolidEdit implements DocumentEdit {
  constructor(readonly label: string, private readonly solid: Solid) {}
  apply(doc: Document): void { doc.removeSolid(this.solid.id); }
  revert(doc: Document): void { replaceSolid(doc, this.solid); }
}

export class UpdateEntityEdit implements DocumentEdit {
  constructor(readonly label: string, private readonly before: Entity, private readonly after: Entity) {}
  apply(doc: Document): void { replaceEntity(doc, this.after); }
  revert(doc: Document): void { replaceEntity(doc, this.before); }
}

export class UpdateSolidEdit implements DocumentEdit {
  constructor(readonly label: string, private readonly before: Solid, private readonly after: Solid) {}
  apply(doc: Document): void { replaceSolid(doc, this.after); }
  revert(doc: Document): void { replaceSolid(doc, this.before); }
}

export class ReplaceObjectsEdit implements DocumentEdit {
  constructor(
    readonly label: string,
    private readonly beforeEntities: Entity[],
    private readonly beforeSolids: Solid[],
    private readonly afterEntities: Entity[],
    private readonly afterSolids: Solid[],
  ) {}

  apply(doc: Document): void { this.replace(doc, this.beforeEntities, this.beforeSolids, this.afterEntities, this.afterSolids); }
  revert(doc: Document): void { this.replace(doc, this.afterEntities, this.afterSolids, this.beforeEntities, this.beforeSolids); }

  private replace(doc: Document, removeEntities: Entity[], removeSolids: Solid[], addEntities: Entity[], addSolids: Solid[]): void {
    const entityIds = new Set(removeEntities.map((entity) => entity.id));
    const solidIds = new Set(removeSolids.map((solid) => solid.id));
    doc.entities = doc.entities.filter((entity) => !entityIds.has(entity.id));
    doc.solids = doc.solids.filter((solid) => !solidIds.has(solid.id));
    for (const entity of addEntities) replaceEntity(doc, entity);
    for (const solid of addSolids) replaceSolid(doc, solid);
    doc.pruneSelection();
    doc.notify();
  }
}
