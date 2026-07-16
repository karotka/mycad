/**
 * A solid's feature tree, flattened into rows to draw.
 *
 * The engine has always kept how a solid was made — a boolean over primitives,
 * an extrusion, a sweep. Nothing showed it, so anything past a bare primitive
 * was a black box: the numbers were all still in the file, and the only way to
 * reach them was to edit the file. This is the part that turns the tree into
 * rows; the panel draws them.
 */
import type { Solid, SolidFeature } from '../core/entities/types';
import { cloneSolid } from '../core/history/edits';
import { setFeatureParam } from '../core/solids/featureParams';
import { regenerateSolidFeature } from '../core/solids/ManifoldEngine';

export interface TreeRow {
  /** Which operand to take at each level to reach this feature from the root. */
  path: number[];
  depth: number;
  label: string;
  detail: string;
  feature: SolidFeature;
  hasChildren: boolean;
}

export function featureLabel(feature: SolidFeature): { label: string; detail: string } {
  switch (feature.kind) {
    case 'boolean':
      return {
        label: feature.operation === 'union' ? 'Union' : 'Subtract',
        detail: `${feature.operands.length} parts`,
      };
    case 'primitive': {
      const name = feature.primitive[0].toUpperCase() + feature.primitive.slice(1);
      const round = (value: number) => Number(value.toFixed(2));
      const size = feature.primitive === 'box' || feature.primitive === 'wedge'
        ? `${round(feature.width ?? 1)} × ${round(feature.depth ?? 1)} × ${round(feature.height)}`
        : `r ${round(feature.radius ?? 1)}`;
      // A scale is what makes it an ellipsoid rather than a ball, so it belongs
      // in the line: two spheres of the same radius can be different shapes.
      const scale = feature.scale && (feature.scale.x !== 1 || feature.scale.y !== 1 || feature.scale.z !== 1)
        ? ` · ${round(feature.scale.x)}:${round(feature.scale.y)}:${round(feature.scale.z)}`
        : '';
      return { label: name, detail: size + scale };
    }
    case 'extrusion':
      return { label: 'Extrusion', detail: `${Number(feature.height.toFixed(2))} high` };
    case 'sweep':
      return { label: 'Sweep', detail: 'profile along path' };
    case 'mesh':
      return { label: 'Mesh', detail: 'no history' };
  }
}

/**
 * Depth-first, parents before children, which is the order they are drawn in.
 * `collapsed` holds the paths whose children are folded away — keyed by the
 * path joined, since an array is never equal to another array.
 */
export function featureRows(
  feature: SolidFeature,
  collapsed: ReadonlySet<string> = new Set(),
  path: number[] = [],
  depth = 0,
): TreeRow[] {
  const { label, detail } = featureLabel(feature);
  const hasChildren = feature.kind === 'boolean' && feature.operands.length > 0;
  const row: TreeRow = { path, depth, label, detail, feature, hasChildren };
  if (!hasChildren || collapsed.has(pathKey(path))) return [row];

  const children = (feature as { operands: SolidFeature[] }).operands
    .flatMap((operand, index) => featureRows(operand, collapsed, [...path, index], depth + 1));
  return [row, ...children];
}

export const pathKey = (path: readonly number[]): string => path.join('.');

/**
 * The solid as it would be with one number in its tree changed, or null if the
 * change means nothing or cannot be built — a scale of zero, a subtraction with
 * nothing left of it.
 *
 * Works on a copy throughout, so a failure leaves the original untouched rather
 * than needing to be undone, and the caller gets a before and an after to hand
 * to the history. The whole solid is rebuilt from its root because a primitive
 * inside a boolean is not a shape on its own: what changed is what the union
 * came out as.
 */
export async function editedSolid(
  solid: Solid,
  path: readonly number[],
  key: string,
  value: number,
): Promise<Solid | null> {
  const after = cloneSolid(solid);
  const target = featureAt(after.feature, path);
  if (!target || !setFeatureParam(target, key, value)) return null;
  const mesh = await regenerateSolidFeature(after.feature);
  if (!mesh) return null;
  after.mesh = mesh;
  // The 3D view rebuilds a solid's geometry when its revision moves, and not
  // otherwise: forget this and the model keeps the shape it used to be.
  after.revision = solid.revision + 1;
  if (after.feature.kind === 'extrusion' || after.feature.kind === 'primitive') after.height = after.feature.height;
  return after;
}

/** The feature a row's path points at, or null if the tree has since changed. */
export function featureAt(root: SolidFeature, path: readonly number[]): SolidFeature | null {
  let feature: SolidFeature = root;
  for (const index of path) {
    if (feature.kind !== 'boolean') return null;
    const next = feature.operands[index];
    if (!next) return null;
    feature = next;
  }
  return feature;
}
