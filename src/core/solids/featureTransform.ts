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
import { cloneEntity, transformEntityPoints, type Entity, type SerializedSolidMesh, type SolidEdgeSelection, type SolidFaceRegion, type SolidFeature } from '../entities/types';
import { mirrorPoint2, type Vec2, type Vec3 } from '../../math/geometry';
import { cloneWorkPlane, localToWorld, WORLD_WORK_PLANE, worldToLocal, type WorkPlane } from '../../math/workplane';

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
    case 'presspull-region': {
      const magnitude = Math.abs(factor);
      const direction = factor < 0 ? -1 : 1;
      return {
        ...feature,
        source: scaledFeature(feature.source, base, factor) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, (point) => scaledPoint(point, base, factor), factor < 0),
        region: {
          plane: {
            origin: scaledPoint(feature.region.plane.origin, base, factor),
            xAxis: scaleDirection(feature.region.plane.xAxis, direction),
            yAxis: scaleDirection(feature.region.plane.yAxis, direction),
            zAxis: scaleDirection(feature.region.plane.zAxis, direction),
          },
          loops: feature.region.loops.map((loop) => loop.map((point) => ({ x: point.x * magnitude, y: point.y * magnitude }))),
        },
        distance: feature.distance * magnitude,
      };
    }
    case 'edge-modification': {
      const directionFactor = factor < 0 ? -1 : 1;
      return {
        ...feature,
        source: scaledFeature(feature.source, base, factor) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, (point) => scaledPoint(point, base, factor), factor < 0),
        edge: transformedEdge(
          feature.edge,
          (point) => scaledPoint(point, base, factor),
          (normal) => ({ x: normal.x * directionFactor, y: normal.y * directionFactor, z: normal.z * directionFactor }),
          Math.abs(factor),
        ),
        amount: feature.amount * Math.abs(factor),
        amount2: feature.amount2 === undefined ? undefined : feature.amount2 * Math.abs(factor),
      };
    }
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
        direction: feature.direction ? {
          x: feature.direction.x * factor,
          y: feature.direction.y * factor,
          z: feature.direction.z * factor,
        } : undefined,
        transform: {
          translateX: feature.transform.translateX * factor,
          translateY: feature.transform.translateY * factor,
          scaleX: feature.transform.scaleX * factor,
          scaleY: feature.transform.scaleY * factor,
          translateZ: (feature.transform.translateZ ?? 0) * factor,
        },
        workPlane: movedOrigin(planeOf(feature.workPlane), base, factor),
      };
    case 'shell':
      return {
        ...feature,
        source: scaledFeature(feature.source, base, factor) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, (point) => scaledPoint(point, base, factor), factor < 0),
        thickness: feature.thickness * Math.abs(factor),
      };
    // Same shape as shell above, except the distance keeps its sign: which
    // side of the surface the offset sits on is part of the feature, and a
    // scale must not flip it.
    case 'surface-offset':
      return {
        ...feature,
        source: scaledFeature(feature.source, base, factor) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, (point) => scaledPoint(point, base, factor), factor < 0),
        distance: feature.distance * Math.abs(factor),
      };
    // A draft angle is a pure angle — uniform scaling never changes it, so
    // unlike shell's thickness there is no scalar here to carry along. The
    // neutral plane's origin/normal do move, the same way presspull-region's
    // own plane does just above.
    case 'draft': {
      const scaleFlip = factor < 0 ? -1 : 1;
      return {
        ...feature,
        source: scaledFeature(feature.source, base, factor) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, (point) => scaledPoint(point, base, factor), factor < 0),
        neutralPlane: {
          origin: scaledPoint(feature.neutralPlane.origin, base, factor),
          normal: scaleDirection(feature.neutralPlane.normal, scaleFlip),
        },
      };
    }
    case 'sweep':
      return null;
    // A loft has no single work plane of its own — each profile/guide is its
    // own embedded Entity value (LoftFeature.profiles/guides), each with its
    // own work plane — but that's no different in kind from a boolean's
    // several operands above: scale every one of them the same way, about
    // the same world `base`. See scaleEmbeddedLoftEntity's own comment for
    // the derivation of why moving the plane's origin (movedOrigin, exactly
    // as primitive/extrusion do above) plus scaling the entity's own local
    // points about its OWN local origin (not `base` re-expressed locally)
    // is the correct split, not an approximation of one.
    case 'loft': {
      const scaleEmbedded = (entity: Entity): Entity => scaleEmbeddedLoftEntity(entity, base, factor);
      return {
        ...feature,
        profiles: feature.profiles.map(scaleEmbedded),
        guides: feature.guides?.map(scaleEmbedded),
        path: feature.path ? scaleEmbedded(feature.path) : undefined,
      };
    }
    case 'mesh':
      return null;
  }
}

