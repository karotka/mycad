import type { Document } from '../core/Document';

/**
 * What the plotter is told: how fast to draw, how fast to travel, and where the
 * pen sits when it is down and when it is lifted. The export used to run on
 * defaults with no way to reach them.
 *
 * A sibling of DraftingSettingsController and DimensionStyleController, and the
 * same shape deliberately.
 */
export class GcodeSettingsController {
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

  private applying = false;

  get isOpen(): boolean { return !this.panel.hidden; }

  toggle(): void {
    this.panel.hidden = !this.panel.hidden;
    if (!this.panel.hidden) this.render();
  }

  /**
   * The panel must not rewrite its own fields while they are being typed into:
   * apply() notifies the document, the notification comes back here, and a
   * half-typed number would be replaced by the last good one on every keystroke.
   */
  render(): void {
    if (this.applying) return;
    this.set('gcode-feed-rate', this.doc.gcode.feedRate);
    this.set('gcode-travel-rate', this.doc.gcode.travelRate);
    this.set('gcode-cut-depth', this.doc.gcode.cutDepth);
    this.set('gcode-safe-height', this.doc.gcode.safeHeight);
    this.set('gcode-segments', this.doc.gcode.segments);
  }

  private apply(): void {
    this.applying = true;
    try {
      this.write();
    } finally {
      this.applying = false;
    }
  }

  private write(): void {
    const positive = (id: string, fallback: number): number => {
      const value = Number(this.get(id).value);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    this.doc.gcode.feedRate = positive('gcode-feed-rate', this.doc.gcode.feedRate);
    this.doc.gcode.travelRate = positive('gcode-travel-rate', this.doc.gcode.travelRate);
    this.doc.gcode.safeHeight = positive('gcode-safe-height', this.doc.gcode.safeHeight);
    // The only one that may be zero or below: a pen touches the paper at Z 0 and
    // a knife goes under it, so `positive` would refuse the ordinary case.
    const depth = Number(this.get('gcode-cut-depth').value);
    if (Number.isFinite(depth)) this.doc.gcode.cutDepth = depth;
    // Below three there is no curve left to draw, whatever the field says.
    const segments = Number(this.get('gcode-segments').value);
    if (Number.isInteger(segments) && segments >= 3) this.doc.gcode.segments = segments;
    this.doc.notify();
    this.changed();
  }

  private get(id: string): HTMLInputElement {
    const input = this.form.querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`Missing #${id}`);
    return input;
  }

  private set(id: string, value: number): void { this.get(id).value = String(value); }
}
