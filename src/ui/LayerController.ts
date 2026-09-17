import type { Document } from '../core/Document';
import type { CommandHistory } from '../core/history/CommandHistory';
import { DeleteLayerEdit, ReplaceObjectsEdit, cloneSolid } from '../core/history/edits';
import { cloneEntity } from '../core/entities/types';
import { toolIcon } from './toolIcons';
import { dropTarget, reorderLayers } from './layerOrder';
import { ACI_WHITE, aciToRgb, rgbToAci } from '../io/DxfAci';
import { DEFAULT_LINE_TYPE, DEFAULT_LINE_WEIGHT_MM, LINE_TYPES, LINE_TYPE_NAMES, LINE_WEIGHTS_MM, lineWeightToPixels } from '../core/lineStyles';

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
    close: HTMLElement,
    private readonly callbacks: LayerControllerCallbacks,
  ) {
    // Anything pressed that is not the swatch means the picker is done with,
    // whenever that happened — the only signal that does not arrive while it
    // is still open.
    document.addEventListener('pointerdown', (event) => {
      if (!this.picking || event.target === this.picking) return;
      this.picking = null;
      if (this.isOpen) this.render();
    }, true);
    toggle.addEventListener('click', () => this.toggle());
    close.addEventListener('click', () => this.close());
    add.addEventListener('click', () => this.addLayer());
    this.bindListDrop();
  }

  /** The layer being dragged, or null. Rows are rebuilt on render, the list is not. */
  private dragging: string | null = null;

  /**
   * The colour input whose picker is open, or null.
   *
   * The picker is the browser's own and is anchored to the input element that
   * opened it. Every render rebuilds the rows, which takes that element out of
   * the page — and the picker goes with it. So while one is open the rows are
   * left alone entirely: not rebuilt and put back, which detaches the element
   * just the same, but not touched.
   *
   * What ends it is deliberately not `change` or `blur`. Both arrive while the
   * picker is still open and being used, and rebuilding on either shuts it —
   * reported as being unable to change the values at all. The only signal that
   * cannot arrive from inside the picker is a press somewhere else in the page.
   */
  private picking: HTMLInputElement | null = null;

  get isOpen(): boolean { return !this.panel.hidden; }

  toggle(): void {
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) this.render();
  }

  close(): void { this.panel.hidden = true; }

  render(): void {
    // Not while a colour picker is open on one of these rows — see `picking`.
    // Nothing else about the panel can change meanwhile, and the row being
    // picked already shows the colour as it is chosen.
    if (this.picking) return;
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
    const weight = this.doc.layerLineweight[name] ?? DEFAULT_LINE_WEIGHT_MM;
    const linetype = this.doc.layerLinetype[name] ?? DEFAULT_LINE_TYPE;
    const escapedName = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    row.dataset.layer = name;
    row.innerHTML = `<button class="layer-drag" title="Drag to reorder — G-code cuts the layers in this order" aria-label="Reorder layer">⠿</button><button class="layer-eye${visible ? '' : ' off'}" title="${visible ? 'Hide' : 'Show'} layer" aria-label="${visible ? 'Hide' : 'Show'} layer">${toolIcon('ISOLATEOBJECTS')}</button><button class="layer-paw" title="Move the selected object(s) to this layer" aria-label="Move selection to this layer">${toolIcon('LAYCUR')}</button><button class="layer-current-mark${name === this.doc.currentLayer ? ' active' : ''}" title="Set current layer">${name === this.doc.currentLayer ? '●' : '○'}</button><input class="layer-color" type="color" value="#${color.toString(16).padStart(6, '0')}" title="Layer color"><button class="layer-lineweight" title="Line weight — ${mmLabel(weight)}" aria-label="Line weight">${mmLabel(weight)}</button><button class="layer-linetype" title="Line type — ${linetype}" aria-label="Line type">${linetypeSvg(linetype)}</button><input class="layer-name" value="${escapedName}" maxlength="32" aria-label="Layer name" ${name === '0' ? 'readonly' : ''}><span>${count}</span><button class="layer-delete" title="${name === '0' ? 'Layer 0 cannot be deleted' : `Delete layer and ${count} object(s)`}" aria-label="Delete layer" ${name === '0' ? 'disabled' : ''}>×</button>`;

    row.querySelector<HTMLButtonElement>('.layer-eye')!.addEventListener('click', (event) => {
      event.stopPropagation();
      if (visible) this.doc.hiddenLayers.add(name); else this.doc.hiddenLayers.delete(name);
      this.doc.clearSelection();
      this.doc.notify();
      this.render();
    });
    row.querySelector<HTMLButtonElement>('.layer-paw')!.addEventListener('click', (event) => {
      event.stopPropagation();
      this.moveSelectionToLayer(name);
    });
    row.addEventListener('click', () => this.activateLayer(name));
    this.bindDragHandle(row, name);
    this.bindNameInput(row, name);
    this.bindColorInput(row, name);
    this.bindLineweightPicker(row, name);
    this.bindLinetypePicker(row, name);
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
    // Move them to the layer; their colour follows from recolour, so a BYLAYER
    // object takes the new layer's colour and an overridden one keeps its own.
    entities.forEach((entity) => { entity.layer = name; });
    solids.forEach((solid) => { solid.layer = name; });
    if (entities.length + solids.length > 0) this.callbacks.log(`Moved ${entities.length + solids.length} object(s) to layer ${name}.`);
    this.doc.recolour();
    this.doc.notify();
    this.render();
    this.callbacks.redraw();
  }

  /**
   * The paw: move whatever is selected onto this layer as one undoable edit,
   * without disturbing the current layer. Colours follow through recolour, so a
   * BYLAYER object takes this layer's colour and an overridden one keeps its own.
   */
  private moveSelectionToLayer(name: string): void {
    const entities = this.doc.getSelectedEntities();
    const solids = this.doc.getSelectedSolids();
    if (entities.length + solids.length === 0) {
      this.callbacks.log('Select object(s) first, then click the paw to move them to this layer.');
      return;
    }
    const beforeEntities = entities.map(cloneEntity);
    const beforeSolids = solids.map(cloneSolid);
    const afterEntities = beforeEntities.map((entity) => ({ ...entity, layer: name }));
    const afterSolids = beforeSolids.map((solid) => ({ ...solid, layer: name }));
    this.history.execute(new ReplaceObjectsEdit(`Move to layer ${name}`, beforeEntities, beforeSolids, afterEntities, afterSolids));
    this.doc.recolour();
    this.doc.notify();
    this.callbacks.log(`Moved ${entities.length + solids.length} object(s) to layer ${name}.`);
    this.render();
    this.callbacks.redraw();
  }

  /**
   * The row is only draggable while the handle is held. Draggable the whole
   * time, a drag started in the name box would pick the row up instead of
   * selecting the text in it.
   */
  private bindDragHandle(row: HTMLElement, name: string): void {
    const handle = row.querySelector<HTMLButtonElement>('.layer-drag')!;
    handle.addEventListener('click', (event) => event.stopPropagation());
    handle.addEventListener('pointerdown', () => { row.draggable = true; });
    handle.addEventListener('pointerup', () => { row.draggable = false; });

    row.addEventListener('dragstart', (event) => {
      this.dragging = name;
      row.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', name);
    });
    row.addEventListener('dragend', () => {
      this.dragging = null;
      row.draggable = false;
      row.classList.remove('dragging');
      this.list.querySelectorAll('.drop-before').forEach((element) => element.classList.remove('drop-before'));
    });
  }

  /** Where the pointer currently is, and what that means for the order. */
  private bindListDrop(): void {
    this.list.addEventListener('dragover', (event) => {
      if (!this.dragging) return;
      event.preventDefault(); // without this the drop never fires
      const target = this.targetUnder(event.clientY);
      this.list.querySelectorAll('.drop-before').forEach((element) => element.classList.remove('drop-before'));
      if (target) this.list.querySelector(`[data-layer="${CSS.escape(target)}"]`)?.classList.add('drop-before');
    });
    this.list.addEventListener('drop', (event) => {
      if (!this.dragging) return;
      event.preventDefault();
      const moved = this.dragging;
      const before = this.targetUnder(event.clientY);
      const reordered = reorderLayers(this.doc.layers, moved, before);
      if (reordered.join(' ') === this.doc.layers.join(' ')) return;
      this.doc.layers = reordered;
      this.doc.notify();
      this.render();
      this.callbacks.log(`Layer order: ${this.doc.layers.join(' → ')}.`);
    });
  }

  private targetUnder(clientY: number): string | null {
    const rows = [...this.list.querySelectorAll<HTMLElement>('.layer-row')]
      .filter((row) => row.dataset.layer !== this.dragging)
      .map((row) => {
        const box = row.getBoundingClientRect();
        return { name: row.dataset.layer ?? '', top: box.top, bottom: box.bottom };
      });
    return dropTarget(rows, clientY);
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
      this.doc.layerAci[nextName] = this.doc.layerAci[name] ?? ACI_WHITE;
      this.doc.layerColors[nextName] = this.doc.layerColors[name] ?? aciToRgb(ACI_WHITE)!;
      this.doc.layerLineweight[nextName] = this.doc.layerLineweight[name] ?? DEFAULT_LINE_WEIGHT_MM;
      this.doc.layerLinetype[nextName] = this.doc.layerLinetype[name] ?? DEFAULT_LINE_TYPE;
      delete this.doc.layerAci[name];
      delete this.doc.layerColors[name];
      delete this.doc.layerLineweight[name];
      delete this.doc.layerLinetype[name];
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
    input.addEventListener('click', (event) => {
      event.stopPropagation();
      // A click on the swatch is what opens the picker, so from here the rows
      // are left alone until the user presses something else.
      this.picking = input;
    });
    input.addEventListener('input', () => {
      this.picking = input;
      // The picker is RGB; the layer stores an index. The colour snaps to the
      // nearest palette entry, and everything BYLAYER on it follows through
      // recolour — no need to touch the objects one by one.
      const rgb = Number.parseInt(input.value.slice(1), 16);
      this.doc.setLayerAci(name, rgbToAci(rgb));
    });
  }

  private bindLineweightPicker(row: HTMLElement, name: string): void {
    const trigger = row.querySelector<HTMLButtonElement>('.layer-lineweight')!;
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const current = String(this.doc.layerLineweight[name] ?? DEFAULT_LINE_WEIGHT_MM);
      const options = LINE_WEIGHTS_MM.map((mm) => ({ value: String(mm), label: mmLabel(mm), svg: lineweightSvg(mm), text: mmLabel(mm) }));
      this.openStyleMenu(trigger, options, current, (value) => {
        this.doc.layerLineweight[name] = Number.parseFloat(value);
        this.doc.notify();
        this.render();
        this.callbacks.redraw();
      });
    });
  }

  private bindLinetypePicker(row: HTMLElement, name: string): void {
    const trigger = row.querySelector<HTMLButtonElement>('.layer-linetype')!;
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const current = this.doc.layerLinetype[name] ?? DEFAULT_LINE_TYPE;
      const options = LINE_TYPE_NAMES.map((type) => ({ value: type, label: type, svg: linetypeSvg(type) }));
      this.openStyleMenu(trigger, options, current, (value) => {
        this.doc.layerLinetype[name] = value;
        this.doc.notify();
        this.render();
        this.callbacks.redraw();
      });
    });
  }

  /** The open line-style popup, and the listener that dismisses it, or null. */
  private styleMenu: HTMLElement | null = null;
  private styleMenuDismiss: ((event: Event) => void) | null = null;

  /**
   * A little floating menu of rendered line samples, anchored to the trigger.
   * It shows the lines themselves rather than their names, which is the whole
   * point — you pick the weight or dash pattern by looking at it.
   */
  private openStyleMenu(
    anchor: HTMLElement,
    options: { value: string; label: string; svg: string; text?: string }[],
    current: string,
    onPick: (value: string) => void,
  ): void {
    this.closeStyleMenu();
    const menu = document.createElement('div');
    menu.className = 'line-style-menu';
    for (const option of options) {
      const item = document.createElement('button');
      item.className = `line-style-option${option.value === current ? ' active' : ''}`;
      item.title = option.label;
      item.setAttribute('aria-label', option.label);
      item.innerHTML = option.text ? `${option.svg}<span>${option.text}</span>` : option.svg;
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        this.closeStyleMenu();
        onPick(option.value);
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);

    // Anchored to the trigger, opening upward when the panel sits low on screen
    // (it usually does), and nudged in so it never spills off an edge.
    const box = anchor.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const top = box.top - size.height - 4 >= 4 ? box.top - size.height - 4 : box.bottom + 4;
    const left = Math.min(box.left, window.innerWidth - size.width - 4);
    menu.style.top = `${Math.max(4, top)}px`;
    menu.style.left = `${Math.max(4, left)}px`;
    this.styleMenu = menu;

    this.styleMenuDismiss = (event: Event) => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') this.closeStyleMenu(); return; }
      if (!menu.contains(event.target as Node)) this.closeStyleMenu();
    };
    // Deferred so the click that opened the menu does not immediately close it.
    setTimeout(() => {
      if (!this.styleMenuDismiss) return;
      document.addEventListener('mousedown', this.styleMenuDismiss);
      document.addEventListener('keydown', this.styleMenuDismiss);
    });
  }

  private closeStyleMenu(): void {
    if (this.styleMenuDismiss) {
      document.removeEventListener('mousedown', this.styleMenuDismiss);
      document.removeEventListener('keydown', this.styleMenuDismiss);
      this.styleMenuDismiss = null;
    }
    this.styleMenu?.remove();
    this.styleMenu = null;
  }

  private addLayer(): void {
    let number = 1;
    while (this.doc.layers.includes(`Layer ${number}`)) number++;
    const name = `Layer ${number}`;
    this.doc.layers.push(name);
    this.doc.layerAci[name] = ACI_WHITE;
    this.doc.layerColors[name] = aciToRgb(ACI_WHITE)!;
    this.doc.layerLineweight[name] = DEFAULT_LINE_WEIGHT_MM;
    this.doc.layerLinetype[name] = DEFAULT_LINE_TYPE;
    this.doc.currentLayer = name;
    this.render();
    this.callbacks.redraw();
    const inputs = this.list.querySelectorAll<HTMLInputElement>('.layer-name');
    const input = inputs[inputs.length - 1];
    input?.focus();
    input?.select();
  }
}

