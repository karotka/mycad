import type { Document } from '../core/Document';
import type { DimensionStyle } from '../core/settings';
import { ACI_WHITE, aciToRgb } from '../io/DxfAci';

export class DimensionStyleController {
  constructor(
    private readonly doc: Document,
    private readonly form: HTMLFormElement,
    private readonly changed: () => void,
  ) {
    form.addEventListener('input', () => this.apply());
  }

  private applying = false;

  /**
   * The panel must not rewrite its own fields while they are being typed into.
   * apply() notifies the document, the notification comes back here, and a
   * half-typed ".2" would be replaced by the last good value on every keystroke
   * — so the box could never be cleared to type a new number.
   */
  render(): void {
    if (this.applying) return;

    const style = this.doc.dimensionStyle;
    this.set('dimension-text-height', style.textHeight);
    this.set('dimension-arrow-size', style.arrowSize);
    this.set('dimension-arrow-type', style.arrowType);
    this.set('dimension-extension-beyond', style.extensionBeyond);
    this.set('dimension-extension-offset', style.extensionOffset);
    this.set('dimension-text-offset', style.textOffset);
    this.set('dimension-precision', style.precision);
    this.set('dimension-angular-precision', style.angularPrecision);
    this.set('dimension-unit-suffix', style.unitSuffix);
    this.set('dimension-scale', style.scale);
    const layer = this.get('dimension-layer') as HTMLSelectElement;
    layer.replaceChildren(...Array.from(new Set([...this.doc.layers, style.layer])).map((name) => {
      const option = document.createElement('option'); option.value = name; option.textContent = name; return option;
    }));
    layer.value = style.layer;
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
    const precision = Number(this.get('dimension-precision').value);
    const angularPrecision = Number(this.get('dimension-angular-precision').value);
    const nonNegative = (id: string, fallback: number): number => {
      const value = Number(this.get(id).value);
      return Number.isFinite(value) && value >= 0 ? value : fallback;
    };
    const arrowType = this.get('dimension-arrow-type').value;
    const unitSuffix = this.get('dimension-unit-suffix').value;
    const layer = this.get('dimension-layer').value || 'dims';
    if (!this.doc.layers.includes(layer)) this.doc.layers.push(layer);
    if (!(layer in this.doc.layerAci)) { this.doc.layerAci[layer] = ACI_WHITE; this.doc.layerColors[layer] = aciToRgb(ACI_WHITE)!; }
    const style: DimensionStyle = {
      textHeight: positive('dimension-text-height', this.doc.dimensionStyle.textHeight),
      arrowSize: positive('dimension-arrow-size', this.doc.dimensionStyle.arrowSize),
      arrowType: arrowType === 'open' || arrowType === 'tick' ? arrowType : 'closed',
      extensionBeyond: nonNegative('dimension-extension-beyond', this.doc.dimensionStyle.extensionBeyond),
      extensionOffset: nonNegative('dimension-extension-offset', this.doc.dimensionStyle.extensionOffset),
      textOffset: nonNegative('dimension-text-offset', this.doc.dimensionStyle.textOffset),
      precision: Number.isInteger(precision) && precision >= 0 && precision <= 8 ? precision : this.doc.dimensionStyle.precision,
      angularPrecision: Number.isInteger(angularPrecision) && angularPrecision >= 0 && angularPrecision <= 8
        ? angularPrecision
        : this.doc.dimensionStyle.angularPrecision,
      unitSuffix: unitSuffix === 'mm' ? 'mm' : 'none',
      scale: positive('dimension-scale', this.doc.dimensionStyle.scale),
      layer,
    };
    this.doc.dimensionStyle = style;
    for (const entity of this.doc.entities) {
      if (entity.type !== 'dimension' || entity.layer !== layer) continue;
      entity.textHeight = style.textHeight;
      entity.arrowSize = style.arrowSize;
      entity.arrowType = style.arrowType;
      entity.extensionBeyond = style.extensionBeyond;
      entity.extensionOffset = style.extensionOffset;
      entity.textOffset = style.textOffset;
      entity.precision = style.precision;
      entity.angularPrecision = style.angularPrecision;
      entity.unitSuffix = style.unitSuffix;
      entity.scale = style.scale;
    }
    this.doc.notify();
    this.changed();
  }

  private get(id: string): HTMLInputElement | HTMLSelectElement {
    const input = this.form.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`);
    if (!input) throw new Error(`Missing #${id}`);
    return input;
  }

  private set(id: string, value: string | number): void { this.get(id).value = String(value); }
}
