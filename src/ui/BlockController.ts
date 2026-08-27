import type { Document } from '../core/Document';
import { cloneBlockDefinition, cloneEntity, expandedInsertSolids, type BlockDefinition, type Entity, type InsertEntity } from '../core/entities/types';
import { solidFeatureEdges } from '../core/solids/SolidTopology';
import { entityToPaths } from '../core/entities/paths';
import type { CommandHistory } from '../core/history/CommandHistory';
import { CompositeEdit, ReplaceObjectsEdit, SetBlockDefinitionsEdit } from '../core/history/edits';

export interface BlockControllerCallbacks {
  startCreate(): void;
  startInsert(name: string): void;
  log(message: string): void;
  redraw(): void;
}

const keyOf = (name: string): string => name.trim().toUpperCase();

function definitionContainsReference(definition: BlockDefinition, key: string): boolean {
  return definition.entities.some((entity) => entityContainsReference(entity, key));
}

function entityContainsReference(entity: Entity, key: string): boolean {
  return entity.type === 'insert'
    && (keyOf(entity.blockName) === key || definitionContainsReference(entity.definition, key));
}

function renamedDefinition(definition: BlockDefinition, oldKey: string, nextName: string): BlockDefinition {
  const copy = cloneBlockDefinition(definition);
  if (keyOf(copy.name) === oldKey) copy.name = nextName;
  copy.entities = copy.entities.map((entity) => renamedEntity(entity, oldKey, nextName));
  return copy;
}

function renamedEntity(entity: Entity, oldKey: string, nextName: string): Entity {
  const copy = cloneEntity(entity);
  if (copy.type !== 'insert') return copy;
  if (keyOf(copy.blockName) === oldKey) copy.blockName = nextName;
  copy.definition = renamedDefinition(copy.definition, oldKey, nextName);
  return copy;
}

function directReferenceCount(doc: Document, name: string): number {
  const key = keyOf(name);
  return doc.entities.filter((entity) => entity.type === 'insert' && keyOf(entity.blockName) === key).length;
}

function nestedReferenceCount(doc: Document, name: string): number {
  const key = keyOf(name);
  const countEntity = (entity: Entity): number => {
    if (entity.type !== 'insert') return 0;
    return (keyOf(entity.blockName) === key ? 1 : 0)
      + entity.definition.entities.reduce((total, child) => total + countEntity(child), 0);
  };
  return doc.blockDefinitions.reduce((total, definition) =>
    total + definition.entities.reduce((subtotal, entity) => subtotal + countEntity(entity), 0), 0);
}

export class BlockController {
  constructor(
    private readonly doc: Document,
    private readonly history: CommandHistory,
    private readonly panel: HTMLElement,
    private readonly list: HTMLElement,
    private readonly countLabel: HTMLElement,
    private readonly toggleButton: HTMLElement,
    create: HTMLElement,
    close: HTMLElement,
    private readonly callbacks: BlockControllerCallbacks,
  ) {
    toggleButton.addEventListener('click', () => this.toggle());
    close.addEventListener('click', () => this.close());
    create.addEventListener('click', () => this.callbacks.startCreate());
    this.render();
  }

  get isOpen(): boolean { return !this.panel.hidden; }

  toggle(): void {
    this.panel.hidden = !this.panel.hidden;
    this.toggleButton.classList.toggle('active', !this.panel.hidden);
    if (!this.panel.hidden) this.render();
  }

  close(): void {
    this.panel.hidden = true;
    this.toggleButton.classList.remove('active');
  }

  render(): void {
    // The status-bar badge stays live even while the panel is closed, but
    // rebuilding 1000+ rows (each with an SVG preview) on every document edit
    // regardless is the difference between an edit and a second-long stall —
    // same guard as ModelTreeController, just past the cheap part.
    this.countLabel.textContent = String(this.doc.blockDefinitions.length);
    if (this.panel.hidden) return;
    if (this.doc.blockDefinitions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'block-empty';
      empty.innerHTML = '<strong>No blocks yet</strong><span>Select 2D or 3D objects and run BLOCK, or use + above.</span>';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...this.doc.blockDefinitions.map((definition) => this.createRow(definition)));
  }

