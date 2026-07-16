import type { Document } from '../core/Document';
import { cloneEntity, type Entity, type Solid } from '../core/entities/types';
import type { CommandHistory } from '../core/history/CommandHistory';
import { ReplaceObjectsEdit, cloneSolid } from '../core/history/edits';
import { solidBounds } from '../interaction/PickingService';
import { primitiveMesh } from '../core/solids/ManifoldEngine';
import { primitiveParams, setPrimitiveParam } from '../core/solids/primitiveParams';

type ObjectValue = Entity | Solid;

export class PropertiesController {
  constructor(
    private readonly doc: Document,
    private readonly history: CommandHistory,
    private readonly panel: HTMLElement,
    private readonly content: HTMLElement,
    toggle: HTMLElement,
    close: HTMLElement,
    private readonly changed: () => void,
  ) {
    toggle.addEventListener('click', () => this.toggle());
    close.addEventListener('click', () => { this.panel.hidden = true; });
  }

  get isOpen(): boolean { return !this.panel.hidden; }
  toggle(): void { this.panel.hidden = !this.panel.hidden; if (!this.panel.hidden) this.render(); }

  render(): void {
    if (!this.isOpen) return;
    const objects: ObjectValue[] = [...this.doc.getSelectedEntities(), ...this.doc.getSelectedSolids()];
    if (objects.length === 0) { this.content.innerHTML = '<p class="properties-empty">No object selected</p>'; return; }
    if (objects.length > 1) { this.renderMultiple(objects); return; }
    const object = objects[0];
    const fields = this.fields(object);
    this.content.innerHTML = `<div class="property-row readonly"><span>Type</span><output>${'type' in object ? object.type : '3D Solid'}</output></div>${fields.map((field) => this.fieldHtml(field)).join('')}`;
    this.bindInputs(object, fields);
  }

  private renderMultiple(objects: ObjectValue[]): void {
    const sameLayer = objects.every((object) => object.layer === objects[0].layer) ? objects[0].layer : '';
    const sameColor = objects.every((object) => object.color === objects[0].color) ? objects[0].color : null;
    this.content.innerHTML = `<div class="property-row readonly"><span>Selection</span><output>${objects.length} objects</output></div>${this.layerHtml(sameLayer)}${this.colorHtml(sameColor)}`;
    this.content.querySelector<HTMLSelectElement>('[data-field="layer"]')?.addEventListener('change', (event) => this.updateMultiple(objects, 'layer', (event.target as HTMLSelectElement).value));
    this.content.querySelector<HTMLInputElement>('[data-field="color"]')?.addEventListener('change', (event) => this.updateMultiple(objects, 'color', Number.parseInt((event.target as HTMLInputElement).value.slice(1), 16)));
  }