/**
 * Moved. Every feature can say where it is — a primitive and a sweep in their
 * work plane's origin, an extrusion in its transform, a boolean in each of its
 * parts — so this is the one transform that never has to bake anything but a
 * bare mesh.
 */
export function translatedFeature(feature: SolidFeature, delta: Vec3): SolidFeature | null {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y) || !Number.isFinite(delta.z)) return null;

  switch (feature.kind) {
    case 'presspull-region': {
      const move = (point: Vec3): Vec3 => ({ x: point.x + delta.x, y: point.y + delta.y, z: point.z + delta.z });
      return {
        ...feature,
        source: translatedFeature(feature.source, delta) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, move),
        region: transformedRegion(feature.region, (plane) => ({ ...plane, origin: move(plane.origin) })),
      };
    }
    case 'edge-modification': {
      const move = (point: Vec3): Vec3 => ({ x: point.x + delta.x, y: point.y + delta.y, z: point.z + delta.z });
      return {
        ...feature,
        source: translatedFeature(feature.source, delta) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, move),
        edge: transformedEdge(feature.edge, move, (normal) => ({ ...normal })),
      };
    }
    case 'boolean': {
      const operands = feature.operands.map((operand) => translatedFeature(operand, delta));
      if (operands.some((operand) => operand === null)) return null;
      return { ...feature, operands: operands as SolidFeature[] };
    }
    case 'shell':
    case 'surface-offset': {
      const move = (point: Vec3): Vec3 => ({ x: point.x + delta.x, y: point.y + delta.y, z: point.z + delta.z });
      return {
        ...feature,
        source: translatedFeature(feature.source, delta) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, move),
      };
    }
    case 'draft': {
      const move = (point: Vec3): Vec3 => ({ x: point.x + delta.x, y: point.y + delta.y, z: point.z + delta.z });
      return {
        ...feature,
        source: translatedFeature(feature.source, delta) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, move),
        neutralPlane: { origin: move(feature.neutralPlane.origin), normal: feature.neutralPlane.normal },
      };
    }
    // An extrusion goes through its plane too, not through its transform: the
    // transform moves the *profile*, in the plane's own coordinates, so adding a
    // world delta to it is only right when the plane happens to be the world's.
    // Draw on a moved UCS and it goes somewhere else entirely.
    case 'extrusion':
    case 'primitive':
    case 'sweep': {
      const plane = planeOf(feature.workPlane);
      return {
        ...feature,
        workPlane: {
          ...plane,
          origin: { x: plane.origin.x + delta.x, y: plane.origin.y + delta.y, z: plane.origin.z + delta.z },
        },
      };
    }
    // A loft's own boundary is several embedded entities, each with its own
    // work plane — move every one of them by the same world delta, the same
    // trick as extrusion/primitive/sweep just above applied per-entity.
    case 'loft': {
      const moveEmbedded = (entity: Entity): Entity => translatedEmbeddedLoftEntity(entity, delta);
      return {
        ...feature,
        profiles: feature.profiles.map(moveEmbedded),
        guides: feature.guides?.map(moveEmbedded),
        path: feature.path ? moveEmbedded(feature.path) : undefined,
      };
    }
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
    case 'presspull-region': {
      const turn = (point: Vec3): Vec3 => turnPoint(point, origin, unit, angle);
      const turnPlane = (plane: WorkPlane): WorkPlane => ({
        origin: turn(plane.origin),
        xAxis: turnDirection(plane.xAxis, unit, angle),
        yAxis: turnDirection(plane.yAxis, unit, angle),
        zAxis: turnDirection(plane.zAxis, unit, angle),
      });
      return {
        ...feature,
        source: rotatedFeature(feature.source, origin, unit, angle) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, turn),
        region: transformedRegion(feature.region, turnPlane),
      };
    }
    case 'edge-modification': {
      const turn = (point: Vec3): Vec3 => turnPoint(point, origin, unit, angle);
      const turnNormal = (normal: Vec3): Vec3 => turnDirection(normal, unit, angle);
      return {
        ...feature,
        source: rotatedFeature(feature.source, origin, unit, angle) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, turn),
        edge: transformedEdge(feature.edge, turn, turnNormal),
      };
    }
    case 'boolean': {
      const operands = feature.operands.map((operand) => rotatedFeature(operand, origin, unit, angle));
      if (operands.some((operand) => operand === null)) return null;
      return { ...feature, operands: operands as SolidFeature[] };
    }
    case 'shell':
    case 'surface-offset': {
      const turn = (point: Vec3): Vec3 => turnPoint(point, origin, unit, angle);
      return {
        ...feature,
        source: rotatedFeature(feature.source, origin, unit, angle) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, turn),
      };
    }
    case 'draft': {
      const turn = (point: Vec3): Vec3 => turnPoint(point, origin, unit, angle);
      return {
        ...feature,
        source: rotatedFeature(feature.source, origin, unit, angle) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, turn),
        neutralPlane: { origin: turn(feature.neutralPlane.origin), normal: turnDirection(feature.neutralPlane.normal, unit, angle) },
      };
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
    // Same trick as primitive/extrusion/sweep above, per embedded entity: a
    // rotation is only ever the plane turned (origin swung about the axis,
    // its three axes turned in place) — local points never move, because
    // they stay expressed in that same, now-turned, frame.
    case 'loft': {
      const turnEmbedded = (entity: Entity): Entity => rotatedEmbeddedLoftEntity(entity, origin, unit, angle);
      return {
        ...feature,
        profiles: feature.profiles.map(turnEmbedded),
        guides: feature.guides?.map(turnEmbedded),
        path: feature.path ? turnEmbedded(feature.path) : undefined,
      };
    }
    case 'mesh':
      return null;
  }
}

