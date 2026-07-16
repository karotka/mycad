/**
 * What a primitive is made of: the numbers that define it, and how to set them.
 *
 * One place, because there are now two panels that ask — the properties panel
 * and the model tree — and the properties panel's own list had already fallen
 * behind the engine: it never offered a torus its tube radius, so half of that
 * primitive was unreachable from the UI it was built for.
 */
import type { PrimitiveFeature } from '../entities/types';

export interface PrimitiveParam {
  key: string;
  label: string;
  value: number;
  /** Below this the shape stops being one, so the field refuses the change. */
  min: number;
}

export function primitiveParams(feature: PrimitiveFeature): PrimitiveParam[] {
  const params: PrimitiveParam[] = [];
  const radius = { key: 'radius', label: 'Radius', value: feature.radius ?? 1, min: 1e-6 };
  const height = { key: 'height', label: 'Height', value: feature.height, min: 1e-6 };

  switch (feature.primitive) {
    case 'box':
    case 'wedge':
      params.push(
        { key: 'width', label: 'Width', value: feature.width ?? 1, min: 1e-6 },
        { key: 'depth', label: 'Depth', value: feature.depth ?? 1, min: 1e-6 },
        height,
      );
      break;
    case 'sphere':
      // Its height is twice its radius and follows it; asking for both would be
      // asking the same question twice and letting the answers disagree.
      params.push(radius);
      break;
    case 'torus':
      params.push(radius, { key: 'tubeRadius', label: 'Tube radius', value: feature.tubeRadius ?? 0.25, min: 1e-6 });
      break;
    default:
      params.push(radius, height);
  }

  // Always offered, because a scale of one is the shape unstretched — and this
  // is the only way to reach it: the primitives are all surfaces of revolution,
  // so without these three an ellipsoid can only be made from a script.
  const scale = feature.scale ?? { x: 1, y: 1, z: 1 };
  params.push(
    { key: 'scaleX', label: 'Scale X', value: scale.x, min: -Infinity },
    { key: 'scaleY', label: 'Scale Y', value: scale.y, min: -Infinity },
    { key: 'scaleZ', label: 'Scale Z', value: scale.z, min: -Infinity },
  );
  return params;
}

/** Mutates the feature. False means the key means nothing to this primitive. */
export function setPrimitiveParam(feature: PrimitiveFeature, key: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  const param = primitiveParams(feature).find((candidate) => candidate.key === key);
  if (!param || value < param.min) return false;

  if (key === 'scaleX' || key === 'scaleY' || key === 'scaleZ') {
    // A zero factor flattens the shape into nothing, which is not a solid and
    // which Manifold will not weld to anything.
    if (value === 0) return false;
    const scale = { ...(feature.scale ?? { x: 1, y: 1, z: 1 }) };
    scale[key === 'scaleX' ? 'x' : key === 'scaleY' ? 'y' : 'z'] = value;
    feature.scale = scale;
    return true;
  }
  if (key === 'width') { feature.width = value; return true; }
  if (key === 'depth') { feature.depth = value; return true; }
  if (key === 'tubeRadius') { feature.tubeRadius = value; return true; }
  if (key === 'radius') {
    feature.radius = value;
    if (feature.primitive === 'sphere') feature.height = value * 2;
    return true;
  }
  if (key === 'height') { feature.height = value; return true; }
  return false;
}
