/**
 * An elephant, to find out what the solid engine can actually do.
 *
 * Run: npx vite-node scripts/elephant.ts [output.mycad]
 *
 * The first attempt took 127 primitives, because every rounded mass had to be
 * faked as a chain of forty spheres unioned into a blob. That was the finding,
 * and the answer was to give PrimitiveFeature a scale rather than to get
 * cleverer with spheres: an elephant is mostly ellipsoids, and now an ellipsoid
 * is one sphere with three radii.
 *
 * What is left over is honest. The trunk still costs a handful of stretched
 * spheres, because it both curves and tapers and no primitive does that; a
 * truncated cone would halve it. Everything else is one primitive per part.
 *
 * It stays parametric — a boolean tree over primitives, not a baked mesh — so
 * every radius here is still a number you can edit and regenerate.
 */
import { writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Document } from '../src/core/Document';
import { regenerateSolidFeature } from '../src/core/solids/ManifoldEngine';
import { serializeProject } from '../src/io/ProjectIO';
import { workPlaneFromAxis } from '../src/math/workplane';
import type { PrimitiveFeature, SolidFeature } from '../src/core/entities/types';
import type { Vec3 } from '../src/math/geometry';
import type { WorkPlane } from '../src/math/workplane';

/** X is forward, towards the tip of the trunk. Y is left. Z is up. */
const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const upright = (origin: Vec3): WorkPlane => ({
  origin: { ...origin },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
});

const distance = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/** A sphere centred on a point: the local centre is the origin of its plane. */
const ball = (centre: Vec3, radius: number): PrimitiveFeature => ({
  kind: 'primitive', primitive: 'sphere', center: { x: 0, y: 0 }, radius, height: 0,
  workPlane: upright(centre),
});

/** A ball with three radii — the shape almost every part of an animal is. */
const egg = (centre: Vec3, radii: Vec3): PrimitiveFeature => ({
  ...ball(centre, 1),
  scale: radii,
});

/**
 * A limb between two points. It reaches a radius past each end on purpose: an
 * ellipsoid comes to a point, so segments that merely met would touch at a
 * point and read as a string of beads. Overlapping, they weld into one limb.
 */
const capsule = (from: Vec3, to: Vec3, radius: number, flatten = 1): PrimitiveFeature => {
  const middle = at((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  // Its own frame: local Z runs end to end, so the scale is (radius, radius,
  // half the length) and the work plane turns it to lie where it was asked for.
  return {
    ...ball(middle, 1),
    scale: { x: radius, y: radius * flatten, z: distance(from, to) / 2 + radius },
    workPlane: workPlaneFromAxis(middle, to),
  };
};

/** A flat ellipsoid facing a direction — an ear, without a cylinder's hard rim. */
const plate = (centre: Vec3, facing: Vec3, along: number, across: number, thickness: number): PrimitiveFeature => ({
  ...ball(centre, 1),
  scale: { x: along, y: across, z: thickness },
  workPlane: workPlaneFromAxis(centre, at(centre.x + facing.x, centre.y + facing.y, centre.z + facing.z)),
});

/** A cone with its base at `from` and its point at `to`. */
const spike = (from: Vec3, to: Vec3, radius: number): PrimitiveFeature => ({
  kind: 'primitive', primitive: 'cone', center: { x: 0, y: 0 }, radius, height: distance(from, to),
  workPlane: workPlaneFromAxis(from, to),
});

/** Both sides at once: an elephant is symmetric about y = 0. */
const mirrored = (build: (side: 1 | -1) => PrimitiveFeature[]): PrimitiveFeature[] => [...build(1), ...build(-1)];

// One ellipsoid for the barrel and one for the rump: what forty spheres were for.
const body = [
  egg(at(-14, 0, 23), { x: 30, y: 21, z: 21 }),
  egg(at(-36, 0, 18), { x: 13, y: 17, z: 16 }),
];

const head = [
  egg(at(20, 0, 22), { x: 17, y: 15, z: 17 }),
  egg(at(31, 0, 14), { x: 9, y: 10, z: 10 }), // the brow, above the trunk
];

// Curves and tapers at once, which no primitive does — so it stays a chain, but
// of overlapping capsules rather than forty round spheres.
const trunk = [
  capsule(at(35, 0, 10), at(48, 0, 6), 5.4),
  capsule(at(48, 0, 6), at(62, 0, 3.6), 4.4),
  capsule(at(62, 0, 3.6), at(76, 0, 2.6), 3.4),
  capsule(at(76, 0, 2.6), at(92, 0, 2.2), 2.6),
];

// As big as the head and sweeping back over the shoulder, as in the picture.
// A flattened ellipsoid, not a disc: a cylinder would give the ear a hard rim.
const ears = mirrored((side) => [
  plate(at(14, side * 13, 26), { x: 0.34, y: side * 0.92, z: 0.2 }, 20, 18, 1.6),
]);

const tusks = mirrored((side) => [
  spike(at(33, side * 6, 8), at(56, side * 9, 2.5), 2),
]);

// Outboard of the body, or they are buried in it and the elephant has no legs.
const legs = mirrored((side) => [
  // Front legs folded forward along the ground.
  capsule(at(8, side * 17, 7), at(34, side * 18, 6), 7),
  // Haunches, tucked under.
  egg(at(-30, side * 15, 13), { x: 12, y: 10, z: 11 }),
  capsule(at(-30, side * 16, 8), at(-14, side * 18, 7), 7),
]);

// Out at the surface: the head is 12 wide where these sit, so a dimple cut at
// y = 8.5 never reached it and the elephant came out with no eyes at all.
const eyes = mirrored((side) => [ball(at(30, side * 11.5, 23), 2.2)]);

const solid: SolidFeature = {
  kind: 'boolean',
  operation: 'subtract',
  operands: [
    { kind: 'boolean', operation: 'union', operands: [...body, ...head, ...trunk, ...ears, ...tusks, ...legs] },
    { kind: 'boolean', operation: 'union', operands: eyes },
  ],
};

async function main(): Promise<void> {
  const output = process.argv[2] ?? join(homedir(), 'Downloads', 'elephant.mycad');
  const count = (feature: SolidFeature): number =>
    feature.kind === 'boolean' ? feature.operands.reduce((total, operand) => total + count(operand), 0) : 1;
  console.log(`Building an elephant out of ${count(solid)} primitives...`);

  const started = Date.now();
  const mesh = await regenerateSolidFeature(solid);
  if (!mesh) throw new Error('The engine could not build it.');

  const doc = new Document();
  doc.addSolid(doc.createSolid(mesh, 'Elephant', 0, [], 0xd2703c, solid));
  writeFileSync(output, serializeProject(doc));

  console.log(`${mesh.indices.length / 3} triangles in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`Written to ${output} — open it in MyCAD.`);
}

void main();
