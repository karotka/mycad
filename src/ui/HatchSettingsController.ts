import type { Document } from '../core/Document';

export class HatchSettingsController {
  private applying = false;

  constructor(private readonly doc: Document, private readonly form: HTMLFormElement, private readonly changed: () => void) {
    form.addEventListener('input', () => this.apply());
  }

  render(): void {
    if (this.applying) return;
    this.select('hatch-pattern').value = this.doc.hatch.pattern;
    this.input('hatch-angle').value = String(this.doc.hatch.angle);
    this.input('hatch-spacing').value = String(this.doc.hatch.spacing);
  }

  private apply(): void {
    this.applying = true;
    const pattern = this.select('hatch-pattern').value;
    const angle = Number(this.input('hatch-angle').value);
    const spacing = Number(this.input('hatch-spacing').value);
    if (pattern === 'lines' || pattern === 'cross' || pattern === 'solid') this.doc.hatch.pattern = pattern;
    if (Number.isFinite(angle)) this.doc.hatch.angle = angle;
    if (Number.isFinite(spacing) && spacing > 0) this.doc.hatch.spacing = spacing;
    this.doc.notify();
    this.changed();
    this.applying = false;
  }

  private input(id: string): HTMLInputElement { return this.form.querySelector<HTMLInputElement>(`#${id}`)!; }
  private select(id: string): HTMLSelectElement { return this.form.querySelector<HTMLSelectElement>(`#${id}`)!; }
}
