import { describe, expect, it } from 'vitest';
import { dropTarget, reorderLayers } from './layerOrder';

describe('reorderLayers', () => {
  const layers = ['outline', 'pocket', 'holes'];

  it('drops a layer in front of another', () => {
    expect(reorderLayers(layers, 'holes', 'pocket')).toEqual(['outline', 'holes', 'pocket']);
    expect(reorderLayers(layers, 'outline', 'holes')).toEqual(['pocket', 'outline', 'holes']);
  });

  it('drops a layer at the end', () => {
    expect(reorderLayers(layers, 'outline', null)).toEqual(['pocket', 'holes', 'outline']);
  });

  it('changes nothing when the move asks for nothing', () => {
    expect(reorderLayers(layers, 'pocket', 'pocket')).toEqual(layers);
    // Already in front of holes, so this is a drop back where it started.
    expect(reorderLayers(layers, 'pocket', 'holes')).toEqual(layers);
    expect(reorderLayers(layers, 'holes', null)).toEqual(layers);
  });

  it('leaves the order alone when asked about a layer that is not there', () => {
    expect(reorderLayers(layers, 'ghost', 'pocket')).toEqual(layers);
    expect(reorderLayers(layers, 'pocket', 'ghost')).toEqual(layers);
  });

  it('does not mutate the layers it was given', () => {
    const original = [...layers];
    reorderLayers(layers, 'holes', 'outline');
    expect(layers).toEqual(original);
  });
});

describe('dropTarget', () => {
  const rows = [
    { name: 'outline', top: 0, bottom: 30 },
    { name: 'pocket', top: 30, bottom: 60 },
  ];

  it('picks the row whose top half the pointer is in', () => {
    expect(dropTarget(rows, 5)).toBe('outline');
    expect(dropTarget(rows, 35)).toBe('pocket');
  });

  it('picks the next row once past the midpoint', () => {
    // Below outline's middle means after outline, which is in front of pocket.
    expect(dropTarget(rows, 20)).toBe('pocket');
  });

  it('means the end when the pointer is past the last row', () => {
    expect(dropTarget(rows, 55)).toBeNull();
    expect(dropTarget(rows, 200)).toBeNull();
  });
});
