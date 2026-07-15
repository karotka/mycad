import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { chooseObjectId, closestProjectedIndex } from './ViewportPicking';

describe('3D picking order', () => {
  it('prefers the first non-excluded object behind an excluded hit', () => {
    const front = new THREE.Object3D(), back = new THREE.Object3D();
    const objects = new Map([['front', front], ['back', back]]);
    expect(chooseObjectId([front, back], objects, new Set(['front']))).toBe('back');
  });

  it('falls back to the front object when every hit is excluded', () => {
    const front = new THREE.Object3D(), back = new THREE.Object3D();
    const objects = new Map([['front', front], ['back', back]]);
    expect(chooseObjectId([front, back], objects, new Set(['front', 'back']))).toBe('front');
  });

  it('chooses the closest visible projected grip inside tolerance', () => {
    expect(closestProjectedIndex(
      { x: 10, y: 10 },
      [{ x: 14, y: 10, z: 0, index: 1 }, { x: 11, y: 10, z: 0, index: 2 }, { x: 10, y: 10, z: 2, index: 3 }],
      8,
    )).toBe(2);
  });
});