  private fields(object: ObjectValue): Array<{ key: string; label: string; value: string | number; kind?: 'layer' | 'color' | 'readonly' }> {
    const common = [
      { key: 'layer', label: 'Layer', value: object.layer, kind: 'layer' as const },
      { key: 'color', label: 'Color', value: object.color, kind: 'color' as const },
    ];
    if (!('type' in object)) {
      const b = solidBounds(object);
      if (object.feature.kind === 'primitive') {
        const position = [{ key: 'x', label: 'X', value: b.minX }, { key: 'y', label: 'Y', value: b.minY }, { key: 'z', label: 'Z', value: b.minZ }];
        // What a primitive is made of is the engine's business, not this panel's.
        // Its own list here had already gone stale: no tube radius for a torus.
        return [...common, ...position, ...primitiveParams(object.feature).map(({ key, label, value }) => ({ key, label, value }))];
      }
      return [...common,
        { key: 'x', label: 'X', value: b.minX }, { key: 'y', label: 'Y', value: b.minY }, { key: 'z', label: 'Z', value: b.minZ },
        { key: 'width', label: 'Width', value: b.maxX - b.minX }, { key: 'depth', label: 'Depth', value: b.maxY - b.minY }, { key: 'height', label: 'Height', value: b.maxZ - b.minZ },
      ];
    }
    switch (object.type) {
      case 'line': return [...common, ...pointFields('start', 'Start', object.start), ...pointFields('end', 'End', object.end), { key: '_length', label: 'Length', value: Math.hypot(object.end.x - object.start.x, object.end.y - object.start.y), kind: 'readonly' }];
      case 'circle': return [...common, ...pointFields('center', 'Center', object.center), { key: 'radius', label: 'Radius', value: object.radius }, { key: '_diameter', label: 'Diameter', value: object.radius * 2, kind: 'readonly' }];
      case 'ellipse': return [...common, ...pointFields('center', 'Center', object.center), { key: 'radiusX', label: 'Radius X', value: object.radiusX }, { key: 'radiusY', label: 'Radius Y', value: object.radiusY }, { key: 'rotation', label: 'Rotation °', value: object.rotation * 180 / Math.PI }];
      case 'rectangle': return [...common, ...pointFields('first', 'First', object.first), ...pointFields('opposite', 'Opposite', object.opposite), { key: '_width', label: 'Width', value: Math.abs(object.opposite.x - object.first.x), kind: 'readonly' }, { key: '_height', label: 'Height', value: Math.abs(object.opposite.y - object.first.y), kind: 'readonly' }];
      case 'arc': return [...common, ...pointFields('center', 'Center', object.center), { key: 'radius', label: 'Radius', value: object.radius }, { key: 'startAngle', label: 'Start angle °', value: object.startAngle * 180 / Math.PI }, { key: 'sweepAngle', label: 'Sweep angle °', value: object.sweepAngle * 180 / Math.PI }];
      case 'text': return [...common, ...pointFields('position', 'Position', object.position), { key: 'height', label: 'Text height', value: object.height }, { key: 'text', label: 'Text', value: object.text }];
      case 'dimension': return [...common, ...pointFields('start', 'First point', object.start), ...pointFields('end', 'Second point', object.end), ...pointFields('offset', 'Dimension line', object.offset), { key: 'textHeight', label: 'Text height', value: object.textHeight }, { key: 'arrowSize', label: 'Arrow size', value: object.arrowSize }, { key: 'arrowType', label: 'Arrow type', value: object.arrowType }, { key: 'extensionBeyond', label: 'Extend beyond', value: object.extensionBeyond }, { key: 'extensionOffset', label: 'Object offset', value: object.extensionOffset }, { key: 'textOffset', label: 'Text offset', value: object.textOffset }, { key: 'precision', label: 'Precision', value: object.precision }, { key: 'scale', label: 'Scale', value: object.scale }];
      default: return [...common, { key: '_vertices', label: 'Vertices', value: object.type === 'bezier' ? 4 : object.vertices.length, kind: 'readonly' }];
    }
  }

  private fieldHtml(field: { key: string; label: string; value: string | number; kind?: string }): string {
    if (field.kind === 'layer') return this.layerHtml(String(field.value));
    if (field.kind === 'color') return this.colorHtml(Number(field.value));
    if (field.kind === 'readonly') return `<div class="property-row readonly"><span>${field.label}</span><output>${format(field.value)}</output></div>`;
    const type = typeof field.value === 'number' ? 'number' : 'text';
    return `<label class="property-row"><span>${field.label}</span><input data-field="${field.key}" type="${type}" value="${format(field.value)}" ${type === 'number' ? 'step="any"' : ''}></label>`;
  }

  private layerHtml(value: string): string { return `<label class="property-row"><span>Layer</span><select data-field="layer"><option value="" ${value ? '' : 'selected'}>Varies</option>${this.doc.layers.map((layer) => `<option ${layer === value ? 'selected' : ''}>${escapeHtml(layer)}</option>`).join('')}</select></label>`; }
  private colorHtml(value: number | null): string { return `<label class="property-row"><span>Color</span><input data-field="color" type="color" value="#${(value ?? 0xffffff).toString(16).padStart(6, '0')}"></label>`; }

