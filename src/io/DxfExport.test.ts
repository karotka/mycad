import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { exportAsciiDxf } from './DxfExport';
import { importAsciiDxf } from './DxfImport';
import { ellipsePoints, type Entity } from '../core/entities/types';

/** Export `source`, read it straight back into a fresh document, return the entities. */
function roundTrip(source: Document): Entity[] {
  const dxf = exportAsciiDxf(source).dxf;
  return importAsciiDxf(new Document(), dxf).entities;
}

/** The value after the first occurrence of a group code in the raw DXF text. */
function codeValue(dxf: string, code: number, after = ''): string | undefined {
  const lines = dxf.replace(/\r/g, '').split('\n');
  const from = after ? lines.indexOf(after) : 0;
  for (let index = Math.max(0, from); index + 1 < lines.length; index += 1) {
    if (lines[index].trim() === String(code)) return lines[index + 1].trim();
  }
  return undefined;
}

describe('exportAsciiDxf structure', () => {
  it('declares millimetre units so the importer keeps the scale', () => {
    const dxf = exportAsciiDxf(new Document()).dxf;
    expect(dxf).toContain('$INSUNITS');
    expect(codeValue(dxf, 70, '$INSUNITS')).toBe('4');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('writes each layer with its colour, line type and line weight', () => {
    const doc = new Document();
    doc.layers = ['0', 'walls'];
    doc.layerAci = { '0': 7, walls: 1 };
    doc.layerLinetype = { '0': 'Continuous', walls: 'Hidden' };
    doc.layerLineweight = { '0': 0.25, walls: 0.5 };
    const dxf = exportAsciiDxf(doc).dxf;

    // The layer record carries colour (62), line type (6) and weight (370: 1/100 mm).
    expect(codeValue(dxf, 6, 'walls')).toBe('Hidden');
    expect(codeValue(dxf, 370, 'walls')).toBe('50');
    expect(codeValue(dxf, 62, 'walls')).toBe('1');
    // The Hidden line type it names must be defined in the LTYPE table.
    expect(dxf).toContain('LTYPE');
    const ltypeSection = dxf.slice(0, dxf.indexOf('LAYER'));
    expect(ltypeSection).toContain('Hidden');
  });

  it('round-trips per-layer line weight and line type through the importer', () => {
    const doc = new Document();
    doc.layers = ['0', 'walls'];
    doc.layerAci = { '0': 7, walls: 1 };
    doc.layerLinetype = { '0': 'Continuous', walls: 'Dashed' };
    doc.layerLineweight = { '0': 0.25, walls: 0.7 };
    doc.addEntity(doc.createLine({ x: 0, y: 0 }, { x: 1, y: 1 }));
    const read = importAsciiDxf(new Document(), exportAsciiDxf(doc).dxf);
    expect(read.layerLinetype.walls).toBe('Dashed');
    expect(read.layerLineweight.walls).toBeCloseTo(0.7, 6);
  });

  it('marks a hidden layer with a negative colour', () => {
    const doc = new Document();
    doc.layers = ['0', 'off'];
    doc.layerAci = { '0': 7, off: 3 };
    doc.hiddenLayers = new Set(['off']);
    expect(codeValue(exportAsciiDxf(doc).dxf, 62, 'off')).toBe('-3');
  });
});

describe('exportAsciiDxf entities round-trip through the importer', () => {
  it('keeps a line', () => {
    const doc = new Document();
    doc.addEntity(doc.createLine({ x: 1, y: 2 }, { x: 30, y: 40 }));
    const [line] = roundTrip(doc);
    expect(line.type).toBe('line');
    expect(line).toMatchObject({ start: { x: 1, y: 2 }, end: { x: 30, y: 40 } });
  });

  it('keeps a circle', () => {
    const doc = new Document();
    doc.addEntity(doc.createCircle({ x: 5, y: 6 }, 12));
    const [circle] = roundTrip(doc);
    expect(circle).toMatchObject({ type: 'circle', center: { x: 5, y: 6 }, radius: 12 });
  });

  it('keeps an arc, angles and all', () => {
    const doc = new Document();
    doc.addEntity(doc.createArc({ x: 0, y: 0 }, 10, 0, Math.PI / 2));
    const [arc] = roundTrip(doc);
    expect(arc.type).toBe('arc');
    if (arc.type !== 'arc') throw new Error('not an arc');
    expect(arc.center).toEqual({ x: 0, y: 0 });
    expect(arc.radius).toBeCloseTo(10, 6);
    expect(arc.startAngle).toBeCloseTo(0, 6);
    expect(arc.sweepAngle).toBeCloseTo(Math.PI / 2, 6);
  });

  it('keeps an ellipse when the major axis is X', () => {
    const doc = new Document();
    doc.addEntity(doc.createEllipse({ x: 2, y: 3 }, 20, 8, Math.PI / 6));
    const [ellipse] = roundTrip(doc);
    expect(ellipse.type).toBe('ellipse');
    if (ellipse.type !== 'ellipse') throw new Error('not an ellipse');
    expect(ellipse.center).toEqual({ x: 2, y: 3 });
    expect(ellipse.radiusX).toBeCloseTo(20, 6);
    expect(ellipse.radiusY).toBeCloseTo(8, 6);
    expect(ellipse.rotation).toBeCloseTo(Math.PI / 6, 6);
  });

  it('keeps an ellipse whose minor axis is X as the same shape', () => {
    // The exporter must hand DXF a ratio <= 1, so a tall ellipse comes back with
    // its axes swapped — a different description of the identical curve.
    const doc = new Document();
    const original = doc.createEllipse({ x: 0, y: 0 }, 5, 15, 0.2);
    doc.addEntity(original);
    const [imported] = roundTrip(doc);
    if (imported.type !== 'ellipse') throw new Error('not an ellipse');
    const a = ellipsePoints(original, 32);
    const b = ellipsePoints(imported, 32);
    // Same set of points on the curve, so the same ellipse.
    for (const point of a) {
      const near = b.some((other) => Math.hypot(other.x - point.x, other.y - point.y) < 1e-6);
      expect(near).toBe(true);
    }
  });

  it('keeps a rectangle as a closed four-corner outline', () => {
    const doc = new Document();
    doc.addEntity(doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 6 }));
    const [rectangle] = roundTrip(doc);
    expect(rectangle.type).toBe('polyline');
    if (rectangle.type !== 'polyline') throw new Error('not a polyline');
    expect(rectangle.closed).toBe(true);
    // The importer may repeat the first corner to close the ring, so the four
    // corners must be present rather than be exactly four vertices.
    expect(rectangle.vertices).toEqual(expect.arrayContaining([
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 },
    ]));
  });

  it('keeps an open polyline', () => {
    const doc = new Document();
    doc.addEntity(doc.createPolyline([{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 9, y: 7 }], false));
    const [polyline] = roundTrip(doc);
    expect(polyline.type).toBe('polyline');
    if (polyline.type !== 'polyline') throw new Error('not a polyline');
    expect(polyline.closed).toBe(false);
    expect(polyline.vertices).toEqual([{ x: 0, y: 0 }, { x: 5, y: 1 }, { x: 9, y: 7 }]);
  });

  it('keeps a bezier through its spline form', () => {
    const doc = new Document();
    doc.addEntity(doc.createBezier({ x: 0, y: 0 }, { x: 1, y: 5 }, { x: 8, y: 5 }, { x: 10, y: 0 }));
    const [bezier] = roundTrip(doc);
    expect(bezier.type).toBe('bezier');
    if (bezier.type !== 'bezier') throw new Error('not a bezier');
    expect(bezier.start).toEqual({ x: 0, y: 0 });
    expect(bezier.control1).toEqual({ x: 1, y: 5 });
    expect(bezier.control2).toEqual({ x: 8, y: 5 });
    expect(bezier.end).toEqual({ x: 10, y: 0 });
  });

  it('keeps text and its height', () => {
    const doc = new Document();
    doc.addEntity(doc.createText({ x: 3, y: 4 }, 'HELLO', 5));
    const [text] = roundTrip(doc);
    expect(text.type).toBe('text');
    if (text.type !== 'text') throw new Error('not text');
    expect(text.text).toBe('HELLO');
    expect(text.position).toEqual({ x: 3, y: 4 });
    expect(text.height).toBeCloseTo(5, 6);
  });

  it('carries an object colour that is not BYLAYER', () => {
    const doc = new Document();
    const line = doc.createLine({ x: 0, y: 0 }, { x: 1, y: 0 });
    line.aci = 1; // red, an override
    doc.addEntity(line);
    const [imported] = roundTrip(doc);
    expect(imported.aci).toBe(1);
  });
});

describe('exportAsciiDxf dimensions', () => {
  it('explodes a dimension into plain lines and text', () => {
    const doc = new Document();
    doc.addEntity(doc.createDimension({ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 25, y: 10 }, 'linear', 0));
    const result = exportAsciiDxf(doc);
    expect(result.dimensionsDecomposed).toBe(1);

    const entities = roundTrip(doc);
    // No live dimension survives; it is lines, an arrowhead outline, and the text.
    expect(entities.some((entity) => entity.type === 'dimension')).toBe(false);
    expect(entities.some((entity) => entity.type === 'line')).toBe(true);
    const text = entities.find((entity) => entity.type === 'text');
    expect(text).toBeDefined();
    if (text && text.type === 'text') expect(text.text).toContain('50');
  });
});
