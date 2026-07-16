/**
 * Moving, turning and resizing a solid without forgetting how it was made.
 *
 * SCALE and ROTATE both ended by replacing the feature with `{ kind: 'mesh' }`,
 * on the reasoning that a world-space transform cannot always be written into
 * the schema. That was true when it was written. It is not any more: a scale is
 * `PrimitiveFeature.scale`, which now exists, and a rotation is the work plane's
 * axes, which every feature has always carried. So the two commonest operations
 * in a CAD program stopped destroying the thing the whole engine is for.
 *
 * Null means the change genuinely cannot be written down — a mesh has no
 * history to keep, and a sweep is a profile and a path rather than numbers. The
 * caller bakes those, honestly, rather than this inventing something.
 */
import type { SolidFeature } from '../entities/types';
import type { Vec3 } from '../../math/geometry';
import { cloneWorkPlane, WORLD_WORK_PLANE, type WorkPlane } from '../../math/workplane';

const planeOf = (plane: WorkPlane | undefined): WorkPlane => cloneWorkPlane(plane ?? WORLD_WORK_PLANE);

/**
 * Uniformly, about a point. Every primitive is built in its plane's frame and
 * scaled about that plane's origin, so moving the origin the same way scales the
 * whole thing about `base`:
 *
 *   world' = base + f·(origin − base) + R·(f·scale·local)
 *          = base + f·(world − base)
 */
export function scaledFeature(feature: SolidFeature, base: Vec3, factor: number): SolidFeature | null {
  if (!Number.isFinite(factor) || factor === 0) return null;

  switch (feature.kind) {
    case 'boolean': {
      const operands = feature.operands.map((operand) => scaledFeature(operand, base, factor));
      // One operand that cannot be written down makes the whole tree a lie, so
      // the whole tree is baked rather than half of it.
      if (operands.some((operand) => operand === null)) return null;
      return { ...feature, operands: operands as SolidFeature[] };
    }
    case 'primitive': {
      const scale = feature.scale ?? { x: 1, y: 1, z: 1 };
      return {
        ...feature,
        scale: { x: scale.x * factor, y: scale.y * factor, z: scale.z * factor },
        workPlane: movedOrigin(planeOf(feature.workPlane), base, factor),
      };
    }
    case 'extrusion':
      return {
        ...feature,
        height: feature.height * factor,
        transform: {
          translateX: feature.transform.translateX * factor,
          translateY: feature.transform.translateY * factor,
          scaleX: feature.transform.scaleX * factor,
          scaleY: feature.transform.scaleY * factor,
          translateZ: (feature.transform.translateZ ?? 0) * factor,
        },
        workPlane: movedOrigin(planeOf(feature.workPlane), base, factor),
      };
    case 'sweep':
    case 'mesh':
      return null;
  }
}

/** About an axis: `angle` radians around `axis` through `origin`. */
export function rotatedFeature(feature: SolidFeature, origin: Vec3, axis: Vec3, angle: number): SolidFeature | null {
  if (!Number.isFinite(angle)) return null;
  const unit = normalize(axis);
  if (!unit) return null;

  switch (feature.kind) {
    case 'boolean': {
      const operands = feature.operands.map((operand) => rotatedFeature(operand, origin, unit, angle));
      if (operands.some((operand) => operand === null)) return null;
      return { ...feature, operands: operands as SolidFeature[] };
    }
    case 'primitive':
    case 'extrusion':
    case 'sweep': {
      // A rotation *is* the work plane turned: its origin swings about the axis
      // and its three axes turn in place. Nothing else in the feature moves,
      // because everything else is written in that frame.
      const plane = planeOf(feature.workPlane);
      return {
        ...feature,
        workPlane: {
          origin: turnPoint(plane.origin, origin, unit, angle),
          xAxis: turnDirection(plane.xAxis, unit, angle),
          yAxis: turnDirection(plane.yAxis, unit, angle),
          zAxis: turnDirection(plane.zAxis, unit, angle),
        },
      };
    }
    case 'mesh':
      return null;
  }
}

function movedOrigin(plane: WorkPlane, base: Vec3, factor: number): WorkPlane {
  return {
    ...plane,
    origin: {
      x: base.x + (plane.origin.x - base.x) * factor,
      y: base.y + (plane.origin.y - base.y) * factor,
      z: base.z + (plane.origin.z - base.z) * factor,
    },
  };
}

const turnPoint = (point: Vec3, origin: Vec3, axis: Vec3, angle: number): Vec3 => {
  const turned = turnDirection({ x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z }, axis, angle);
  return { x: origin.x + turned.x, y: origin.y + turned.y, z: origin.z + turned.z };
};

/** Rodrigues: v·cos + (axis × v)·sin + axis·(axis · v)·(1 − cos). */
function turnDirection(vector: Vec3, axis: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const dot = axis.x * vector.x + axis.y * vector.y + axis.z * vector.z;
  const cross = {
    x: axis.y * vector.z - axis.z * vector.y,
    y: axis.z * vector.x - axis.x * vector.z,
    z: axis.x * vector.y - axis.y * vector.x,
  };
  return {
    x: vector.x * cos + cross.x * sin + axis.x * dot * (1 - cos),
    y: vector.y * cos + cross.y * sin + axis.y * dot * (1 - cos),
    z: vector.z * cos + cross.z * sin + axis.z * dot * (1 - cos),
  };
}

function normalize(vector: Vec3): Vec3 | null {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length < 1e-12) return null;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}
