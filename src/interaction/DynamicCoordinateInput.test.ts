import { describe, expect, it } from 'vitest';
import { dynamicCoordinatePoint } from './DynamicCoordinateInput';

describe('dynamicCoordinatePoint', () => {
  it('follows the live cursor with no typed override', () => {
    expect(dynamicCoordinatePoint({ x: 3, y: -4 }, { x: '', y: '' })).toEqual({ x: 3, y: -4 });
  });

  it('overrides just the typed axis, leaving the other to the cursor', () => {
    expect(dynamicCoordinatePoint({ x: 3, y: -4 }, { x: '10', y: '' })).toEqual({ x: 10, y: -4 });
    expect(dynamicCoordinatePoint({ x: 3, y: -4 }, { x: '', y: '20' })).toEqual({ x: 3, y: 20 });
  });

  it('accepts a negative typed coordinate as-is — there is no fixed point for a sign to be relative to', () => {
    expect(dynamicCoordinatePoint({ x: 3, y: -4 }, { x: '-10', y: '' })).toEqual({ x: -10, y: -4 });
  });

  it('fixes both axes when both are typed, ignoring the cursor entirely', () => {
    expect(dynamicCoordinatePoint({ x: 3, y: -4 }, { x: '1', y: '2' })).toEqual({ x: 1, y: 2 });
  });

  it('ignores unparsable text and falls back to the live cursor', () => {
    expect(dynamicCoordinatePoint({ x: 3, y: -4 }, { x: 'abc', y: '  ' })).toEqual({ x: 3, y: -4 });
  });
});
