import type { Document } from '../core/Document';
import type { CommandHistory } from '../core/history/CommandHistory';
import { DeleteLayerEdit } from '../core/history/edits';

export interface LayerControllerCallbacks {
  log(message: string): void;
  redraw(): void;
  objectsDeleted(): void;
}

export class LayerController {
  constructor(
    private readonly doc: Document,
    private readonly history: CommandHistory,
    private readonly panel: HTMLElement,
    private readonly list: HTMLElement,
    private readonly currentLabel: HTMLElement,
    toggle: HTMLElement,
    add: HTMLElement,
    private readonly callbacks: LayerControllerCallbacks,
  ) {
    toggle.addEventListener('click', () => {
      this.panel.hidden = !this.panel.hidden;
      if (!this.panel.hidden) this.render();
    });
    add.addEventListener('click', () => this.addLayer());
  }

  get isOpen(): boolean { return !this.panel.hidden; }

  render(): void {
    this.currentLabel.textContent = this.doc.currentLayer;
    const selectedLayers = new Set([
      ...this.doc.getSelectedEntities().map((entity) => entity.layer),
      ...this.doc.getSelectedSolids().map((solid) => solid.layer),
    ]);
    const highlightedLayer = selectedLayers.size === 1 ? [...selectedLayers][0] : this.doc.currentLayer;
    this.list.replaceChildren(...this.doc.layers.map((name) => this.createRow(name, highlightedLayer)));
  }

  private createRow(name: string, highlightedLayer: string): HTMLElement {
    const row = document.createElement('div');
    row.className = `layer-row${name === highlightedLayer ? ' active' : ''}`;
    const visible = !this.doc.hiddenLayers.has(name);
    const count = this.doc.entities.filter((entity) => entity.layer === name).length
      + this.doc.solids.filter((solid) => solid.layer === name).length;
    const color = this.doc.layerColors[name] ?? 0xffffff;
    const escapedName = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    row.innerHTML = `<button class="layer-eye" title="${visible ? 'Hide' : 'Show'} layer">${visible ? 'Hide' : 'Show'}</button><input class="layer-color" type="color" value="#${color.toString(16).padStart(6, '0')}" title="Layer color"><button class="layer-current-mark${name === this.doc.currentLayer ? ' active' : ''}" title="Set current layer">${name === this.doc.currentLayer ? '●' : '○'}</button><input class="layer-name" value="${escapedName}" maxlength="32" aria-label="Layer name" ${name === '0' ? 'readonly' : ''}><span>${count}</span><button class="layer-delete" title="${name === '0' ? 'Layer 0 cannot be deleted' : `Delete layer and ${count} object(s)`}" aria-label="Delete layer" ${name === '0' ? 'disabled' : ''}>×</button>`;

    row.querySelector<HTMLButtonElement>('.layer-eye')!.addEventListener('click', (event) => {
      event.stopPropagation();
      if (visible) this.doc.hiddenLayers.add(name); else this.doc.hiddenLayers.delete(name);
      this.doc.clearSelection();
      this.doc.notify();
      this.render();
    });
    row.addEventListener('click', () => this.activateLayer(name));
    this.bindNameInput(row, name);
    this.bindColorInput(row, name);
    row.querySelector<HTMLButtonElement>('.layer-delete')!.addEventListener('click', (event) => {
      event.stopPropagation();
      if (name === '0') return;
      this.history.execute(new DeleteLayerEdit(this.doc, name));
      this.callbacks.objectsDeleted();
      this.callbacks.log(`Deleted layer ${name} and ${count} object(s).`);
      this.render();
      this.callbacks.redraw();
    });
    return row;
  }

  private activateLayer(name: string): void {
    this.doc.currentLayer = name;
    this.doc.hiddenLayers.delete(name);
    const entities = this.doc.getSelectedEntities();
    const solids = this.doc.getSelectedSolids();
    const color = this.doc.layerColors[name] ?? 0xffffff;
    entities.forEach((entity) => { entity.layer = name; entity.color = color; });
    solids.forEach((solid) => { solid.layer = name; solid.color = color; });
    if (entities.length + solids.length > 0) this.callbacks.log(`Moved ${entities.length + solids.length} object(s) to layer ${name}.`);
    this.doc.notify();
    this.render();
    this.callbacks.redraw();
  }

  private bindNameInput(row: HTMLElement, name: string): void {
    const input = row.querySelector<HTMLInputElement>('.layer-name')!;
    input.addEventListener('change', () => {
      const nextName = input.value.trim();
      if (!nextName || nextName === name) { input.value = name; return; }
      if (this.doc.layers.includes(nextName)) {
        input.setCustomValidity('Layer already exists.');
        input.reportValidity();
        input.value = name;
        return;
      }
      input.setCustomValidity('');
      this.doc.layers[this.doc.layers.indexOf(name)] = nextName;
      this.doc.layerColors[nextName] = this.doc.layerColors[name] ?? 0xffffff;
      delete this.doc.layerColors[name];
      if (this.doc.currentLayer === name) this.doc.currentLayer = nextName;
      if (this.doc.hiddenLayers.delete(name)) this.doc.hiddenLayers.add(nextName);
      this.doc.entities.filter((entity) => entity.layer === name).forEach((entity) => { entity.layer = nextName; });
      this.doc.solids.filter((solid) => solid.layer === name).forEach((solid) => { solid.layer = nextName; });
      this.doc.notify();
      this.render();
    });
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    });
  }

  private bindColorInput(row: HTMLElement, name: string): void {
    const input = row.querySelector<HTMLInputElement>('.layer-color')!;
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('input', () => {
      const color = Number.parseInt(input.value.slice(1), 16);
      this.doc.layerColors[name] = color;
      this.doc.entities.filter((entity) => entity.layer === name).forEach((entity) => { entity.color = color; });
      this.doc.solids.filter((solid) => solid.layer === name).forEach((solid) => { solid.color = color; });
      this.doc.notify();
    });
  }

  private addLayer(): void {
    let number = 1;
    while (this.doc.layers.includes(`Layer ${number}`)) number++;
    const name = `Layer ${number}`;
    this.doc.layers.push(name);
    this.doc.layerColors[name] = 0xffffff;
    this.doc.currentLayer = name;
    this.render();
    this.callbacks.redraw();
    const inputs = this.list.querySelectorAll<HTMLInputElement>('.layer-name');
    const input = inputs[inputs.length - 1];
    input?.focus();
    input?.select();
  }
}
