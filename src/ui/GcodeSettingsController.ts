import type { Document } from '../core/Document';

/**
 * What the plotter is told: how fast to draw and travel, and which controller
 * commands home the machine and move the pen.
 *
 * A sibling of DraftingSettingsController and DimensionStyleController, and the
 * same shape deliberately.
 */
export class GcodeSettingsController {
  constructor(
    private readonly doc: Document,
    private readonly form: HTMLFormElement,
    private readonly changed: () => void,
  ) {
    form.addEventListener('input', () => this.apply());
  }

  private applying = false;

  /**
   * The panel must not rewrite its own fields while they are being typed into:
   * apply() notifies the document, the notification comes back here, and a
   * half-typed number would be replaced by the last good one on every keystroke.
   */
  render(): void {
    if (this.applying) return;
    this.set('gcode-homing-code', this.doc.gcode.homingCode);
    this.set('gcode-pen-up-code', this.doc.gcode.penUpCode);
    this.set('gcode-pen-down-code', this.doc.gcode.penDownCode);
    this.set('gcode-feed-rate', this.doc.gcode.feedRate);
    this.set('gcode-travel-rate', this.doc.gcode.travelRate);
    this.get('gcode-frame-visible').checked = this.doc.gcode.frameVisible;
    this.set('gcode-frame-width', this.doc.gcode.frameWidth);
    this.set('gcode-frame-height', this.doc.gcode.frameHeight);
    this.set('gcode-frame-origin-x', this.doc.gcode.frameOriginX);
    this.set('gcode-frame-origin-y', this.doc.gcode.frameOriginY);
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
    const finite = (id: string, fallback: number): number => {
      const raw = this.get(id).value.trim();
      if (!raw) return fallback;
      const value = Number(raw);
      return Number.isFinite(value) ? value : fallback;
    };
    const command = (id: string, fallback: string): string => this.get(id).value.trim() || fallback;
    this.doc.gcode.homingCode = command('gcode-homing-code', this.doc.gcode.homingCode);
    this.doc.gcode.penUpCode = command('gcode-pen-up-code', this.doc.gcode.penUpCode);
    this.doc.gcode.penDownCode = command('gcode-pen-down-code', this.doc.gcode.penDownCode);
    this.doc.gcode.feedRate = positive('gcode-feed-rate', this.doc.gcode.feedRate);
    this.doc.gcode.travelRate = positive('gcode-travel-rate', this.doc.gcode.travelRate);
    this.doc.gcode.frameVisible = this.get('gcode-frame-visible').checked;
    this.doc.gcode.frameWidth = positive('gcode-frame-width', this.doc.gcode.frameWidth);
    this.doc.gcode.frameHeight = positive('gcode-frame-height', this.doc.gcode.frameHeight);
    this.doc.gcode.frameOriginX = finite('gcode-frame-origin-x', this.doc.gcode.frameOriginX);
    this.doc.gcode.frameOriginY = finite('gcode-frame-origin-y', this.doc.gcode.frameOriginY);
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

  private set(id: string, value: string | number): void { this.get(id).value = String(value); }
}