/** Mirrors a feature across an axis drawn in `mirrorPlane`, preserving its recipe. */
export function mirroredFeature(feature: SolidFeature, mirrorPlane: WorkPlane, axisStart: Vec2, axisEnd: Vec2): SolidFeature | null {
  const reflectPoint = (point: Vec3): Vec3 => {
    const local = worldToLocal(mirrorPlane, point);
    const reflected = mirrorPoint2(local, axisStart, axisEnd);
    return localToWorld(mirrorPlane, reflected, local.z);
  };
  const mirrorOrigin = mirrorPlane.origin;
  const reflectDirection = (direction: Vec3): Vec3 => {
    const reflectedOrigin = reflectPoint(mirrorOrigin);
    const reflectedEnd = reflectPoint({
      x: mirrorOrigin.x + direction.x,
      y: mirrorOrigin.y + direction.y,
      z: mirrorOrigin.z + direction.z,
    });
    return {
      x: reflectedEnd.x - reflectedOrigin.x,
      y: reflectedEnd.y - reflectedOrigin.y,
      z: reflectedEnd.z - reflectedOrigin.z,
    };
  };

  switch (feature.kind) {
    case 'presspull-region':
      return {
        ...feature,
        source: mirroredFeature(feature.source, mirrorPlane, axisStart, axisEnd) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, reflectPoint, true),
        region: transformedRegion(feature.region, (plane) => ({
          origin: reflectPoint(plane.origin),
          xAxis: reflectDirection(plane.xAxis),
          yAxis: reflectDirection(plane.yAxis),
          zAxis: reflectDirection(plane.zAxis),
        })),
      };
    case 'edge-modification':
      return {
        ...feature,
        source: mirroredFeature(feature.source, mirrorPlane, axisStart, axisEnd) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, reflectPoint, true),
        edge: transformedEdge(feature.edge, reflectPoint, reflectDirection),
      };
    case 'shell':
    case 'surface-offset':
      return {
        ...feature,
        source: mirroredFeature(feature.source, mirrorPlane, axisStart, axisEnd) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, reflectPoint, true),
      };
    case 'draft':
      return {
        ...feature,
        source: mirroredFeature(feature.source, mirrorPlane, axisStart, axisEnd) ?? { kind: 'mesh' },
        sourceMesh: transformedMesh(feature.sourceMesh, reflectPoint, true),
        neutralPlane: { origin: reflectPoint(feature.neutralPlane.origin), normal: reflectDirection(feature.neutralPlane.normal) },
      };
    case 'boolean': {
      const operands = feature.operands.map((operand) => mirroredFeature(operand, mirrorPlane, axisStart, axisEnd));
      if (operands.some((operand) => operand === null)) return null;
      return { ...feature, operands: operands as SolidFeature[] };
    }
    case 'primitive':
    case 'extrusion': {
      const plane = planeOf(feature.workPlane);
      return {
        ...feature,
        workPlane: {
          origin: reflectPoint(plane.origin),
          xAxis: reflectDirection(plane.xAxis),
          yAxis: reflectDirection(plane.yAxis),
          zAxis: reflectDirection(plane.zAxis),
        },
      };
    }
    // A sweep derives moving frames from its path. Reflecting only its outer
    // work plane is not enough to guarantee those frames keep their handedness,
    // so the caller keeps the correct mirrored mesh and honestly bakes it.
    case 'sweep':
      return null;
    // Same trick as primitive/extrusion above, per embedded entity: reflecting
    // a plane's origin AND all three of its axes reflects every point
    // expressed in that frame, without touching the entity's own local data
    // — unlike a sweep, a loft's rails/guides carry no separate derived
    // moving frames that could lose their handedness this way.
    case 'loft': {
      const reflectEmbedded = (entity: Entity): Entity => mirroredEmbeddedLoftEntity(entity, reflectPoint, reflectDirection);
      return {
        ...feature,
        profiles: feature.profiles.map(reflectEmbedded),
        guides: feature.guides?.map(reflectEmbedded),
        path: feature.path ? reflectEmbedded(feature.path) : undefined,
      };
    }
    case 'mesh':
      return null;
  }
}