const PREVIEW_WIDTH = 46;
const PREVIEW_HEIGHT = 16;
const PREVIEW_INSET = 3;

/** A weight as a short label in its own units, like `0.25 mm`. */
function mmLabel(weightMm: number): string {
  return `${weightMm.toFixed(2)} mm`;
}

/** A sample line at the weight's true on-screen thickness, for the menu. */
function lineweightSvg(weightMm: number): string {
  const width = lineWeightToPixels(weightMm);
  return `<svg viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" aria-hidden="true"><line x1="${PREVIEW_INSET}" y1="${PREVIEW_HEIGHT / 2}" x2="${PREVIEW_WIDTH - PREVIEW_INSET}" y2="${PREVIEW_HEIGHT / 2}" stroke="currentColor" stroke-width="${width.toFixed(2)}" stroke-linecap="round"/></svg>`;
}

/**
 * A sample line in the type's dash pattern. The pattern is scaled so a couple of
 * repeats fit the little swatch — enough to read the rhythm (Dashed vs Center vs
 * DashDot) without showing true world lengths, which is what the drawing is for.
 */
function linetypeSvg(name: string): string {
  const pattern = LINE_TYPES[name] ?? [];
  let dash = '';
  if (pattern.length > 0) {
    const sum = pattern.reduce((total, segment) => total + segment, 0);
    const scale = 18 / sum;
    dash = ` stroke-dasharray="${pattern.map((segment) => Math.max(0.5, Number((segment * scale).toFixed(1)))).join(' ')}"`;
  }
  return `<svg viewBox="0 0 ${PREVIEW_WIDTH} ${PREVIEW_HEIGHT}" width="${PREVIEW_WIDTH}" height="${PREVIEW_HEIGHT}" aria-hidden="true"><line x1="${PREVIEW_INSET}" y1="${PREVIEW_HEIGHT / 2}" x2="${PREVIEW_WIDTH - PREVIEW_INSET}" y2="${PREVIEW_HEIGHT / 2}" stroke="currentColor" stroke-width="1.4"${dash}/></svg>`;
}
