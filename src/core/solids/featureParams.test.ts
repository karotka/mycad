import { describe, expect, it } from 'vitest';
import type { ExtrusionFeature, PrimitiveFeature } from '../entities/types';
import { featureParams, primitiveParams, setFeatureParam, setPrimitiveParam } from './featureParams';

const feature = (over: Partial<PrimitiveFeature> = {}): PrimitiveFeature =>
  ({ kind: 'primitive', primitive: 'sphere', center: { x: 0, y: 0 }, radius: 5, height: 10, ...over });

const keys = (over: Partial<PrimitiveFeature>) => primitiveParams(feature(over)).map((param) => param.key);

describe('primitiveParams', () => {
  it('asks each primitive for what defines it', () => {
    expect(keys({ primitive: 'sphere' })).toEqual(['radius', 'scaleX', 'scaleY', 'scaleZ']);
    expect(keys({ primitive: 'box' })).toEqual(['width', 'depth', 'height', 'scaleX', 'scaleY', 'scaleZ']);
    expect(keys({ primitive: 'cylinder' })).toEqual(['radius', 'height', 'scaleX', 'scaleY', 'scaleZ']);
  });

  it('offers a torus its tube radius', () => {
    // The panel's own list never did, so half of a torus could not be reached
    // from the UI it was built for.
    expect(keys({ primitive: 'torus', tubeRadius: 2 })).toContain('tubeRadius');
  });

  it('does not ask a sphere for its height, which is twice its radius', () => {
    expect(keys({ primitive: 'sphere' })).not.toContain('height');
  });

  it('reports an unscaled primitive as scale one', () => {
    const scales = primitiveParams(feature()).filter((param) => param.key.startsWith('scale'));
    expect(scales.map((param) => param.value)).toEqual([1, 1, 1]);
  });
});

describe('setPrimitiveParam', () => {
  it('keeps a sphere spherical when its radius changes', () => {
    const sphere = feature();
    expect(setPrimitiveParam(sphere, 'radius', 8)).toBe(true);
    expect(sphere).toMatchObject({ radius: 8, height: 16 });
  });

  it('turns a sphere into an ellipsoid, which nothing else in the UI can', () => {
    const sphere = feature();
    expect(setPrimitiveParam(sphere, 'scaleZ', 0.25)).toBe(true);
    expect(sphere.scale).toEqual({ x: 1, y: 1, z: 0.25 });
    // Setting one axis leaves the others alone rather than resetting them.
    setPrimitiveParam(sphere, 'scaleX', 3);
    expect(sphere.scale).toEqual({ x: 3, y: 1, z: 0.25 });
  });

  it('refuses a key the primitive has no use for', () => {
    expect(setPrimitiveParam(feature({ primitive: 'sphere' }), 'width', 4)).toBe(false);
    expect(setPrimitiveParam(feature({ primitive: 'cylinder' }), 'tubeRadius', 4)).toBe(false);
    expect(setPrimitiveParam(feature(), 'x', 4)).toBe(false);
  });

  it('refuses a size that stops the shape being one', () => {
    const sphere = feature();
    expect(setPrimitiveParam(sphere, 'radius', 0)).toBe(false);
    expect(setPrimitiveParam(sphere, 'radius', -3)).toBe(false);
    expect(setPrimitiveParam(sphere, 'radius', Number.NaN)).toBe(false);
    expect(sphere.radius).toBe(5);
  });

  it('refuses a scale of zero, which flattens the solid out of existence', () => {
    const sphere = feature();
    expect(setPrimitiveParam(sphere, 'scaleY', 0)).toBe(false);
    // But a negative one only mirrors it, and that is a real shape.
    expect(setPrimitiveParam(sphere, 'scaleY', -1)).toBe(true);
  });
});

describe('extrusions', () => {
  const extrusion = (): ExtrusionFeature => ({
    kind: 'extrusion',
    profile: { id: 'p', type: 'circle', layer: '0', aci: 256, color: 0xffffff, selected: false, center: { x: 0, y: 0 }, radius: 5 },
    height: 10,
    transform: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
  });

  it('has values, which the tree showed it as having none of', () => {
    // Asking only about primitives made an extrusion — as parametric as
    // anything in the file — look like a dead end with a name.
    expect(featureParams(extrusion()).map((param) => param.key))
      .toEqual(['height', 'scaleX', 'scaleY', 'translateX', 'translateY', 'translateZ']);
  });

  it('reads a missing Z offset as no offset', () => {
    expect(featureParams(extrusion()).find((param) => param.key === 'translateZ')?.value).toBe(0);
  });

  it('sets what it is asked for and refuses the rest', () => {
    const feature = extrusion();
    expect(setFeatureParam(feature, 'height', 25)).toBe(true);
    expect(setFeatureParam(feature, 'translateZ', -4)).toBe(true);
    expect(setFeatureParam(feature, 'radius', 3)).toBe(false);
    expect(feature).toMatchObject({ height: 25, transform: { translateZ: -4 } });
  });

  it('refuses what leaves nothing to extrude', () => {
    const feature = extrusion();
    expect(setFeatureParam(feature, 'height', 0)).toBe(false);
    expect(setFeatureParam(feature, 'scaleX', 0)).toBe(false);
    // Moving to a negative coordinate is fine; a negative size is not.
    expect(setFeatureParam(feature, 'translateX', -12)).toBe(true);
  });
});

describe('featureParams', () => {
  it('gives a boolean nothing to type at, because it is its children', () => {
    expect(featureParams({ kind: 'boolean', operation: 'union', operands: [] })).toEqual([]);
    expect(featureParams({ kind: 'mesh' })).toEqual([]);
  });

  it('edits the radius of a fillet feature', () => {
    const edgeFeature = {
      kind: 'edge-modification' as const,
      operation: 'fillet' as const,
      source: { kind: 'mesh' as const },
      edge: {
        solidId: 'box', start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 1 },
        normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
      },
      amount: 2,
      sourceMesh: { positions: [], indices: [] },
    };
    expect(featureParams(edgeFeature)).toEqual([{ key: 'amount', label: 'Radius', value: 2, min: 1e-6 }]);
    expect(setFeatureParam(edgeFeature, 'amount', 3.5)).toBe(true);
    expect(edgeFeature.amount).toBe(3.5);
    expect(setFeatureParam(edgeFeature, 'amount', 0)).toBe(false);
  });

  it('edits both chamfer distances independently', () => {
    const edgeFeature = {
      kind: 'edge-modification' as const,
      operation: 'chamfer' as const,
      source: { kind: 'mesh' as const },
      edge: {
        solidId: 'box', start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 1 },
        normalA: { x: 1, y: 0, z: 0 }, normalB: { x: 0, y: 1, z: 0 },
      },
      amount: 2,
      amount2: 3,
      sourceMesh: { positions: [], indices: [] },
    };
    expect(featureParams(edgeFeature).map((parameter) => [parameter.key, parameter.value])).toEqual([
      ['amount', 2],
      ['amount2', 3],
    ]);
    expect(setFeatureParam(edgeFeature, 'amount2', 4.5)).toBe(true);
    expect(edgeFeature.amount2).toBe(4.5);
  });
});
