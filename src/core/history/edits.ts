import type { Document, NamedWorkPlane } from '../Document';
import { cloneBlockDefinition, cloneEntity, cloneSolidValue, type BlockDefinition, type Entity, type Solid } from '../entities/types';
import type { DocumentEdit } from './CommandHistory';
import { ACI_WHITE, aciToRgb } from '../../io/DxfAci';
import { cloneWorkPlane, WORLD_WORK_PLANE, type WorkPlane } from '../../math/workplane';

export function cloneSolid(solid: Solid): Solid {
  return cloneSolidValue(solid);
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

/**
 * Several edits that undo and redo as one. A command that touches many objects
 * is still one thing the user did, so it must be one step in the history.
 */
export class CompositeEdit implements DocumentEdit {
  constructor(readonly label: string, private readonly edits: readonly DocumentEdit[]) {}

  apply(doc: Document): void {
    for (const edit of this.edits) edit.apply(doc);
  }

  revert(doc: Document): void {
    // Backwards: a later edit may rest on what an earlier one did.
    for (let index = this.edits.length - 1; index >= 0; index--) this.edits[index].revert(doc);
  }
}

function cloneBlockDefinitions(definitions: readonly BlockDefinition[]): BlockDefinition[] {
  return definitions.map(cloneBlockDefinition);
}

/**
 * Replaces the named block library as one undoable document edit. INSERTs carry
 * their own geometry snapshot, so commands that rename an already placed block
 * combine this with ReplaceObjectsEdit for the affected references.
 */
export class SetBlockDefinitionsEdit implements DocumentEdit {
  private readonly before: BlockDefinition[];
  private readonly after: BlockDefinition[];

  constructor(readonly label: string, before: readonly BlockDefinition[], after: readonly BlockDefinition[]) {
    this.before = cloneBlockDefinitions(before);
    this.after = cloneBlockDefinitions(after);
  }

  apply(doc: Document): void { this.replace(doc, this.after); }
  revert(doc: Document): void { this.replace(doc, this.before); }

  private replace(doc: Document, definitions: readonly BlockDefinition[]): void {
    doc.blockDefinitions = cloneBlockDefinitions(definitions);
    doc.recolour();
    doc.notify();
  }
}

export class AddEntityEdit implements DocumentEdit {
  constructor(readonly label: string, private readonly entity: Entity) {}
  apply(doc: Document): void { replaceEntity(doc, this.entity); }
  revert(doc: Document): void { doc.removeEntity(this.entity.id); }
}

export class AddEntitiesEdit implements DocumentEdit {
  constructor(readonly label: string, private readonly entities: Entity[]) {}
  apply(doc: Document): void {
    const ids = new Set(this.entities.map((entity) => entity.id));
    doc.entities = doc.entities.filter((entity) => !ids.has(entity.id));
    doc.entities.push(...this.entities.map(cloneEntity));
    doc.notify();
  }
  revert(doc: Document): void {
    const ids = new Set(this.entities.map((entity) => entity.id));
    doc.entities = doc.entities.filter((entity) => !ids.has(entity.id));
    doc.pruneSelection();
    doc.notify();
  }
}

export class DeleteLayerEdit implements DocumentEdit {
  readonly label: string;
  private readonly entities: Entity[];
  private readonly solids: Solid[];
  private readonly index: number;
  private readonly aci: number;
  private readonly lineweight: number | undefined;
  private readonly linetype: string | undefined;
  private readonly hidden: boolean;
  private readonly wasCurrent: boolean;

  constructor(docAtCreation: Document, private readonly layer: string) {
    this.label = `Delete layer ${layer}`;
    this.entities = docAtCreation.entities.filter((entity) => entity.layer === layer).map(cloneEntity);
    this.solids = docAtCreation.solids.filter((solid) => solid.layer === layer).map(cloneSolid);
    this.index = docAtCreation.layers.indexOf(layer);
    this.aci = docAtCreation.layerAci[layer] ?? ACI_WHITE;
    this.lineweight = docAtCreation.layerLineweight[layer];
    this.linetype = docAtCreation.layerLinetype[layer];
    this.hidden = docAtCreation.hiddenLayers.has(layer);
    this.wasCurrent = docAtCreation.currentLayer === layer;
  }

  apply(doc: Document): void {
    doc.entities = doc.entities.filter((entity) => entity.layer !== this.layer);
    doc.solids = doc.solids.filter((solid) => solid.layer !== this.layer);
    doc.layers = doc.layers.filter((layer) => layer !== this.layer);
    delete doc.layerColors[this.layer];
    delete doc.layerAci[this.layer];
    delete doc.layerLineweight[this.layer];
    delete doc.layerLinetype[this.layer];
    doc.hiddenLayers.delete(this.layer);
    if (doc.currentLayer === this.layer) doc.currentLayer = doc.layers[0] ?? '0';
    doc.pruneSelection();
    doc.notify();
  }

  revert(doc: Document): void {
    if (!doc.layers.includes(this.layer)) doc.layers.splice(Math.max(0, this.index), 0, this.layer);
    doc.layerAci[this.layer] = this.aci;
    doc.layerColors[this.layer] = aciToRgb(this.aci) ?? aciToRgb(ACI_WHITE)!;
    if (this.lineweight !== undefined) doc.layerLineweight[this.layer] = this.lineweight;
    if (this.linetype !== undefined) doc.layerLinetype[this.layer] = this.linetype;
    if (this.hidden) doc.hiddenLayers.add(this.layer);
    doc.entities.push(...this.entities.map(cloneEntity));
    doc.solids.push(...this.solids.map(cloneSolid));
    if (this.wasCurrent) doc.currentLayer = this.layer;
    doc.notify();
  }
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

/** A snapshot of the drawing's coordinate systems — the active plane and the saved named ones. */
export interface WorkPlaneState {
  activeWorkPlane: WorkPlane;
  namedWorkPlanes: NamedWorkPlane[];
  activeNamedWorkPlaneId: string | null;
}

function cloneWorkPlaneState(state: WorkPlaneState): WorkPlaneState {
  return {
    activeWorkPlane: cloneWorkPlane(state.activeWorkPlane),
    namedWorkPlanes: state.namedWorkPlanes.map((plane) => ({ ...plane, workPlane: cloneWorkPlane(plane.workPlane) })),
    activeNamedWorkPlaneId: state.activeNamedWorkPlaneId,
  };
}

export function captureWorkPlanes(doc: Document): WorkPlaneState {
  return cloneWorkPlaneState({
    activeWorkPlane: doc.activeWorkPlane,
    namedWorkPlanes: doc.namedWorkPlanes,
    activeNamedWorkPlaneId: doc.activeNamedWorkPlaneId,
  });
}

/** The World Coordinate System with no saved UCS — a drawing's fresh coordinate state. */
export function worldWorkPlaneState(): WorkPlaneState {
  return { activeWorkPlane: cloneWorkPlane(WORLD_WORK_PLANE), namedWorkPlanes: [], activeNamedWorkPlaneId: null };
}

/**
 * Replaces the drawing's coordinate systems — the active UCS and the saved named
 * ones — as one undoable edit, so they belong to the document's history like any
 * geometry change rather than being applied out of band.
 */
export class SetWorkPlanesEdit implements DocumentEdit {
  private readonly before: WorkPlaneState;
  private readonly after: WorkPlaneState;

  constructor(readonly label: string, before: WorkPlaneState, after: WorkPlaneState) {
    this.before = cloneWorkPlaneState(before);
    this.after = cloneWorkPlaneState(after);
  }

  apply(doc: Document): void { this.restore(doc, this.after); }
  revert(doc: Document): void { this.restore(doc, this.before); }

  private restore(doc: Document, state: WorkPlaneState): void {
    const clone = cloneWorkPlaneState(state);
    doc.namedWorkPlanes = clone.namedWorkPlanes;
    doc.activeNamedWorkPlaneId = clone.activeNamedWorkPlaneId;
    doc.activeWorkPlane = clone.activeWorkPlane;
    doc.notify();
  }
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
