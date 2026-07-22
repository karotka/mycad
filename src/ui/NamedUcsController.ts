import type { Document, NamedWorkPlane } from '../core/Document';

export interface NamedUcsCallbacks {
  beforeWorkPlaneChange(): void;
  workPlaneChanged(): void;
  log(message: string): void;
  /** A Dynamic UCS is current but has not been promoted to a named UCS. */
  isTemporaryWorkPlane?(): boolean;
}

const AXIS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V7M5 19h12M5 19l7-7M5 7l-2 3M5 7l2 3M17 19l-3-2M17 19l-3 2M12 12l-1-4M12 12l4-1"/></svg>';

/** The WCS shortcut and the editable, drawing-owned UCS shortcuts beside it. */
export class NamedUcsController {
  constructor(
    private readonly doc: Document,
    private readonly list: HTMLElement,
    private readonly wcsButton: HTMLButtonElement,
    private readonly callbacks: NamedUcsCallbacks,
  ) {
    this.wcsButton.addEventListener('click', () => this.restoreWorld());
  }

  render(): void {
    const temporary = this.callbacks.isTemporaryWorkPlane?.() === true;
    this.wcsButton.classList.toggle('active', !temporary && this.doc.activeNamedWorkPlaneId === null);
    this.list.replaceChildren(...this.doc.namedWorkPlanes.map((item) => this.itemElement(item)));
  }

  private itemElement(item: NamedWorkPlane): HTMLElement {
    const root = document.createElement('div');
    root.className = 'named-ucs-item';
    root.classList.toggle('active', this.callbacks.isTemporaryWorkPlane?.() !== true && item.id === this.doc.activeNamedWorkPlaneId);
    root.dataset.ucsId = item.id;

    const activate = document.createElement('button');
    activate.type = 'button';
    activate.className = 'named-ucs-activate';
    activate.innerHTML = AXIS_ICON;
    activate.title = this.description(item);
    activate.setAttribute('aria-label', `Activate ${item.name}`);
    activate.addEventListener('click', () => this.activate(item.id));

    const name = document.createElement('input');
    name.className = 'named-ucs-name';
    name.value = item.name;
    name.readOnly = true;
    name.size = Math.max(4, Math.min(16, item.name.length));
    name.title = `Double-click to rename ${item.name}`;
    name.setAttribute('aria-label', `Name of ${item.name}`);
    let cancelRename = false;
    let activationTimer: number | null = null;
    name.addEventListener('click', () => {
      if (!name.readOnly) return;
      if (activationTimer !== null) window.clearTimeout(activationTimer);
      activationTimer = window.setTimeout(() => {
        activationTimer = null;
        this.activate(item.id);
      }, 220);
    });
    name.addEventListener('dblclick', () => {
      if (activationTimer !== null) {
        window.clearTimeout(activationTimer);
        activationTimer = null;
      }
      cancelRename = false;
      name.readOnly = false;
      name.focus();
      name.select();
    });
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') name.blur();
      if (event.key === 'Escape') {
        cancelRename = true;
        name.value = item.name;
        name.blur();
      }
    });
    name.addEventListener('blur', () => {
      if (name.readOnly) return;
      name.readOnly = true;
      if (cancelRename) return;
      const previous = item.name;
      if (this.doc.renameNamedWorkPlane(item.id, name.value)) {
        this.callbacks.log(`${previous} renamed to ${name.value.trim()}.`);
      } else {
        name.value = item.name;
      }
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'named-ucs-remove';
    remove.textContent = '×';
    remove.title = `Delete ${item.name}`;
    remove.setAttribute('aria-label', `Delete ${item.name}`);
    remove.addEventListener('click', () => this.remove(item.id));

    root.append(activate, name, remove);
    return root;
  }

  private activate(id: string): void {
    this.callbacks.beforeWorkPlaneChange();
    const item = this.doc.activateNamedWorkPlane(id);
    if (!item) return;
    this.callbacks.workPlaneChanged();
    this.callbacks.log(`${item.name} activated. Origin ${this.point(item.workPlane.origin)}.`);
  }

  private remove(id: string): void {
    const wasActive = this.doc.activeNamedWorkPlaneId === id;
    if (wasActive) this.callbacks.beforeWorkPlaneChange();
    const item = this.doc.removeNamedWorkPlane(id);
    if (!item) return;
    if (wasActive) this.callbacks.workPlaneChanged();
    this.callbacks.log(`${item.name} deleted${wasActive ? '; World Coordinate System restored' : ''}.`);
  }

  private restoreWorld(): void {
    this.callbacks.beforeWorkPlaneChange();
    this.doc.restoreWorldWorkPlane();
    this.callbacks.workPlaneChanged();
    this.callbacks.log('World Coordinate System restored.');
  }

  private description(item: NamedWorkPlane): string {
    return `${item.name} — origin ${this.point(item.workPlane.origin)}; Z axis ${this.point(item.workPlane.zAxis)}`;
  }

  private point(point: { x: number; y: number; z: number }): string {
    return `${point.x.toFixed(3)}, ${point.y.toFixed(3)}, ${point.z.toFixed(3)}`;
  }
}