  private createRow(definition: BlockDefinition): HTMLElement {
    const row = document.createElement('div');
    row.className = 'block-row';
    row.dataset.block = definition.name;

    const preview = document.createElement('div');
    preview.className = 'block-preview';
    preview.append(this.previewSvg(definition));

    const copy = document.createElement('div');
    copy.className = 'block-copy';
    const input = document.createElement('input');
    input.className = 'block-name';
    input.value = definition.name;
    input.maxLength = 64;
    input.setAttribute('aria-label', 'Block name');
    const placed = directReferenceCount(this.doc, definition.name);
    const nested = nestedReferenceCount(this.doc, definition.name);
    const meta = document.createElement('small');
    const objectCount = definition.entities.length + (definition.solids?.length ?? 0);
    // "0 placed" alone reads as "unused" — misleading for a block that is only
    // ever reached by nesting inside another one, which is just as much a
    // reason the delete button below is (rightly) disabled.
    meta.textContent = `${objectCount} object${objectCount === 1 ? '' : 's'} · ${placed} placed`
      + (nested > 0 ? ` · ${nested} nested` : '');
    copy.append(input, meta);

    const insert = document.createElement('button');
    insert.className = 'block-insert';
    insert.type = 'button';
    insert.title = `Insert ${definition.name}`;
    insert.setAttribute('aria-label', `Insert block ${definition.name}`);
    insert.textContent = '↳';

    const references = placed + nested;
    const remove = document.createElement('button');
    remove.className = 'block-delete';
    remove.type = 'button';
    remove.disabled = references > 0;
    remove.title = references > 0
      ? `Block is used by ${references} reference(s); erase or explode them first`
      : `Delete block ${definition.name}`;
    remove.setAttribute('aria-label', `Delete block ${definition.name}`);
    remove.textContent = '×';

    row.append(preview, copy, insert, remove);
    row.addEventListener('click', () => this.selectReferences(definition.name));
    preview.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      input.focus();
      input.select();
    });
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
      if (event.key === 'Escape') { input.value = definition.name; input.blur(); }
    });
    input.addEventListener('change', () => this.rename(definition.name, input));
    insert.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.startInsert(definition.name);
    });
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!remove.disabled) this.remove(definition.name);
    });
    return row;
  }

  private selectReferences(name: string): void {
    const key = keyOf(name);
    const references = this.doc.entities.filter((entity): entity is InsertEntity =>
      entity.type === 'insert' && keyOf(entity.blockName) === key);
    this.doc.clearSelection();
    references.forEach((entity, index) => this.doc.selectEntity(entity.id, index > 0));
    this.callbacks.log(references.length
      ? `Selected ${references.length} reference(s) of block ${name}.`
      : `Block ${name} has no placed references.`);
    this.callbacks.redraw();
  }

  private rename(currentName: string, input: HTMLInputElement): void {
    const nextName = input.value.trim();
    const oldKey = keyOf(currentName);
    if (!nextName || nextName === currentName) { input.value = currentName; return; }
    if (this.doc.blockDefinitions.some((definition) => keyOf(definition.name) === keyOf(nextName))) {
      input.setCustomValidity('Block already exists.');
      input.reportValidity();
      input.value = currentName;
      return;
    }
    input.setCustomValidity('');
    const beforeDefinitions = this.doc.blockDefinitions;
    const afterDefinitions = beforeDefinitions.map((definition) => renamedDefinition(definition, oldKey, nextName));
    const beforeEntities = this.doc.entities.filter((entity) => entityContainsReference(entity, oldKey));
    const afterEntities = beforeEntities.map((entity) => renamedEntity(entity, oldKey, nextName));
    const edits = [
      new SetBlockDefinitionsEdit(`Rename block ${currentName}`, beforeDefinitions, afterDefinitions),
      ...(beforeEntities.length
        ? [new ReplaceObjectsEdit(`Rename references to ${nextName}`, beforeEntities, [], afterEntities, [])]
        : []),
    ];
    // history.execute() already ends the transaction and notifies, which
    // re-renders this panel (see main.ts) — a second call here would rebuild
    // every row, SVG previews included, twice for one edit.
    this.history.execute(new CompositeEdit(`Rename block ${currentName} to ${nextName}`, edits));
    this.callbacks.log(`Renamed block ${currentName} to ${nextName}.`);
    this.callbacks.redraw();
  }

  private remove(name: string): void {
    const key = keyOf(name);
    if (directReferenceCount(this.doc, name) + nestedReferenceCount(this.doc, name) > 0) return;
    // history.execute() already ends the transaction and notifies, which
    // re-renders this panel (see main.ts) — a second call here would rebuild
    // every row, SVG previews included, twice for one edit.
    this.history.execute(new SetBlockDefinitionsEdit(
      `Delete block ${name}`,
      this.doc.blockDefinitions,
      this.doc.blockDefinitions.filter((definition) => keyOf(definition.name) !== key),
    ));
    this.callbacks.log(`Deleted unused block ${name}.`);
    this.callbacks.redraw();
  }

  private previewSvg(definition: BlockDefinition): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('block-thumbnail');
    svg.setAttribute('viewBox', '0 0 56 40');
    svg.setAttribute('aria-hidden', 'true');
    const synthetic: InsertEntity = {
      id: 'block-preview', type: 'insert', layer: '0', aci: 256, color: 0x67c9ff, selected: false,
      blockName: definition.name, position: { ...definition.basePoint }, scaleX: 1, scaleY: 1,
      scaleZ: 1, rotation: 0, columns: 1, rows: 1, columnSpacing: 0, rowSpacing: 0, definition,
    };
    const paths = entityToPaths(synthetic, 28).filter((path) => path.points.length > 0);
    for (const solid of expandedInsertSolids(synthetic)) {
      const projected = (point: { x: number; y: number; z: number }): { x: number; y: number } => ({
        x: point.x - point.y * 0.45,
        y: point.z + (point.x + point.y) * 0.22,
      });
      for (const edge of solidFeatureEdges(solid.mesh)) {
        paths.push({ points: [projected(edge.start), projected(edge.end)], closed: false });
      }
    }
    const points = paths.flatMap((path) => path.points);
    if (points.length > 0) {
      const minX = Math.min(...points.map((point) => point.x));
      const maxX = Math.max(...points.map((point) => point.x));
      const minY = Math.min(...points.map((point) => point.y));
      const maxY = Math.max(...points.map((point) => point.y));
      const width = Math.max(maxX - minX, 1e-6);
      const height = Math.max(maxY - minY, 1e-6);
      const scale = Math.min(48 / width, 32 / height);
      const xOffset = 28 - ((minX + maxX) / 2) * scale;
      const yOffset = 20 + ((minY + maxY) / 2) * scale;
      for (const path of paths) {
        const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        shape.setAttribute('d', path.points.map((point, index) =>
          `${index === 0 ? 'M' : 'L'}${(point.x * scale + xOffset).toFixed(2)} ${(yOffset - point.y * scale).toFixed(2)}`)
          .join(' ') + (path.closed ? ' Z' : ''));
        svg.append(shape);
      }
    }
    const base = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    base.classList.add('block-base');
    base.setAttribute('cx', '5'); base.setAttribute('cy', '35'); base.setAttribute('r', '1.8');
    svg.append(base);
    return svg;
  }
}
