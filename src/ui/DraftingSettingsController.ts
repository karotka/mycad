import type { Document } from '../core/Document';

/**
 * The drafting values behind the status-bar toggles: how far the cursor steps,
 * how far apart the grid sits, and which angles polar tracking follows. The
 * toggles say whether each aid is on; this says what it is set to.
 *
 * A sibling of DimensionStyleController, and the same shape deliberately.
 */
export class DraftingSettingsController {
  constructor(
    private readonly doc: Document,
    private readonly panel: HTMLElement,
    private readonly form: HTMLFormElement,
    toggle: HTMLElement,
    close: HTMLElement,
    private readonly changed: () => void,
  ) {
    toggle.addEventListener('click', () => this.toggle());
    close.addEventListener('click', () => { this.panel.hidden = true; });
    form.addEventListener('input', () => this.apply());
  }

  get isOpen(): boolean { return !this.panel.hidden; }

  toggle(): void {
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) this.render();
  }

  render(): void {
    this.set('drafting-snap-size', this.doc.snapSize);
    this.set('drafting-grid-size', this.doc.gridSize);
    this.set('drafting-polar-angles', formatAngles(this.doc.drafting.polarAngles));
  }

  private apply(): void {
    const positive = (id: string, fallback: number): number => {
      const value = Number(this.get(id).value);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    this.doc.snapSize = positive('drafting-snap-size', this.doc.snapSize);
    this.doc.gridSize = positive('drafting-grid-size', this.doc.gridSize);
    const angles = parseAngles(this.get('drafting-polar-angles').value);
    // An empty or unreadable list would silently turn polar tracking into
    // nothing but the four quadrants, so keep the last good one instead.
    if (angles.length > 0) this.doc.drafting.polarAngles = angles;
    this.doc.notify();
    this.changed();
  }

  private get(id: string): HTMLInputElement {
    const input = this.form.querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`Missing #${id}`);
    return input;
  }

  private set(id: string, value: string | number): void { this.get(id).value = String(value); }
}

/** Polar angles are a list, so they are typed as one: "30, 45, 90". */
export function parseAngles(value: string): number[] {
  const angles = value
    .split(/[,;\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((angle) => Number.isFinite(angle) && angle > 0 && angle < 360);
  return [...new Set(angles)].sort((a, b) => a - b);
}

export function formatAngles(angles: readonly number[]): string {
  return angles.join(', ');
}
