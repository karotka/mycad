import { describe, expect, it } from 'vitest';
import { dynamicRectangleAxisCoordinate, dynamicRectangleBoxPoints, dynamicRectangleCorner } from './DynamicRectangleInput';

describe('dynamicRectangleAxisCoordinate', () => {
  it('follows the live cursor with no typed override', () => {
    expect(dynamicRectangleAxisCoordinate(10, 16, '')).toBe(16);
  });

  it('fixes the axis at the typed magnitude, on the cursor\'s side of the fixed value', () => {
    expect(dynamicRectangleAxisCoordinate(10, 16, '20')).toBe(30); // cursor is above fixed: +20
    expect(dynamicRectangleAxisCoordinate(10, 4, '20')).toBe(-10); // cursor is below fixed: -20
  });
});

describe('dynamicRectangleCorner', () => {
  it('follows the live cursor when neither field has been typed into', () => {
    const corner = dynamicRectangleCorner({ x: 0, y: 0 }, { x: 12, y: -7 }, { width: '', height: '' });
    expect(corner).toEqual({ x: 12, y: -7 });
  });

  it('overrides just the typed axis, leaving the other to the cursor', () => {
    const corner = dynamicRectangleCorner({ x: 0, y: 0 }, { x: 12, y: -7 }, { width: '20', height: '' });
    expect(corner).toEqual({ x: 20, y: -7 });
  });

  it('keeps the drag direction the mouse already set instead of the typed sign', () => {
    // Dragging up-left (negative x, negative y); typing a plain positive
    // magnitude must not flip the rectangle onto the other side of the start.
    const corner = dynamicRectangleCorner({ x: 10, y: 10 }, { x: 4, y: 3 }, { width: '20', height: '15' });
    expect(corner).toEqual({ x: -10, y: -5 });
  });

  it('ignores unparsable text and falls back to the live cursor', () => {
    const corner = dynamicRectangleCorner({ x: 0, y: 0 }, { x: 5, y: 5 }, { width: 'abc', height: '  ' });
    expect(corner).toEqual({ x: 5, y: 5 });
  });

  it('treats an explicit minus sign as just another magnitude, not a flip', () => {
    const corner = dynamicRectangleCorner({ x: 0, y: 0 }, { x: 5, y: 5 }, { width: '-8', height: '' });
    expect(corner).toEqual({ x: 8, y: 5 });
  });
});

describe('dynamicRectangleBoxPoints', () => {
  it('places the width box on the horizontal side and the height box on the vertical side', () => {
    const points = dynamicRectangleBoxPoints({ x: 0, y: 0 }, { x: 10, y: 4 });
    expect(points.width).toEqual({ x: 5, y: 0 });
    expect(points.height).toEqual({ x: 10, y: 2 });
  });

  it('follows the corner into any quadrant', () => {
    const points = dynamicRectangleBoxPoints({ x: 2, y: 3 }, { x: -6, y: -5 });
    expect(points.width).toEqual({ x: -2, y: 3 });
    expect(points.height).toEqual({ x: -6, y: -1 });
  });
});
