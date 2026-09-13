import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { buildPrintSvg, DEFAULT_PRINT_STYLE } from './SvgExport';

describe('buildPrintSvg', () => {
  it('sizes the page to the requested paper and fits the window inside it', () => {
    const doc = new Document();
    const svg = buildPrintSvg(doc, { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } }, { widthMm: 297, heightMm: 210 });
    expect(svg).toContain('width="297.000mm"');
    expect(svg).toContain('height="210.000mm"');
  });

  it('draws a line inside the requested window as a stroked path', () => {
    const doc = new Document();
    doc.entities.push(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 }));
    const svg = buildPrintSvg(doc, { min: { x: -5, y: -5 }, max: { x: 15, y: 5 } }, { widthMm: 100, heightMm: 100 });
    expect(svg).toContain('<path');
    expect(svg).toContain('stroke=');
  });

  it('skips entities on a hidden layer', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    line.layer = 'secret';
    doc.entities.push(line);
    doc.hiddenLayers.add('secret');
    const svg = buildPrintSvg(doc, { min: { x: -5, y: -5 }, max: { x: 15, y: 5 } }, { widthMm: 100, heightMm: 100 });
    expect(svg).not.toContain('<path');
  });

  it('expands an insert into its block geometry', () => {
    const doc = new Document();
    const definition = { name: 'sym', basePoint: { x: 0, y: 0 }, entities: [doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 })] };
    const insert = doc.createInsert(definition, { x: 5, y: 5 });
    doc.entities.push(insert);
    const svg = buildPrintSvg(doc, { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }, { widthMm: 100, heightMm: 100 });
    expect(svg).toContain('<path');
  });

  it('centres a window narrower than the page aspect ratio instead of distorting it', () => {
    const doc = new Document();
    doc.entities.push(doc.createLine({ x: 0, y: 0 }, { x: 10, y: 10 }));
    const svg = buildPrintSvg(doc, { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }, { widthMm: 200, heightMm: 100 });
    // A square window fit into a 2:1 page scales by the limiting (height)
    // dimension, so the drawn line never reaches the page's full width.
    const match = svg.match(/M([\d.]+),([\d.]+) L([\d.]+),([\d.]+)/);
    expect(match).not.toBeNull();
    const xs = [Number(match![1]), Number(match![3])];
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 0);
  });

  it('prints a pure white object as black, since a dark canvas colour is invisible on paper', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    line.color = 0xffffff;
    doc.entities.push(line);
    const svg = buildPrintSvg(doc, { min: { x: -5, y: -5 }, max: { x: 15, y: 5 } }, { widthMm: 100, heightMm: 100 });
    expect(svg).toContain('stroke="#000000"');
    expect(svg).not.toContain('stroke="#ffffff"');
  });

  it('converts colour to perceptual grayscale in grayscale mode', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    line.color = 0xff0000; // pure red
    doc.entities.push(line);
    const svg = buildPrintSvg(doc, { min: { x: -5, y: -5 }, max: { x: 15, y: 5 } }, { widthMm: 100, heightMm: 100 }, { ...DEFAULT_PRINT_STYLE, colorMode: 'grayscale' });
    // 0.299 * 255 rounds to 76 = 0x4c
    expect(svg).toContain('stroke="#4c4c4c"');
  });

  it('forces every object to black in black-and-white mode, regardless of its colour', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    line.color = 0x3366ff;
    doc.entities.push(line);
    const svg = buildPrintSvg(doc, { min: { x: -5, y: -5 }, max: { x: 15, y: 5 } }, { widthMm: 100, heightMm: 100 }, { ...DEFAULT_PRINT_STYLE, colorMode: 'black' });
    expect(svg).toContain('stroke="#000000"');
  });

  it('draws each line of multi-line text as its own <text> element', () => {
    const doc = new Document();
    doc.entities.push(doc.createText({ x: 0, y: 0 }, 'one\ntwo\nthree', 10, 'Arial'));
    const svg = buildPrintSvg(doc, { min: { x: -5, y: -5 }, max: { x: 20, y: 20 } }, { widthMm: 100, heightMm: 100 });
    expect(svg.match(/<text/g)?.length).toBe(3);
    expect(svg).toContain('>one<');
    expect(svg).toContain('>two<');
    expect(svg).toContain('>three<');
  });

  it('prints every object at the same hairline width when lineweights are not kept', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    doc.layers.push('thick');
    line.layer = 'thick';
    doc.layerLineweight.thick = 2;
    doc.entities.push(line);

    const kept = buildPrintSvg(doc, { min: { x: -5, y: -5 }, max: { x: 15, y: 5 } }, { widthMm: 100, heightMm: 100 }, { ...DEFAULT_PRINT_STYLE, keepLineweights: true });
    expect(kept).toContain('stroke-width="2.000"');

    const uniform = buildPrintSvg(doc, { min: { x: -5, y: -5 }, max: { x: 15, y: 5 } }, { widthMm: 100, heightMm: 100 }, { ...DEFAULT_PRINT_STYLE, keepLineweights: false });
    expect(uniform).toContain('stroke-width="0.250"');
  });
});

describe('buildPrintSvg linetype scale', () => {
  /** One dashed line, printed to a page where 1 mm of drawing is 1 mm of paper. */
  const dashedPage = (configure: (doc: Document, line: ReturnType<Document['createLine']>) => void): string => {
    const doc = new Document();
    doc.layerLinetype['0'] = 'Dashed';
    const line = doc.createLine({ x: 0, y: 0 }, { x: 100, y: 0 });
    doc.entities.push(line);
    configure(doc, line);
    return buildPrintSvg(doc, { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } }, { widthMm: 100, heightMm: 100 });
  };

  it('prints the stock pattern when nothing is scaled', () => {
    // Dashed is 12 on / 6 off in mm, and this page is 1:1.
    expect(dashedPage(() => undefined)).toContain('stroke-dasharray="12.000,6.000"');
  });

  it('stretches it by the drawing\'s scale', () => {
    expect(dashedPage((doc) => { doc.drafting.linetypeScale = 3; })).toContain('stroke-dasharray="36.000,18.000"');
  });

  it('stretches it by the object\'s own scale on top of the drawing\'s', () => {
    const svg = dashedPage((doc, line) => { doc.drafting.linetypeScale = 3; line.linetypeScale = 2; });
    expect(svg).toContain('stroke-dasharray="72.000,36.000"');
  });
});