  private bindInputs(object: ObjectValue, fields: ReturnType<PropertiesController['fields']>): void {
    this.content.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-field]').forEach((input) => input.addEventListener('change', () => {
      const key = input.dataset.field!;
      const value = input instanceof HTMLInputElement && input.type === 'color' ? Number.parseInt(input.value.slice(1), 16) : input.type === 'number' ? Number(input.value) : input.value;
      this.updateOne(object, key, value);
    }));
  }

  private updateOne(object: ObjectValue, key: string, value: string | number): void {
    const beforeEntity = 'type' in object ? cloneEntity(object) : null;
    const beforeSolid = !('type' in object) ? cloneSolid(object) : null;
    const after = 'type' in object ? cloneEntity(object) : cloneSolid(object);
    if (key === 'layer' && typeof value === 'string' && value) after.layer = value;
    else if (key === 'color' && typeof value === 'number') after.color = value;
    else if ('type' in after) updateEntity(after, key, value);
    else updateSolid(after, key, Number(value));
    this.history.execute(new ReplaceObjectsEdit('Change properties', beforeEntity ? [beforeEntity] : [], beforeSolid ? [beforeSolid] : [], 'type' in after ? [after] : [], !('type' in after) ? [after] : []));
    this.changed(); this.render();
  }

  private updateMultiple(objects: ObjectValue[], key: 'layer' | 'color', value: string | number): void {
    if (key === 'layer' && !value) return;
    const beforeEntities = objects.filter((o): o is Entity => 'type' in o).map(cloneEntity);
    const beforeSolids = objects.filter((o): o is Solid => !('type' in o)).map(cloneSolid);
    const afterEntities = beforeEntities.map((object) => ({ ...object, [key]: value } as Entity));
    const afterSolids = beforeSolids.map((object) => ({ ...object, [key]: value } as Solid));
    this.history.execute(new ReplaceObjectsEdit('Change properties', beforeEntities, beforeSolids, afterEntities, afterSolids));
    this.changed(); this.render();
  }
}

const pointFields = (key: string, label: string, point: { x: number; y: number }) => [{ key: `${key}.x`, label: `${label} X`, value: point.x }, { key: `${key}.y`, label: `${label} Y`, value: point.y }];
const format = (value: string | number): string => typeof value === 'number' ? String(Number(value.toFixed(6))) : escapeHtml(value);
const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function updateEntity(entity: Entity, key: string, value: string | number): void {
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  const [group, coordinate] = key.split('.');
  if (coordinate && group in entity) (entity as unknown as Record<string, Record<string, number>>)[group][coordinate] = Number(value);
  else if (key === 'radius' && (entity.type === 'circle' || entity.type === 'arc') && Number(value) > 0) entity.radius = Number(value);
  else if (key === 'height' && entity.type === 'text' && Number(value) > 0) entity.height = Number(value);
  else if (key === 'text' && entity.type === 'text') entity.text = String(value);
  else if (key === 'startAngle' && entity.type === 'arc') entity.startAngle = Number(value) * Math.PI / 180;
  else if (key === 'sweepAngle' && entity.type === 'arc') entity.sweepAngle = Number(value) * Math.PI / 180;
  else if (entity.type === 'dimension' && key === 'arrowType' && (value === 'closed' || value === 'open' || value === 'tick')) entity.arrowType = value;
  else if (entity.type === 'dimension' && ['textHeight', 'arrowSize', 'extensionBeyond', 'extensionOffset', 'textOffset', 'precision', 'scale'].includes(key)) {
    const number = Number(value);
    if (number >= 0 && (key !== 'textHeight' && key !== 'arrowSize' && key !== 'scale' || number > 0)) (entity as unknown as Record<string, number>)[key] = number;
  }
}

function updateSolid(solid: Solid, key: string, value: number): void {
  if (!Number.isFinite(value)) return;
  if (solid.feature.kind === 'primitive') {
    const feature = solid.feature;
    // Whether the key belongs to this primitive is the same question the fields
    // answered, so it is asked in the same place rather than listed again here.
    if (setPrimitiveParam(feature, key, value)) {
      // The engine builds primitives; this panel only says what changed. The
      // copy that used to live here had fallen behind it — it never applied a
      // scale, and it had never heard of a torus.
      solid.mesh = primitiveMesh(feature);
      solid.height = feature.height; solid.revision++;
      return;
    }
    // x, y and z are not the primitive's; they move it, which the bounds do.
  }
  const b = solidBounds(solid);
  const axis = key === 'x' || key === 'width' ? 0 : key === 'y' || key === 'depth' ? 1 : 2;
  const min = axis === 0 ? b.minX : axis === 1 ? b.minY : b.minZ;
  const size = axis === 0 ? b.maxX - b.minX : axis === 1 ? b.maxY - b.minY : b.maxZ - b.minZ;
  const resize = ['width', 'depth', 'height'].includes(key);
  if (resize && (value <= 0 || size <= 1e-12)) return;
  for (let index = axis; index < solid.mesh.positions.length; index += 3) solid.mesh.positions[index] = resize ? min + (solid.mesh.positions[index] - min) * value / size : solid.mesh.positions[index] + value - min;
  solid.feature = { kind: 'mesh' }; solid.revision++;
}
