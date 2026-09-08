import { describe, expect, it } from 'vitest';
import { Document } from '../../Document';
import { cornerClipMlines, cutMline, weldMlines } from './mlineEdit';
import type { MlineStyle } from '../../settings';

const twoElementStyle: MlineStyle = {
  id: 'test', name: 'TEST',
  elements: [{ offset: 0.5, aci: 256, linetype: 'Continuous' }, { offset: -0.5, aci: 256, linetype: 'Continuous' }],
  startCap: 'none', endCap: 'none',
};
const otherStyle: MlineStyle = {
  id: 'other', name: 'OTHER',
  elements: [{ offset: 1, aci: 1, linetype: 'Continuous' }],
  startCap: 'none', endCap: 'none',
};

describe('cutMline', () => {
  it('splits an open mline at the point nearest the cut, on whichever segment it falls', () => {
    const doc = new Document();
    const mline = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, twoElementStyle);
    const pieces = cutMline(mline, { x: 10, y: 5 });
    expect(pieces).not.toBeNull();
    const [head, tail] = pieces!;
    expect(head.vertices).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]);
    expect(tail.vertices).toEqual([{ x: 10, y: 5 }, { x: 10, y: 10 }]);
    expect(head.id).not.toBe(mline.id);
    expect(tail.id).not.toBe(head.id);
    expect(head.elements).toEqual(mline.elements);
  });

  it('refuses a closed mline — there is no natural head/tail to split', () => {
    const doc = new Document();
    const mline = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], true, twoElementStyle);
    expect(cutMline(mline, { x: 10, y: 5 })).toBeNull();
  });

  it('refuses a cut essentially on top of an existing end', () => {
    const doc = new Document();
    const mline = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle);
    expect(cutMline(mline, { x: 0, y: 0 })).toBeNull();
    expect(cutMline(mline, { x: 10, y: 0 })).toBeNull();
  });
});

describe('weldMlines', () => {
  it('joins two mlines that share an endpoint, in order', () => {
    const doc = new Document();
    const a = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle);
    const b = doc.createMline([{ x: 10, y: 0 }, { x: 20, y: 0 }], false, twoElementStyle);
    const welded = weldMlines(a, b);
    expect(welded).not.toBeNull();
    expect(welded!.vertices).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
    expect(welded!.closed).toBe(false);
  });

  it('reverses whichever piece needs it to line up start-to-end', () => {
    const doc = new Document();
    const a = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle);
    const b = doc.createMline([{ x: 20, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle); // drawn the other way
    const welded = weldMlines(a, b);
    expect(welded!.vertices).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
  });

  it('closes the loop when welding brings both free ends back together', () => {
    const doc = new Document();
    const a = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, twoElementStyle);
    const b = doc.createMline([{ x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }], false, twoElementStyle);
    const welded = weldMlines(a, b);
    expect(welded!.closed).toBe(true);
    expect(welded!.vertices[0]).toEqual(welded!.vertices.at(-1));
  });

  it('refuses two mlines with a different number of style elements', () => {
    const doc = new Document();
    const a = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle);
    const b = doc.createMline([{ x: 10, y: 0 }, { x: 20, y: 0 }], false, otherStyle);
    expect(weldMlines(a, b)).toBeNull();
  });

  it('refuses two mlines that do not share an endpoint', () => {
    const doc = new Document();
    const a = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle);
    const b = doc.createMline([{ x: 100, y: 100 }, { x: 200, y: 100 }], false, twoElementStyle);
    expect(weldMlines(a, b)).toBeNull();
  });
});

describe('cornerClipMlines', () => {
  it('trims both open mlines back to where their centerlines cross, keeping the side each pick fell on', () => {
    const doc = new Document();
    const a = doc.createMline([{ x: 0, y: 5 }, { x: 20, y: 5 }], false, twoElementStyle);
    const b = doc.createMline([{ x: 10, y: 0 }, { x: 10, y: 20 }], false, twoElementStyle);
    const result = cornerClipMlines(a, { x: 2, y: 5 }, b, { x: 10, y: 2 });
    expect(result).not.toBeNull();
    const [newA, newB] = result!;
    expect(newA.vertices).toEqual([{ x: 0, y: 5 }, { x: 10, y: 5 }]);
    expect(newB.vertices).toEqual([{ x: 10, y: 0 }, { x: 10, y: 5 }]);
  });

  it('refuses two mlines that never cross', () => {
    const doc = new Document();
    const a = doc.createMline([{ x: 0, y: 0 }, { x: 10, y: 0 }], false, twoElementStyle);
    const b = doc.createMline([{ x: 0, y: 5 }, { x: 10, y: 5 }], false, twoElementStyle); // parallel
    expect(cornerClipMlines(a, { x: 2, y: 0 }, b, { x: 2, y: 5 })).toBeNull();
  });

  it('refuses a closed mline', () => {
    const doc = new Document();
    const a = doc.createMline([{ x: 0, y: 5 }, { x: 20, y: 5 }, { x: 20, y: 20 }], true, twoElementStyle);
    const b = doc.createMline([{ x: 10, y: 0 }, { x: 10, y: 20 }], false, twoElementStyle);
    expect(cornerClipMlines(a, { x: 2, y: 5 }, b, { x: 10, y: 2 })).toBeNull();
  });
});
