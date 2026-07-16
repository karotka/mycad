import { describe, expect, it } from 'vitest';
import type { PrimitiveFeature, SolidFeature } from '../core/entities/types';
import { featureAt, featureLabel, featureRows } from './modelTree';

const sphere = (radius: number, scale?: { x: number; y: number; z: number }): PrimitiveFeature =>
  ({ kind: 'primitive', primitive: 'sphere', center: { x: 0, y: 0 }, radius, height: radius * 2, scale });

const elephant: SolidFeature = {
  kind: 'boolean', operation: 'subtract',
  operands: [
    { kind: 'boolean', operation: 'union', operands: [sphere(10), sphere(4, { x: 3, y: 1, z: 0.5 })] },
    sphere(2),
  ],
};

describe('featureRows', () => {
  it('walks the tree parents first, which is the order it is drawn in', () => {
    const rows = featureRows(elephant);
    expect(rows.map((row) => `${'  '.repeat(row.depth)}${row.label}`)).toEqual([
      'Subtract',
      '  Union',
      '    Sphere',
      '    Sphere',
      '  Sphere',
    ]);
  });

  it('gives each row the path back to its feature', () => {
    const rows = featureRows(elephant);
    expect(rows.map((row) => row.path)).toEqual([[], [0], [0, 0], [0, 1], [1]]);
  });

  it('folds a collapsed branch away without losing what follows it', () => {
    const rows = featureRows(elephant, new Set(['0']));
    // The union closes up, but the subtraction's other operand is still there.
    expect(rows.map((row) => row.label)).toEqual(['Subtract', 'Union', 'Sphere']);
    expect(rows[2].path).toEqual([1]);
  });

  it('says a boolean has children and a primitive does not', () => {
    const rows = featureRows(elephant);
    expect(rows.map((row) => row.hasChildren)).toEqual([true, true, false, false, false]);
  });
});

describe('featureLabel', () => {
  it('shows a scale, because two spheres of one radius can be different shapes', () => {
    expect(featureLabel(sphere(4, { x: 3, y: 1, z: 0.5 }))).toEqual({ label: 'Sphere', detail: 'r 4 · 3:1:0.5' });
    expect(featureLabel(sphere(4))).toEqual({ label: 'Sphere', detail: 'r 4' });
    // A scale of one is the shape unstretched, so it says nothing.
    expect(featureLabel(sphere(4, { x: 1, y: 1, z: 1 })).detail).toBe('r 4');
  });

  it('counts what a boolean is made of', () => {
    expect(featureLabel(elephant)).toEqual({ label: 'Subtract', detail: '2 parts' });
  });
});

describe('featureAt', () => {
  it('finds the feature a row points at', () => {
    expect(featureAt(elephant, [0, 1])).toMatchObject({ primitive: 'sphere', radius: 4 });
    expect(featureAt(elephant, [])).toBe(elephant);
  });

  it('returns null rather than guess when the path leads nowhere', () => {
    // The tree can change under a row that is still on screen.
    expect(featureAt(elephant, [0, 9])).toBeNull();
    expect(featureAt(elephant, [1, 0])).toBeNull(); // a primitive has no operands
  });
});
