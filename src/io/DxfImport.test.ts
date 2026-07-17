import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { importAsciiDxf } from './DxfImport';
import { dimensionGeometry } from '../core/entities/types';

const dxf = (entities: string, units = 4) => `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n${units}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;

describe('DXF import', () => {
  it('imports common 2D entities and layers', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf(
      '0\nLINE\n8\nOutline\n10\n0\n20\n0\n11\n10\n21\n5\n'
      + '0\nCIRCLE\n8\nHoles\n10\n4\n20\n3\n40\n2\n'
      + '0\nARC\n8\nOutline\n10\n0\n20\n0\n40\n5\n50\n0\n51\n90\n'
      + '0\nLWPOLYLINE\n8\nOutline\n70\n1\n10\n0\n20\n0\n10\n4\n20\n0\n10\n4\n20\n3\n',
    ));
    expect(result.entities.map((entity) => entity.type)).toEqual(['line', 'circle', 'arc', 'polyline']);
    expect(result.layers).toEqual(expect.arrayContaining(['Outline', 'Holes']));
    expect(result.entities[3]).toMatchObject({ type: 'polyline', closed: true });
  });

  it('converts inch drawing units to millimetres', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nLINE\n10\n0\n20\n0\n11\n2\n21\n0\n', 1));
    expect(result.unitScale).toBe(25.4);
    expect(result.entities[0]).toMatchObject({ type: 'line', end: { x: 50.8, y: 0 } });
  });
});

const dxfWithTables = (tables: string, entities: string) =>
  `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n`
  + `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n${tables}0\nENDTAB\n0\nENDSEC\n`
  + `0\nSECTION\n2\nENTITIES\n${entities}0\nENDSEC\n0\nEOF\n`;

describe('DXF import keeps what the drawing says', () => {
  it('takes layer colours from the TABLES section instead of defaulting to white', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxfWithTables(
      '0\nLAYER\n2\nOutline\n62\n1\n0\nLAYER\n2\nHoles\n62\n5\n',
      '0\nLINE\n8\nOutline\n10\n0\n20\n0\n11\n10\n21\n0\n0\nCIRCLE\n8\nHoles\n10\n0\n20\n0\n40\n2\n',
    ));
    expect(result.layerAci).toMatchObject({ Outline: 1, Holes: 5 });
    expect(result.entities[0].aci).toBe(256); // BYLAYER — it takes the layer's
    expect(result.entities[0].color).toBe(0xff0000);
    expect(result.entities[1].color).toBe(0x0000ff);
  });

  it('lets an entity colour override its layer', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxfWithTables(
      '0\nLAYER\n2\nOutline\n62\n1\n',
      '0\nLINE\n8\nOutline\n62\n3\n10\n0\n20\n0\n11\n10\n21\n0\n',
    ));
    expect(result.entities[0].aci).toBe(3);
    expect(result.entities[0].color).toBe(0x00ff00);
  });

  it('reads a layer that is switched off by its negative colour', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxfWithTables('0\nLAYER\n2\nHidden\n62\n-1\n', '0\nLINE\n8\nHidden\n10\n0\n20\n0\n11\n1\n21\n0\n'));
    expect(result.layerAci.Hidden).toBe(1); // off is a negative index; the colour is its absolute value
  });

  // The old import dropped the bulge, turning arcs into chords with no warning.
  it('expands a polyline bulge into the real arc and says it approximated it', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nLWPOLYLINE\n8\nA\n70\n0\n10\n1\n20\n0\n42\n1\n10\n-1\n20\n0\n'));
    const polyline = result.entities[0];
    expect(polyline.type).toBe('polyline');
    if (polyline.type !== 'polyline') return;
    expect(polyline.vertices.length).toBeGreaterThan(2);
    // Every vertex sits on the half circle of radius 1 about the origin.
    for (const vertex of polyline.vertices) expect(Math.hypot(vertex.x, vertex.y)).toBeCloseTo(1, 6);
    expect(result.approximated).toBe(1);
  });

  it('imports TEXT with its height and rotation', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nTEXT\n8\nA\n10\n1\n20\n2\n40\n3\n50\n90\n1\nHello\n'));
    expect(result.entities[0]).toMatchObject({ type: 'text', text: 'Hello', height: 3, position: { x: 1, y: 2 } });
    const text = result.entities[0];
    expect(text.type === 'text' && text.rotation).toBeCloseTo(Math.PI / 2);
  });

  it('strips MTEXT formatting down to plain text', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nMTEXT\n8\nA\n10\n0\n20\n0\n40\n2.5\n1\n{\\fArial|b1;Bold}\\Pline two\n'));
    expect(result.entities[0]).toMatchObject({ type: 'text', text: 'Bold line two' });
  });

  it('names what it skipped instead of only counting it', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf(
      '0\nINSERT\n8\nA\n2\nBLK\n10\n0\n20\n0\n'
      + '0\nHATCH\n8\nA\n10\n0\n20\n0\n'
      + '0\nINSERT\n8\nA\n2\nBLK\n10\n5\n20\n0\n',
    ));
    expect(result.ignored).toBe(3);
    expect(result.ignoredTypes).toEqual({ INSERT: 2, HATCH: 1 });
  });

  it('reports flattening a line that had a Z', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nLINE\n8\nA\n10\n0\n20\n0\n30\n5\n11\n10\n21\n0\n31\n5\n'));
    expect(result.entities).toHaveLength(1);
    expect(result.approximated).toBe(1);
  });

  it('leaves a flat drawing unapproximated', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nLINE\n8\nA\n10\n0\n20\n0\n11\n10\n21\n0\n'));
    expect(result.approximated).toBe(0);
    expect(result.ignored).toBe(0);
  });
});

describe('DXF SPLINE', () => {
  it('imports a single cubic segment as a bezier, with no loss', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf(
      '0\nSPLINE\n8\nA\n70\n8\n71\n3\n'
      + '40\n0\n40\n0\n40\n0\n40\n0\n40\n1\n40\n1\n40\n1\n40\n1\n'
      + '10\n0\n20\n0\n10\n1\n20\n3\n10\n4\n20\n3\n10\n5\n20\n0\n',
    ));
    expect(result.entities[0]).toMatchObject({
      type: 'bezier',
      start: { x: 0, y: 0 }, control1: { x: 1, y: 3 }, control2: { x: 4, y: 3 }, end: { x: 5, y: 0 },
    });
    expect(result.approximated).toBe(0);
  });

  it('samples a longer spline into a polyline and reports the approximation', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf(
      '0\nSPLINE\n8\nA\n70\n8\n71\n3\n'
      + '10\n0\n20\n0\n10\n1\n20\n4\n10\n3\n20\n-2\n10\n6\n20\n4\n10\n8\n20\n0\n10\n10\n20\n2\n',
    ));
    const entity = result.entities[0];
    expect(entity.type).toBe('polyline');
    if (entity.type !== 'polyline') return;
    expect(entity.vertices.length).toBeGreaterThan(10);
    expect(entity.vertices[0]).toMatchObject({ x: 0, y: 0 });
    expect(result.approximated).toBe(1);
  });

  it('skips a spline it cannot make sense of', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nSPLINE\n8\nA\n71\n3\n10\n0\n20\n0\n'));
    expect(result.entities).toHaveLength(0);
    expect(result.ignoredTypes).toEqual({ SPLINE: 1 });
  });
});

describe('DXF DIMENSION', () => {
  it('imports an aligned dimension from its extension line origins', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf(
      '0\nDIMENSION\n8\nDims\n70\n1\n10\n5\n20\n8\n11\n5\n21\n9\n13\n0\n23\n0\n14\n10\n24\n0\n42\n10\n',
    ));
    expect(result.entities[0]).toMatchObject({
      type: 'dimension', dimensionKind: 'aligned',
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, offset: { x: 5, y: 8 },
    });
    expect(result.approximated).toBe(0);
  });

  it('stores a radius dimension as centre → rim', () => {
    const doc = new Document();
    // 15/25 is the centre, 10/20 the arrow point on the arc.
    const result = importAsciiDxf(doc, dxf(
      '0\nDIMENSION\n8\nDims\n70\n4\n15\n0\n25\n0\n10\n10\n20\n0\n11\n6\n21\n3\n',
    ));
    expect(result.entities[0]).toMatchObject({
      type: 'dimension', dimensionKind: 'radius',
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, offset: { x: 6, y: 3 },
    });
  });

  it('derives the centre of a diameter dimension from its two chord ends', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf(
      '0\nDIMENSION\n8\nDims\n70\n3\n10\n10\n20\n0\n15\n-10\n25\n0\n11\n0\n21\n4\n',
    ));
    // Ends at ±10 → centre at the origin, radius 10, so it reads Ø20.
    expect(result.entities[0]).toMatchObject({
      type: 'dimension', dimensionKind: 'diameter',
      start: { x: 0, y: 0 }, end: { x: 10, y: 0 },
    });
  });

  it('keeps the dimension on the layer the file put it on', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nDIMENSION\n8\nMyDims\n70\n1\n10\n5\n20\n8\n13\n0\n23\n0\n14\n10\n24\n0\n'));
    expect(result.entities[0].layer).toBe('MyDims');
    expect(result.layers).toContain('MyDims');
  });

  // A rotated dimension measures the projection onto its own direction, which is
  // what the linear kind is for. It used to import as aligned and read 11.66.
  it('imports a rotated dimension exactly, reading what the file says it reads', () => {
    const doc = new Document();
    // Points 10 apart in x and 6 in y; the file states the measurement as 10.
    const result = importAsciiDxf(doc, dxf(
      '0\nDIMENSION\n8\nDims\n70\n0\n50\n0\n10\n5\n20\n-4\n13\n0\n23\n0\n14\n10\n24\n6\n42\n10\n',
    ));
    const dimension = result.entities[0];
    expect(dimension).toMatchObject({ type: 'dimension', dimensionKind: 'linear', rotation: 0 });
    if (dimension.type !== 'dimension') return;
    // Reads the leg the file measured, not the diagonal between the points.
    expect(dimensionGeometry(dimension).text).toBe('10.00');
    expect(result.approximated).toBe(0);
  });

  it('keeps an aligned dimension aligned', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf(
      '0\nDIMENSION\n8\nDims\n70\n1\n10\n5\n20\n8\n13\n0\n23\n0\n14\n3\n24\n4\n',
    ));
    const dimension = result.entities[0];
    expect(dimension).toMatchObject({ dimensionKind: 'aligned' });
    if (dimension.type !== 'dimension') return;
    expect(dimensionGeometry(dimension).text).toBe('5.00');
  });

  it('reports an overridden dimension text as lost', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf(
      '0\nDIMENSION\n8\nDims\n70\n1\n1\n25 TYP\n10\n5\n20\n8\n13\n0\n23\n0\n14\n10\n24\n0\n42\n10\n',
    ));
    expect(result.approximated).toBe(1);
  });

  it('skips angular and ordinate dimensions, which have no counterpart', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf(
      '0\nDIMENSION\n8\nD\n70\n2\n10\n0\n20\n0\n0\nDIMENSION\n8\nD\n70\n6\n10\n0\n20\n0\n',
    ));
    expect(result.entities).toHaveLength(0);
    expect(result.ignoredTypes).toEqual({ DIMENSION: 2 });
  });
});

describe('reading a file leaves the document alone', () => {
  // createDimension registers its style layer on the document, which would add a
  // "dims" layer the DXF never mentioned. Importing must only report layers.
  it('does not invent layers on the document', () => {
    const doc = new Document();
    const before = [...doc.layers];
    const result = importAsciiDxf(doc, dxf('0\nDIMENSION\n8\nMyDims\n70\n1\n10\n5\n20\n8\n13\n0\n23\n0\n14\n10\n24\n0\n'));
    expect(doc.layers).toEqual(before);
    expect(doc.layers).not.toContain('dims');
    // The layer the file did name is reported, for the caller to add.
    expect(result.layers).toContain('MyDims');
    expect(result.entities[0].layer).toBe('MyDims');
  });

  it('does not touch the document for an ordinary import either', () => {
    const doc = new Document();
    const before = { layers: [...doc.layers], colors: { ...doc.layerColors }, entities: doc.entities.length };
    importAsciiDxf(doc, dxf('0\nLINE\n8\nA\n10\n0\n20\n0\n11\n10\n21\n0\n'));
    expect(doc.layers).toEqual(before.layers);
    expect(doc.layerColors).toEqual(before.colors);
    expect(doc.entities).toHaveLength(before.entities);
  });
});

describe('DXF ELLIPSE', () => {
  // 11/21 is the major axis endpoint relative to the centre, 40 the minor/major ratio.
  it('imports an ellipse exactly, now that we have the entity for it', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nELLIPSE\n8\nA\n10\n5\n20\n3\n11\n10\n21\n0\n40\n0.4\n'));
    expect(result.entities[0]).toMatchObject({
      type: 'ellipse', center: { x: 5, y: 3 }, radiusX: 10, radiusY: 4, rotation: 0,
    });
    // An exact mapping, so nothing was approximated.
    expect(result.approximated).toBe(0);
    expect(result.ignored).toBe(0);
  });

  it('takes the rotation from the major axis vector', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nELLIPSE\n8\nA\n10\n0\n20\n0\n11\n0\n21\n6\n40\n0.5\n'));
    const ellipse = result.entities[0];
    expect(ellipse.type === 'ellipse' && ellipse.rotation).toBeCloseTo(Math.PI / 2);
    expect(ellipse.type === 'ellipse' && ellipse.radiusX).toBeCloseTo(6);
    expect(ellipse.type === 'ellipse' && ellipse.radiusY).toBeCloseTo(3);
  });

  it('skips a degenerate ellipse instead of importing a zero one', () => {
    const doc = new Document();
    const result = importAsciiDxf(doc, dxf('0\nELLIPSE\n8\nA\n10\n0\n20\n0\n11\n0\n21\n0\n40\n0.5\n'));
    expect(result.entities).toHaveLength(0);
    expect(result.ignoredTypes).toEqual({ ELLIPSE: 1 });
  });
});
