/**
 * "Click a face, remove what made it." A hole is a subtracted cutter; a bump is
 * a unioned operand; a rounded edge is a fillet. None of them is a separate
 * object once the boolean ran, so you cannot delete them by selecting geometry —
 * only by reaching into the history that built the solid.
 *
 * This finds which recorded feature is responsible for the surface under a click
 * and removes it: for every removable feature we rebuild the solid without it and
 * keep the one whose removal makes that exact surface point vanish, preferring
 * the most local edit (smallest change in volume) when several qualify — so a
 * click on a bump removes the bump, not the whole body it sits on.
 */
import type { Solid, SolidFeature, SolidMesh } from '../entities/types';
import type { Vec3 } from '../../math/geometry';
import { buildExactFeature } from '../geometry/ExactSolid';

export interface RemovalCandidate {
  /** Path from the root feature to the feature this removes. */
  path: number[];
  /** `splice` drops a boolean operand; `unwrap` peels a fillet/chamfer/press-pull off its source. */
  mode: 'splice' | 'unwrap';
}

const cloneFeature = (feature: SolidFeature): SolidFeature => JSON.parse(JSON.stringify(feature)) as SolidFeature;

function featureAt(root: SolidFeature, path: readonly number[]): SolidFeature | null {
  let feature: SolidFeature = root;
  for (const index of path) {
    const next = feature.kind === 'boolean'
      ? feature.operands[index]
      : (feature.kind === 'edge-modification' || feature.kind === 'presspull-region') && index === 0
        ? feature.source
        : null;
    if (!next) return null;
    feature = next;
  }
  return feature;
}

/** A copy of `root` with the feature at `path` replaced by `replacement`. */
function replaceFeatureAt(root: SolidFeature, path: readonly number[], replacement: SolidFeature): SolidFeature {
  if (path.length === 0) return replacement;
  const copy = cloneFeature(root);
  const parent = featureAt(copy, path.slice(0, -1));
  const index = path[path.length - 1];
  if (!parent) return copy;
  if (parent.kind === 'boolean') parent.operands[index] = replacement;
  else if (parent.kind === 'edge-modification' || parent.kind === 'presspull-region') parent.source = replacement;
  return copy;
}

/** Every feature that can be removed on its own: each boolean operand, and each fillet/chamfer/press-pull wrapper. */
export function candidateRemovals(root: SolidFeature, path: number[] = []): RemovalCandidate[] {
  const out: RemovalCandidate[] = [];
  if (root.kind === 'edge-modification' || root.kind === 'presspull-region') {
    out.push({ path: [...path], mode: 'unwrap' });
    out.push(...candidateRemovals(root.source, [...path, 0]));
  } else if (root.kind === 'boolean') {
    root.operands.forEach((operand, index) => {
      out.push({ path: [...path, index], mode: 'splice' });
      out.push(...candidateRemovals(operand, [...path, index]));
    });
  }
  return out;
}

/** The feature tree with `candidate` removed, or null if that would leave nothing buildable. */
export function applyRemoval(root: SolidFeature, candidate: RemovalCandidate): SolidFeature | null {
  if (candidate.mode === 'unwrap') {
    const target = featureAt(root, candidate.path);
    if (!target || (target.kind !== 'edge-modification' && target.kind !== 'presspull-region')) return null;
    return replaceFeatureAt(root, candidate.path, cloneFeature(target.source));
  }
  const parentPath = candidate.path.slice(0, -1);
  const parent = featureAt(root, parentPath);
  const index = candidate.path[candidate.path.length - 1];
  if (!parent || parent.kind !== 'boolean') return null;
  const operands = parent.operands.filter((_, i) => i !== index);
  if (operands.length === 0) return null;
  // A boolean of one operand is just that operand.
  const replacement: SolidFeature = operands.length === 1
    ? cloneFeature(operands[0])
    : { ...cloneFeature(parent), operands: operands.map(cloneFeature) } as SolidFeature;
  return replaceFeatureAt(root, parentPath, replacement);
}

function meshVolume(mesh: SolidMesh): number {
  let volume = 0;
  const p = mesh.positions, ix = mesh.indices;
  for (let o = 0; o + 2 < ix.length; o += 3) {
    const a = ix[o] * 3, b = ix[o + 1] * 3, c = ix[o + 2] * 3;
    volume += (
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
    ) / 6;
  }
  return Math.abs(volume);
}