function scaledPoint(point: Vec3, base: Vec3, factor: number): Vec3 {
  return {
    x: base.x + (point.x - base.x) * factor,
    y: base.y + (point.y - base.y) * factor,
    z: base.z + (point.z - base.z) * factor,
  };
}

const scaleDirection = (direction: Vec3, factor: number): Vec3 => ({
  x: direction.x * factor,
  y: direction.y * factor,
  z: direction.z * factor,
});

function transformedRegion(region: SolidFaceRegion, transformPlane: (plane: WorkPlane) => WorkPlane): SolidFaceRegion {
  return {
    plane: transformPlane(region.plane),
    loops: region.loops.map((loop) => loop.map((point) => ({ ...point }))),
  };
}

function transformedEdge(
  edge: SolidEdgeSelection,
  point: (value: Vec3) => Vec3,
  direction: (value: Vec3) => Vec3,
  radiusFactor = 1,
): SolidEdgeSelection {
  return {
    ...edge,
    start: point(edge.start),
    end: point(edge.end),
    normalA: direction(edge.normalA),
    normalB: direction(edge.normalB),
    ...(edge.circular ? {
      circular: {
        ...edge.circular,
        center: point(edge.circular.center),
        normal: direction(edge.circular.normal),
        radius: edge.circular.radius * radiusFactor,
      },
    } : {}),
  };
}

function transformedMesh(
  mesh: SerializedSolidMesh | undefined,
  transform: (value: Vec3) => Vec3,
  reverseWinding = false,
): SerializedSolidMesh | undefined {
  if (!mesh) return undefined;
  const positions: number[] = [];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const point = transform({ x: mesh.positions[index], y: mesh.positions[index + 1], z: mesh.positions[index + 2] });
    positions.push(point.x, point.y, point.z);
  }
  const indices = [...mesh.indices];
  if (reverseWinding) {
    for (let index = 0; index < indices.length; index += 3) {
      [indices[index + 1], indices[index + 2]] = [indices[index + 2], indices[index + 1]];
    }
  }
  return { positions, indices };
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

