/**
 * The panel that shows how a solid was made, and lets you change it.
 *
 * Until now a union was a one-way door: the app could build one but only ever
 * handed back a mesh, so a model of twenty editable primitives was, from the
 * inside, a rock. Every number was still in the file. This is what reaches them.
 */
import type { Document } from '../core/Document';
import type { CommandHistory } from '../core/history/CommandHistory';
import { ReplaceObjectsEdit, UpdateSolidEdit, cloneSolid } from '../core/history/edits';
import type { Solid } from '../core/entities/types';
import { featureParams, type FeatureParam } from '../core/solids/featureParams';
import { editedSolid, featureRows, pathKey, removedFeatureSolid, type TreeRow } from './modelTree';

export class ModelTreeController {
  private collapsed = new Set<string>();
  /** Which row's parameters are open, as `solidId:path`. One at a time. */
  private opened: string | null = null;
  private applying = false;

  constructor(
    private readonly doc: Document,
    private readonly history: CommandHistory,
    private readonly panel: HTMLElement,
    private readonly list: HTMLElement,
    private readonly toggleButton: HTMLElement,
    close: HTMLElement,
    private readonly redraw: () => void,
    private readonly log: (message: string) => void,
  ) {
    toggleButton.addEventListener('click', () => this.toggle());
    close.addEventListener('click', () => { this.panel.hidden = true; this.syncToggle(); });
  }

  get isOpen(): boolean { return !this.panel.hidden; }

  toggle(): void {
    this.panel.hidden = !this.panel.hidden;
    this.syncToggle();
    if (!this.panel.hidden) this.render();
  }

  /** The button lights up while its panel is open, like the drafting toggles. */
  private syncToggle(): void {
    this.toggleButton.classList.toggle('active', !this.panel.hidden);
  }

  /** Same guard as the other panels: rebuilding the rows mid-edit steals focus. */
  render(): void {
    if (this.panel.hidden || this.applying) return;
    if (this.doc.solids.length === 0) {
      this.list.innerHTML = '<div class="properties-empty">No solids yet.</div>';
      return;
    }
    this.list.replaceChildren(...this.doc.solids.flatMap((solid) => this.solidRows(solid)));
  }

  private solidRows(solid: Solid): HTMLElement[] {
    const head = document.createElement('div');
    head.className = `tree-row tree-solid${solid.selected ? ' active' : ''}`;
    head.innerHTML = `<span class="tree-twist">${this.collapsed.has(solid.id) ? '▸' : '▾'}</span><span class="tree-label">${escapeHtml(solid.name)}</span><span class="tree-detail">${solid.mesh.indices.length / 3} tris</span>`;
    head.addEventListener('click', () => {
      this.doc.selectSolid(solid.id, true);
      this.render();
      this.redraw();
    });
    head.querySelector('.tree-twist')!.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!this.collapsed.delete(solid.id)) this.collapsed.add(solid.id);
      this.render();
    });
    if (this.collapsed.has(solid.id)) return [head];

    return [head, ...featureRows(solid.feature, this.collapsed).flatMap((row) => this.featureRow(solid, row))];
  }

  private featureRow(solid: Solid, row: TreeRow): HTMLElement[] {
    const key = `${solid.id}:${pathKey(row.path)}`;
    const element = document.createElement('div');
    element.className = `tree-row${this.opened === key ? ' active' : ''}`;
    element.style.paddingLeft = `${8 + row.depth * 13}px`;
    const twist = row.hasChildren ? (this.collapsed.has(pathKey(row.path)) ? '▸' : '▾') : '·';
    element.innerHTML = `<span class="tree-twist">${twist}</span><span class="tree-label">${escapeHtml(row.label)}</span><span class="tree-detail">${escapeHtml(row.detail)}</span>`;

    if (row.feature.kind === 'edge-modification') {
      const remove = document.createElement('button');
      remove.className = 'tree-delete';
      remove.type = 'button';
      remove.title = `Remove ${row.label}`;
      remove.setAttribute('aria-label', `Remove ${row.label}`);
      remove.textContent = '×';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.remove(solid, row.path, row.label);
      });
      element.append(remove);
    }

    if (row.hasChildren) {
      element.querySelector('.tree-twist')!.addEventListener('click', (event) => {
        event.stopPropagation();
        const path = pathKey(row.path);
        if (!this.collapsed.delete(path)) this.collapsed.add(path);
        this.render();
      });
    }
    // Whether there is anything to type at is the params' answer, not a list of
    // kinds kept here — asking for 'primitive' left an extrusion, which is as
    // parametric as anything in the file, looking like a dead end.
    const params = row.blockedByEdge ? [] : featureParams(row.feature);
    if (row.blockedByEdge) {
      element.title = 'Remove the later Chamfer/Fillet before editing this feature.';
    }
    if (params.length === 0) return [element];

    element.addEventListener('click', () => {
      this.opened = this.opened === key ? null : key;
      this.render();
    });
    if (this.opened !== key) return [element];
    return [element, this.params(solid, row, params)];
  }

  private params(solid: Solid, row: TreeRow, params: FeatureParam[]): HTMLElement {
    const form = document.createElement('div');
    form.className = 'tree-params';
    form.style.paddingLeft = `${8 + (row.depth + 1) * 13}px`;
    for (const param of params) {
      const field = document.createElement('label');
      field.className = 'property-row';
      field.innerHTML = `<span>${param.label}</span><input type="number" step="0.1" value="${param.value}">`;
      const input = field.querySelector('input')!;
      input.addEventListener('click', (event) => event.stopPropagation());
      input.addEventListener('change', () => { void this.apply(solid, row.path, param.key, Number(input.value), input, param.value); });
      form.append(field);
    }
    return form;
  }

  /**
   * Rebuilds the whole solid from its root, because a primitive deep inside a
   * boolean is not a shape on its own — changing it changes what the union or
   * the subtraction came out as, which is the point of the tree being a tree.
   */
  private async apply(solid: Solid, path: number[], key: string, value: number, input: HTMLInputElement, previous: number): Promise<void> {
    const before = cloneSolid(solid);
    const after = await editedSolid(solid, path, key, value);
    if (!after) {
      // Put the field back rather than leave the tree saying one thing and the
      // model showing another, and say so: a silent refusal is indistinguishable
      // from a change that did nothing.
      input.value = String(previous);
      this.log(`${key} = ${value} would leave nothing to build.`);
      return;
    }

    this.applying = true;
    try {
      this.history.execute(new ReplaceObjectsEdit(`Edit ${key}`, [], [before], [], [after]));
    } finally {
      this.applying = false;
    }
    this.render();
    this.redraw();
  }

  private async remove(solid: Solid, path: number[], label: string): Promise<void> {
    const before = cloneSolid(solid);
    const after = await removedFeatureSolid(solid, path);
    if (!after) {
      this.log(`${label} could not be removed because the remaining feature tree cannot be rebuilt.`);
      return;
    }
    this.history.execute(new UpdateSolidEdit(`Remove ${label}`, before, after));
    this.opened = null;
    this.render();
    this.redraw();
    this.log(`${label} removed.`);
  }
}

/** Solid names come from the file, so they are text until proven otherwise. */
const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
