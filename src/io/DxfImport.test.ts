import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { importAsciiDxf } from './DxfImport';

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
