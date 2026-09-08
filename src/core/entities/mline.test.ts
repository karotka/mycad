import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { mlineOffsetLines } from './mline';
import { dist2 } from '../../math/geometry';
import type { MlineStyle } from '../settings';

const twoElementStyle: MlineStyle = {
  id: 'test', name: 'TEST',
  elements: [{ offset: 0.5, aci: 256, linetype: 'Continuous' }, { offset: -0.5, aci: 256, linetype: 'Continuous' }],
  startCap: 'none', endCap: 'none',
};

describe('mlineOffsetLines', () => {
  it('offsets a straight open centerline into two parallel lines at the element distances', () => {
    const doc = new Document();
    const mline = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle);
    const [first, second] = mlineOffsetLines(mline);
    expect(first).toEqual([{ x: 0, y: 0.5 }, { x: 10, y: 0.5 }]);
    expect(second).toEqual([{ x: 0, y: -0.5 }, { x: 10, y: -0.5 }]);
  });

  it('miters a right-angle open centerline the same way OFFSET does', () => {
    const doc = new Document();
    // A right-angle corner: along +X, then up +Y.
    const mline = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, twoElementStyle);
    const [first] = mlineOffsetLines(mline);
    // The corner point (index 1) sits on a 45-degree miter, distance
    // offset*sqrt(2) from the original vertex. dist2() here is plain
    // Euclidean distance, per math/geometry.ts, despite the name.
    expect(dist2(first[1], { x: 10, y: 0 })).toBeCloseTo(0.5 * Math.SQRT2, 6);
  });

  it('closes a closed centerline into closed offset loops, one per element', () => {
    const doc = new Document();
    const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const mline = doc.createMline(square, true, twoElementStyle);
    const lines = mlineOffsetLines(mline);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.at(-1)).toEqual(line[0]); // closing duplicate, same as a closed polyline
      expect(dist2(line[0], square[0])).toBeCloseTo(0.5 * Math.SQRT2, 6);
    }
  });

  it('lines up the top element with the drawn points under top justification', () => {
    const doc = new Document();
    const mline = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle, 'top');
    const [top, bottom] = mlineOffsetLines(mline);
    expect(top).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]); // offset 0.5 (the largest) lands exactly on the centerline
    expect(bottom).toEqual([{ x: 0, y: -1 }, { x: 10, y: -1 }]); // offset -0.5, one full style width below
  });

  it('lines up the bottom element with the drawn points under bottom justification', () => {
    const doc = new Document();
    const mline = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle, 'bottom');
    const [top, bottom] = mlineOffsetLines(mline);
    expect(top).toEqual([{ x: 0, y: 1 }, { x: 10, y: 1 }]);
    expect(bottom).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]); // offset -0.5 (the smallest) lands exactly on the centerline
  });

  it('falls back to the centerline itself for a degenerate one-point mline rather than throwing', () => {
    const doc = new Document();
    const mline = doc.createMline([{ x: 3, y: 4 }], false, twoElementStyle);
    for (const line of mlineOffsetLines(mline)) expect(line).toEqual([{ x: 3, y: 4 }]);
  });
});