/** Moves a loft's own embedded profile/guide/path entity by a world delta —
 *  only its plane's origin, same as translatedFeature's extrusion/primitive/
 *  sweep case: the entity's own local points stay expressed in that plane,
 *  unmoved, exactly like theirs. */
function translatedEmbeddedLoftEntity(entity: Entity, delta: Vec3): Entity {
  const moved = cloneEntity(entity);
  const plane = planeOf(moved.workPlane);
  moved.workPlane = {
    ...plane,
    origin: { x: plane.origin.x + delta.x, y: plane.origin.y + delta.y, z: plane.origin.z + delta.z },
  };
  return moved;
}

/** Turns a loft's own embedded entity about a world axis — only its plane
 *  (origin swung about the axis, all three axes turned in place), same as
 *  rotatedFeature's extrusion/primitive/sweep case and for the same reason:
 *  a rotation distributes linearly over the plane's origin and basis
 *  vectors, so the entity's own local points need not move at all. */
function rotatedEmbeddedLoftEntity(entity: Entity, origin: Vec3, axis: Vec3, angle: number): Entity {
  const turned = cloneEntity(entity);
  const plane = planeOf(turned.workPlane);
  turned.workPlane = {
    origin: turnPoint(plane.origin, origin, axis, angle),
    xAxis: turnDirection(plane.xAxis, axis, angle),
    yAxis: turnDirection(plane.yAxis, axis, angle),
    zAxis: turnDirection(plane.zAxis, axis, angle),
  };
  return turned;
}

/** Reflects a loft's own embedded entity — only its plane (origin and all
 *  three axes), same as mirroredFeature's extrusion/primitive case: a
 *  reflection is linear too, so reflecting the whole frame reflects every
 *  point described in it without touching the entity's own local data. */
function mirroredEmbeddedLoftEntity(
  entity: Entity,
  reflectPoint: (point: Vec3) => Vec3,
  reflectDirection: (direction: Vec3) => Vec3,
): Entity {
  const reflected = cloneEntity(entity);
  const plane = planeOf(reflected.workPlane);
  reflected.workPlane = {
    origin: reflectPoint(plane.origin),
    xAxis: reflectDirection(plane.xAxis),
    yAxis: reflectDirection(plane.yAxis),
    zAxis: reflectDirection(plane.zAxis),
  };
  return reflected;
}

/**
 * Scales a loft's own embedded entity about a world `base`. Unlike the other
 * three transforms above, this one genuinely has to touch the entity's own
 * local points, not just its plane — a plane's basis vectors are always
 * unit length, so moving only the origin would move the entity without
 * resizing it at all. Splitting `world' = base + factor·(world − base)` for
 * a point `world = origin + xAxis·P.x + yAxis·P.y` and matching terms shows
 * the origin moves exactly the way movedOrigin already does above (the same
 * primitive/extrusion trick), and the local point scales by `factor` about
 * its own LOCAL origin (0,0) — not `base` re-expressed locally, which would
 * double-count the origin's own motion.
 */
function scaleEmbeddedLoftEntity(entity: Entity, base: Vec3, factor: number): Entity {
  const plane = movedOrigin(planeOf(entity.workPlane), base, factor);
  // Mirrors transform.ts's scaleEntity (which this file cannot import,
  // itself importing from here) minus its `selected = true` side effect —
  // an embedded entity has no independent selection state of its own.
  const scaled = transformEntityPoints(entity, (point) => ({ x: point.x * factor, y: point.y * factor }));
  if (scaled.type === 'circle' || scaled.type === 'arc' || scaled.type === 'octagon') scaled.radius *= factor;
  if (scaled.type === 'ellipse') { scaled.radiusX *= factor; scaled.radiusY *= factor; }
  if (scaled.type === 'text') scaled.height *= factor;
  if (scaled.type === 'insert') scaled.scaleZ *= factor;
  scaled.selected = entity.selected;
  scaled.workPlane = plane;
  return scaled;
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
