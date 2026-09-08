import type { Document } from '../core/Document';
import type { MlineStyle } from '../core/settings';
import { STANDARD_MLINE_STYLE_ID } from '../core/settings';

export interface MlineStyleCallbacks {
  log(message: string): void;
}

/**
 * The MLSTYLE manager: a panel listing named multiline styles, each
 * expandable into its own element table (offset/colour/linetype per
 * parallel line) — AutoCAD's MLSTYLE dialog, condensed into one list the
 * same way NamedUcsController condenses UCS management into one.
 */
export class MlineStyleController {
  /** Which style's element table is expanded — view-only state, not part
   *  of the Document, so it needs its own render() call on change. */
  private expandedStyleId: string | null = null;

  constructor(
    private readonly doc: Document,
    private readonly panel: HTMLElement,
    private readonly list: HTMLElement,
    private readonly toggleButton: HTMLElement,
    create: HTMLElement,
    close: HTMLElement,
    private readonly callbacks: MlineStyleCallbacks,
  ) {
    toggleButton.addEventListener('click', () => this.toggle());
    close.addEventListener('click', () => this.close());
    create.addEventListener('click', () => this.create());
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
    this.list.replaceChildren(...this.doc.mlineStyles.map((style) => this.itemElement(style)));
  }

  private create(): void {
    const style = this.doc.addMlineStyle();
    this.expandedStyleId = style.id;
    this.callbacks.log(`${style.name} created.`);
  }

  private itemElement(style: MlineStyle): HTMLElement {
    const standard = style.id === STANDARD_MLINE_STYLE_ID;
    const current = style.id === this.doc.currentMlineStyleId;

    const root = document.createElement('div');
    root.className = 'mline-style-item';
    root.classList.toggle('active', current);
    root.dataset.mlineStyleId = style.id;

    const header = document.createElement('div');
    header.className = 'mline-style-header';

    const activate = document.createElement('button');
    activate.type = 'button';
    activate.className = 'mline-style-activate';
    activate.textContent = current ? '●' : '○';
    activate.title = `Set ${style.name} as the current MLSTYLE`;
    activate.setAttribute('aria-label', `Set ${style.name} as the current MLSTYLE`);
    activate.addEventListener('click', () => this.activate(style.id));

    const name = document.createElement('input');
    name.className = 'mline-style-name';
    name.value = style.name;
    name.readOnly = true;
    name.disabled = standard;
    name.size = Math.max(4, Math.min(16, style.name.length));
    name.title = standard ? 'STANDARD cannot be renamed' : `Double-click to rename ${style.name}`;
    name.setAttribute('aria-label', `Name of ${style.name}`);
    if (!standard) {
      let cancelRename = false;
      name.addEventListener('dblclick', () => {
        cancelRename = false;
        name.readOnly = false;
        name.focus();
        name.select();
      });
      name.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') name.blur();
        if (event.key === 'Escape') {
          cancelRename = true;
          name.value = style.name;
          name.blur();
        }
      });
      name.addEventListener('blur', () => {
        if (name.readOnly) return;
        name.readOnly = true;
        if (cancelRename) return;
        const previous = style.name;
        if (this.doc.renameMlineStyle(style.id, name.value)) {
          this.callbacks.log(`${previous} renamed to ${name.value.trim()}.`);
        } else {
          name.value = style.name;
        }
      });
    }

    const expanded = this.expandedStyleId === style.id;
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'mline-style-expand';
    expand.textContent = expanded ? '▾' : '▸';
    expand.title = `${expanded ? 'Hide' : 'Edit'} ${style.name}'s lines`;
    expand.setAttribute('aria-label', `${expanded ? 'Hide' : 'Edit'} ${style.name}'s lines`);
    expand.addEventListener('click', () => {
      this.expandedStyleId = expanded ? null : style.id;
      this.render();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mline-style-remove';
    remove.textContent = '×';
    remove.disabled = standard || current;
    remove.title = standard ? 'STANDARD cannot be deleted' : current ? 'Set another style current first' : `Delete ${style.name}`;
    remove.setAttribute('aria-label', `Delete ${style.name}`);
    remove.addEventListener('click', () => this.remove(style.id));

    header.append(activate, name, expand, remove);
    root.append(header);
    if (expanded) root.append(this.elementsTable(style));
    return root;
  }

  private elementsTable(style: MlineStyle): HTMLElement {
    const table = document.createElement('div');
    table.className = 'mline-style-elements';

    style.elements.forEach((element, index) => {
      const row = document.createElement('div');
      row.className = 'mline-style-element';

      const offset = document.createElement('input');
      offset.type = 'number';
      offset.step = '0.1';
      offset.value = String(element.offset);
      offset.title = 'Offset from the centerline';
      offset.setAttribute('aria-label', `Line ${index + 1} offset`);
      offset.addEventListener('change', () => {
        const value = Number(offset.value);
        if (Number.isFinite(value)) this.doc.updateMlineStyleElement(style.id, index, { offset: value });
      });

      const aci = document.createElement('input');
      aci.type = 'number';
      aci.min = '0';
      aci.max = '256';
      aci.step = '1';
      aci.value = String(element.aci);
      aci.title = 'AutoCAD color index (1-255 a color of its own, 256 = ByLayer)';
      aci.setAttribute('aria-label', `Line ${index + 1} color index`);
      aci.addEventListener('change', () => {
        const value = Math.round(Number(aci.value));
        if (Number.isInteger(value) && value >= 0 && value <= 256) this.doc.updateMlineStyleElement(style.id, index, { aci: value });
      });

      const linetype = document.createElement('input');
      linetype.type = 'text';
      linetype.value = element.linetype;
      linetype.title = 'Linetype name, e.g. Continuous or Dashed';
      linetype.setAttribute('aria-label', `Line ${index + 1} linetype`);
      linetype.addEventListener('change', () => {
        this.doc.updateMlineStyleElement(style.id, index, { linetype: linetype.value.trim() || 'Continuous' });
      });

      const removeElement = document.createElement('button');
      removeElement.type = 'button';
      removeElement.textContent = '×';
      removeElement.title = style.elements.length <= 1 ? 'An MLSTYLE needs at least one line' : `Remove line ${index + 1}`;
      removeElement.setAttribute('aria-label', `Remove line ${index + 1}`);
      removeElement.disabled = style.elements.length <= 1;
      removeElement.addEventListener('click', () => this.doc.removeMlineStyleElement(style.id, index));

      row.append(offset, aci, linetype, removeElement);
      table.append(row);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mline-style-add-element';
    add.textContent = '+ Add line';
    add.addEventListener('click', () => this.doc.addMlineStyleElement(style.id));
    table.append(add);

    return table;
  }

  private activate(id: string): void {
    const style = this.doc.mlineStyles.find((item) => item.id === id);
    if (style && this.doc.setCurrentMlineStyle(id)) this.callbacks.log(`${style.name} set as the current MLSTYLE.`);
  }

  private remove(id: string): void {
    const style = this.doc.mlineStyles.find((item) => item.id === id);
    if (!style) return;
    if (this.doc.removeMlineStyle(id)) {
      if (this.expandedStyleId === id) this.expandedStyleId = null;
      this.callbacks.log(`${style.name} deleted.`);
    }
  }
}