function meshExtent(mesh: SolidMesh): number {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) { const v = mesh.positions[i + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
  }
  return Math.max(1, max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len3 = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const normalized3 = (value: number[]): number[] | null => {
  const length = len3(value);
  return length > 1e-9 ? value.map((component) => component / length) : null;
};

/** Shortest distance from a point to a triangle (Ericson, Real-Time Collision Detection). */
function pointTriangleDistance(p: number[], a: number[], b: number[], c: number[]): number {
  const ab = sub3(b, a), ac = sub3(c, a), ap = sub3(p, a);
  const d1 = dot3(ab, ap), d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len3(ap);
  const bp = sub3(p, b), d3 = dot3(ab, bp), d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len3(bp);
  const cp = sub3(p, c), d5 = dot3(ab, cp), d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len3(cp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return len3(sub3(p, [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v])); }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const v = d2 / (d2 - d6); return len3(sub3(p, [a[0] + ac[0] * v, a[1] + ac[1] * v, a[2] + ac[2] * v])); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { const v = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return len3(sub3(p, [b[0] + (c[0] - b[0]) * v, b[1] + (c[1] - b[1]) * v, b[2] + (c[2] - b[2]) * v])); }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return len3(sub3(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]));
}

const triAt = (mesh: SolidMesh, o: number): [number[], number[], number[]] => {
  const p = mesh.positions, ix = mesh.indices;
  return [
    [p[ix[o] * 3], p[ix[o] * 3 + 1], p[ix[o] * 3 + 2]],
    [p[ix[o + 1] * 3], p[ix[o + 1] * 3 + 1], p[ix[o + 1] * 3 + 2]],
    [p[ix[o + 2] * 3], p[ix[o + 2] * 3 + 1], p[ix[o + 2] * 3 + 2]],
  ];
};

/** Outward normal of the mesh face nearest `point` (meshes are outward-wound). */
function nearestFaceNormal(point: number[], mesh: SolidMesh): number[] | null {
  let best = Infinity, normal: number[] | null = null;
  for (let o = 0; o + 2 < mesh.indices.length; o += 3) {
    const [a, b, c] = triAt(mesh, o);
    const d = pointTriangleDistance(point, a, b, c);
    if (d < best) {
      const n = [
        (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
        (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
      ];
      const l = len3(n) || 1;
      best = d; normal = [n[0] / l, n[1] / l, n[2] / l];
    }
  }
  return normal;
}

const triNormal = (a: number[], b: number[], c: number[]): number[] => {
  const n = [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
  const l = len3(n) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
};

/**
 * Whether the face under the click — its position AND its orientation — is gone
 * from `mesh`. A coplanar neighbour that merely continues the plane does not
 * count as "still there" because a same-position test alone would be fooled by
 * it; the orientation has to match too. That is what lets a bump flush against
 * the body be told apart from the body's own face.
 */
function clickedFaceGone(point: number[], normal: number[], mesh: SolidMesh, tolerance: number): boolean {
  for (let o = 0; o + 2 < mesh.indices.length; o += 3) {
    const [a, b, c] = triAt(mesh, o);
    if (pointTriangleDistance(point, a, b, c) > tolerance) continue;
    const n = triNormal(a, b, c);
    if (dot3(n, normal) > 0.9) return false;
  }
  return true;
}

/**
 * Orientation of an operand boundary after it has travelled through the
 * boolean tree to the final solid. A cutter's outward normal becomes the
 * inward-facing wall of a subtraction; another nested subtraction flips it
 * again. Union preserves the orientation.
 */
function boundaryOrientationAt(root: SolidFeature, path: readonly number[]): number {
  let feature: SolidFeature = root;
  let orientation = 1;
  for (const index of path) {
    if (feature.kind === 'boolean') {
      if (feature.operation === 'subtract' && index > 0) orientation *= -1;
      const next = feature.operands[index];
      if (!next) break;
      feature = next;
      continue;
    }
    if ((feature.kind === 'edge-modification' || feature.kind === 'presspull-region') && index === 0) {
      feature = feature.source;
      continue;
    }
    break;
  }
  return orientation;
}

/**
 * The clicked boundary has to be part of this operand, not merely close to one
 * of its edges. Position alone leaked across hole and bump rims; checking the
 * oriented surface normal keeps the two sides of a design edge distinct.
 */
function surfaceMatches(
  point: number[],
  normal: number[],
  mesh: SolidMesh,
  tolerance: number,
  orientation: number,
): { distance: number } | null {
  let best = Infinity;
  for (let offset = 0; offset + 2 < mesh.indices.length; offset += 3) {
    const [a, b, c] = triAt(mesh, offset);
    const distance = pointTriangleDistance(point, a, b, c);
    if (distance > tolerance || distance >= best) continue;
    const candidateNormal = triNormal(a, b, c);
    if (dot3(candidateNormal, normal) * orientation <= 0.9) continue;
    best = distance;
  }
  return Number.isFinite(best) ? { distance: best } : null;
}

/** Operand 0 is the body being edited; removing it would strand additions/cutters. */
function isBooleanBase(root: SolidFeature, candidate: RemovalCandidate): boolean {
  if (candidate.mode !== 'splice' || candidate.path[candidate.path.length - 1] !== 0) return false;
  const parent = featureAt(root, candidate.path.slice(0, -1));
  return parent?.kind === 'boolean';
}

export interface FeatureRemovalResult {
  candidate: RemovalCandidate;
  feature: SolidFeature;
  mesh: SolidMesh;
}

/**
 * The feature to remove so the surface under `worldPoint` disappears — a hole
 * fills, a bump goes, a rounded edge un-rounds. Null when nothing recorded is
 * responsible (a bare primitive face, or an imported mesh with no history).
 *
 * A boolean operand (a bump, a subtracted cutter) is judged by *its own*
 * geometry's nearness to the click — a local test that never blames a distant
 * feature whose removal happens to collapse the tree. Fillet/press-pull wrappers
 * have no separable shape, so they fall back to "does the clicked face vanish".
 */
export async function featureRemovalForPoint(solid: Solid, worldPoint: Vec3, worldNormal?: Vec3): Promise<FeatureRemovalResult | null> {
  const root = solid.feature;
  if (root.kind === 'mesh' || root.kind === 'primitive') return null;
  const original = solid.mesh;
  const point = [worldPoint.x, worldPoint.y, worldPoint.z];
  const extent = meshExtent(original);
  // Ray picking supplies a point on the rendered triangle, so this is a
  // geometry tolerance, not a screen-space picking tolerance. Keep enough room
  // for the tiny UNION fuse inflation, but never the old 0.1-unit halo that
  // crossed visible feature edges.
  const tolerance = Math.max(2e-3, extent * 5e-4);
  const candidates = candidateRemovals(root);

  const build = async (candidate: RemovalCandidate): Promise<FeatureRemovalResult | null> => {
    const feature = applyRemoval(root, candidate);
    if (!feature) return null;
    const geometry = await buildExactFeature(feature);
    if (!geometry || geometry.mesh.indices.length === 0) return null;
    return { candidate, feature, mesh: geometry.mesh };
  };

  const clickedNormal = normalized3(worldNormal
    ? [worldNormal.x, worldNormal.y, worldNormal.z]
    : nearestFaceNormal(point, original) ?? []);
  if (!clickedNormal) return null;

  // Tier 1: find the boolean operand whose *oriented boundary* is under the
  // click and whose removal makes that boundary disappear. Ranking by the
  // resulting volume change favours the most local nested feature instead of
  // discarding a whole ancestor merely because it contains the same surface.
  const originalVolume = meshVolume(original);
  let bestSplice: (FeatureRemovalResult & { distance: number; volumeDelta: number }) | null = null;
  for (const candidate of candidates) {
    if (candidate.mode !== 'splice' || isBooleanBase(root, candidate)) continue;
    const operand = featureAt(root, candidate.path);
    if (!operand) continue;
    const operandGeometry = await buildExactFeature(operand);
    const operandMesh = operandGeometry?.mesh;
    if (!operandMesh || operandMesh.indices.length === 0) continue;
    const match = surfaceMatches(
      point,
      clickedNormal,
      operandMesh,
      tolerance,
      boundaryOrientationAt(root, candidate.path),
    );
    if (!match) continue;
    const result = await build(candidate);
    if (!result || !clickedFaceGone(point, clickedNormal, result.mesh, tolerance)) continue;
    const volumeDelta = Math.abs(meshVolume(result.mesh) - originalVolume);
    if (!bestSplice
      || volumeDelta < bestSplice.volumeDelta - tolerance ** 3
      || (Math.abs(volumeDelta - bestSplice.volumeDelta) <= tolerance ** 3 && match.distance < bestSplice.distance)) {
      bestSplice = { ...result, distance: match.distance, volumeDelta };
    }
  }
  if (bestSplice) return { candidate: bestSplice.candidate, feature: bestSplice.feature, mesh: bestSplice.mesh };

  // Tier 2: a fillet/chamfer/press-pull whose removal makes the clicked face vanish.
  let best: (FeatureRemovalResult & { volumeDelta: number }) | null = null;
  for (const candidate of candidates) {
    if (candidate.mode !== 'unwrap') continue;
    const result = await build(candidate);
    if (!result || !clickedFaceGone(point, clickedNormal, result.mesh, tolerance)) continue;
    const volumeDelta = Math.abs(meshVolume(result.mesh) - originalVolume);
    if (!best || volumeDelta < best.volumeDelta) best = { ...result, volumeDelta };
  }
  return best ? { candidate: best.candidate, feature: best.feature, mesh: best.mesh } : null;
}
