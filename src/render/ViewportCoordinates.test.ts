import { describe, expect, it } from 'vitest';
import { cadToThree, standardViewDelta, threeToCad } from './ViewportCoordinates';

describe('viewport coordinate conversion', () => {
  it('round-trips CAD and Three.js axes', () => {
    expect(threeToCad(cadToThree({ x: 2, y: 3, z: 4 }))).toEqual({ x: 2, y: 3, z: 4 });
  });

  it('maps screen motion to the visible axes of standard views', () => {
    expect(standardViewDelta({ x: 5, y: -2 }, 'top')).toEqual({ x: 5, y: -2, z: 0 });
    expect(standardViewDelta({ x: 5, y: -2 }, 'front')).toEqual({ x: 5, y: 0, z: -2 });
    expect(standardViewDelta({ x: 5, y: -2 }, 'left')).toEqual({ x: 0, y: -5, z: -2 });
  });
});
