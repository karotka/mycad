/**
 * A solid's feature tree, flattened into rows to draw.
 *
 * The engine has always kept how a solid was made — a boolean over primitives,
 * an extrusion, a sweep. Nothing showed it, so anything past a bare primitive
 * was a black box: the numbers were all still in the file, and the only way to
 * reach them was to edit the file. This is the part that turns the tree into
 * rows; the panel draws them.
 */
import type { SolidFeature } from '../core/entities/types';

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
