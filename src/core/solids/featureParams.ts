/**
 * What a feature is made of: the numbers that define it, and how to set them.
 *
 * One place, because there are two panels that ask — the properties panel and
 * the model tree — and the properties panel's own list had already fallen
 * behind the engine: it never offered a torus its tube radius, so half of that
 * primitive was unreachable from the UI it was built for.
 */
import type { ExtrusionFeature, PrimitiveFeature, SolidFeature } from '../entities/types';

export interface FeatureParam {
  key: string;
  label: string;
  value: number;
  /** Below this the shape stops being one, so the field refuses the change. */
  min: number;
}

/**
 * Empty for a feature with nothing to type at. A boolean is its children, and a
 * sweep is its profile and its path — both are shapes, not numbers, and picking
 * a different one is a different question than this answers.
 */
export function featureParams(feature: SolidFeature): FeatureParam[] {
  if (feature.kind === 'primitive') return primitiveParams(feature);
  if (feature.kind === 'extrusion') return extrusionParams(feature);
  if (feature.kind === 'edge-modification') return [{
    key: 'amount',
    label: feature.operation === 'fillet' ? 'Radius' : 'Distance',
    value: feature.amount,
    min: 1e-6,
  }];
  return [];
}

export function setFeatureParam(feature: SolidFeature, key: string, value: number): boolean {
  if (feature.kind === 'primitive') return setPrimitiveParam(feature, key, value);
  if (feature.kind === 'extrusion') return setExtrusionParam(feature, key, value);
  if (feature.kind === 'edge-modification' && key === 'amount' && Number.isFinite(value) && value >= 1e-6) {
    feature.amount = value;
    return true;
  }
  return false;
}

/**
 * An extrusion is its profile pushed through a height, having been moved and
 * stretched first — so those are its numbers. The tree showed it as a row with
 * nothing behind it, which made a perfectly parametric feature look like a
 * dead end.
 */
export function extrusionParams(feature: ExtrusionFeature): FeatureParam[] {
  return [
    { key: 'height', label: 'Height', value: feature.height, min: 1e-6 },
    { key: 'scaleX', label: 'Scale X', value: feature.transform.scaleX, min: -Infinity },
    { key: 'scaleY', label: 'Scale Y', value: feature.transform.scaleY, min: -Infinity },
    { key: 'translateX', label: 'Move X', value: feature.transform.translateX, min: -Infinity },
    { key: 'translateY', label: 'Move Y', value: feature.transform.translateY, min: -Infinity },
    { key: 'translateZ', label: 'Move Z', value: feature.transform.translateZ ?? 0, min: -Infinity },
  ];
}

export function setExtrusionParam(feature: ExtrusionFeature, key: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (key === 'height') {
    if (value < 1e-6) return false;
    feature.height = value;
    return true;
  }
  if (key === 'scaleX' || key === 'scaleY') {
    // A profile scaled to nothing has no area, so there is nothing to extrude.
    if (value === 0) return false;
    feature.transform[key] = value;
    return true;
  }
  if (key === 'translateX' || key === 'translateY' || key === 'translateZ') {
    feature.transform[key] = value;
    return true;
  }
  return false;
}

export function primitiveParams(feature: PrimitiveFeature): FeatureParam[] {
  const params: FeatureParam[] = [];
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
    case 'cone':
      // Zero is the point of a cone, so this one is allowed down to it — unlike
      // every other radius here, which stops being a shape at zero.
      params.push(radius, { key: 'radiusTop', label: 'Top radius', value: feature.radiusTop ?? 0, min: 0 }, height);
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
  if (key === 'radiusTop') { feature.radiusTop = value; return true; }
  if (key === 'radius') {
    feature.radius = value;
    if (feature.primitive === 'sphere') feature.height = value * 2;
    return true;
  }
  if (key === 'height') { feature.height = value; return true; }
  return false;
}
