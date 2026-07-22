import type { Document } from '../core/Document';
import type { Solid } from '../core/entities/types';
import { ACI_WHITE, ACI_BYLAYER, rgbToAci } from './DxfAci';
import { DEFAULT_LINE_TYPE, DEFAULT_LINE_WEIGHT_MM } from '../core/lineStyles';
import { defaultDimensionStyle, defaultDraftingSettings, defaultGcodeOptions, type DimensionStyle, type DraftingSettings, type GcodeOptions, type ObjectSnapMode } from '../core/settings';
import { cloneWorkPlane, WORLD_WORK_PLANE, type WorkPlane } from '../math/workplane';

export interface ProjectViewState {
  mode: '2d' | '3d';
  twoD: { pan: { x: number; y: number }; zoom: number };
  threeD: {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    up: { x: number; y: number; z: number };
    projection: 'perspective' | 'orthographic';
    orbitRadius: number;
    activeStandardView: 'top' | 'front' | 'left' | 'right' | null;
  };
}

export function serializeProject(doc: Document, view?: ProjectViewState): string {
  return JSON.stringify({
    format: 'mycad',
    version: 1,
    units: 'mm',
    settings: {
      currentLayer: doc.currentLayer,
      layers: doc.layers,
      layerAci: doc.layerAci,
      layerLineweight: doc.layerLineweight,
      layerLinetype: doc.layerLinetype,
      hiddenLayers: Array.from(doc.hiddenLayers),
      gridSize: doc.gridSize,
      gridVisible: doc.gridVisible,
      snapSize: doc.snapSize,
      snapEnabled: doc.snapEnabled,
      activeWorkPlane: doc.activeWorkPlane,
      namedWorkPlanes: doc.namedWorkPlanes,
      activeNamedWorkPlaneId: doc.activeNamedWorkPlaneId,
      drafting: doc.drafting,
      dimensionStyle: doc.dimensionStyle,
      gcode: doc.gcode,
      view,
    },
    entities: doc.entities,
    solids: doc.solids.map((solid) => ({
      ...solid,
      selected: false,
      mesh: {
        positions: Array.from(solid.mesh.positions),
        indices: Array.from(solid.mesh.indices),
      },
    })),
  }, null, 2);
}

export function loadProject(doc: Document, content: string): ProjectViewState | undefined {
  const value = JSON.parse(content) as Record<string, unknown>;
  if (value.format !== 'mycad' || value.version !== 1) throw new Error('Unsupported project format.');
  if (!Array.isArray(value.entities) || !Array.isArray(value.solids)) throw new Error('The project does not contain valid CAD data.');
  const entities = value.entities as unknown[];
  const solids = value.solids as unknown[];
  const settings = (value.settings ?? {}) as Record<string, unknown>;
  const view = validViewState(settings.view) ? settings.view : undefined;
  doc.transaction(() => {
    doc.entities = entities.map((entity: unknown) => {
      const raw = entity as Record<string, unknown>;
      if (raw.type === 'dimension') {
        const defaults = defaultDimensionStyle();
        // Every kind it may have been saved as is honoured. A file with none at
        // all predates the distinction, and back then every dimension measured
        // point to point, which is what `aligned` is now called.
        const kind = raw.dimensionKind;
        return {
          ...raw, selected: false, aci: legacyAci(raw),
          dimensionKind: kind === 'radius' || kind === 'diameter' || kind === 'linear' || kind === 'aligned' ? kind : 'aligned',
          arrowType: raw.arrowType === 'open' || raw.arrowType === 'tick' ? raw.arrowType : 'closed',
          extensionBeyond: typeof raw.extensionBeyond === 'number' ? raw.extensionBeyond : defaults.extensionBeyond,
          extensionOffset: typeof raw.extensionOffset === 'number' ? raw.extensionOffset : defaults.extensionOffset,
          textOffset: typeof raw.textOffset === 'number' ? raw.textOffset : defaults.textOffset,
        };
      }
      return { ...raw, selected: false, aci: legacyAci(raw) };
    }) as Document['entities'];
    doc.solids = solids.map((raw: unknown) => {
      const solid = raw as Record<string, unknown>;
      const mesh = solid.mesh as { positions?: unknown; indices?: unknown };
      if (!mesh || !Array.isArray(mesh.positions) || !Array.isArray(mesh.indices)) throw new Error('The project contains an invalid 3D solid.');
      return {
        ...solid,
        selected: false,
        aci: legacyAci(solid),
        layer: typeof solid.layer === 'string' ? solid.layer : '0',
        mesh: { positions: new Float32Array(mesh.positions as number[]), indices: new Uint32Array(mesh.indices as number[]) },
      };
    }) as Document['solids'];
    doc.currentLayer = typeof settings.currentLayer === 'string' ? settings.currentLayer : '0';
    doc.layers = Array.isArray(settings.layers)
      ? Array.from(new Set(['0', ...(settings.layers as unknown[]).filter((layer): layer is string => typeof layer === 'string' && layer.length > 0)]))
      : Array.from(new Set(['0', ...doc.entities.map((entity) => entity.layer), ...doc.solids.map((solid) => solid.layer)]));
    // Layer colours are indices now. An older file stored RGB under
    // `layerColors`; its nearest palette index is close enough, and the drawing
    // would have been snapped to the palette on its next save anyway.
    doc.layerAci = settings.layerAci && typeof settings.layerAci === 'object'
      ? { '0': ACI_WHITE, ...(settings.layerAci as Record<string, number>) }
      : legacyLayerAci(settings.layerColors, doc.layers);
    // Line weight and type default per layer; a file without them reads as plain
    // continuous hairlines, which is what an older drawing was.
    doc.layerLineweight = layerNumberMap(settings.layerLineweight, doc.layers, DEFAULT_LINE_WEIGHT_MM);
    doc.layerLinetype = layerNameMap(settings.layerLinetype, doc.layers, DEFAULT_LINE_TYPE);
    doc.hiddenLayers = new Set(Array.isArray(settings.hiddenLayers)
      ? (settings.hiddenLayers as unknown[]).filter((layer): layer is string => typeof layer === 'string' && layer !== '0')
      : []);
    doc.gridSize = typeof settings.gridSize === 'number' ? settings.gridSize : 1;
    doc.gridVisible = typeof settings.gridVisible === 'boolean' ? settings.gridVisible : true;
    doc.snapSize = typeof settings.snapSize === 'number' ? settings.snapSize : 0.5;
    doc.snapEnabled = typeof settings.snapEnabled === 'boolean' ? settings.snapEnabled : true;
    doc.drafting = loadDraftingSettings(settings.drafting);
    doc.dimensionStyle = loadDimensionStyle(settings.dimensionStyle);
    doc.gcode = loadGcodeOptions(settings.gcode);
    doc.namedWorkPlanes = loadNamedWorkPlanes(settings.namedWorkPlanes);
    const activeNamed = typeof settings.activeNamedWorkPlaneId === 'string'
      ? doc.namedWorkPlanes.find((item) => item.id === settings.activeNamedWorkPlaneId)
      : undefined;
    doc.activeNamedWorkPlaneId = activeNamed?.id ?? null;
    doc.activeWorkPlane = activeNamed
      ? cloneWorkPlane(activeNamed.workPlane)
      : validWorkPlane(settings.activeWorkPlane)
        ? cloneWorkPlane(settings.activeWorkPlane)
        : cloneWorkPlane(WORLD_WORK_PLANE);
    doc.viewMode = view?.mode ?? (activeNamed ? '3d' : '2d');
    doc.selectedEntityIds.clear();
    doc.selectedSolidIds.clear();
    // The RGB every object and layer draws in is a cache of the indices just
    // loaded, so it is rebuilt rather than trusted from the file.
    doc.recolour();
    doc.notify();
  });
  return view;
}

const OBJECT_SNAP_MODES = new Set<ObjectSnapMode>(['end', 'center', 'middle', 'mid2p', 'intersection', 'apparent-intersection', 'perpendicular']);

function validWorkPlane(value: unknown): value is WorkPlane {
  if (!value || typeof value !== 'object') return false;
  const raw = value as Partial<Record<keyof WorkPlane, unknown>>;
  const finite3 = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== 'object') return false;
    const point = candidate as { x?: unknown; y?: unknown; z?: unknown };
    return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
  };
  return finite3(raw.origin) && finite3(raw.xAxis) && finite3(raw.yAxis) && finite3(raw.zAxis);
}

function loadNamedWorkPlanes(value: unknown): Document['namedWorkPlanes'] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const result: Document['namedWorkPlanes'] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const raw = candidate as { id?: unknown; name?: unknown; workPlane?: unknown };
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!id || ids.has(id) || !name || !validWorkPlane(raw.workPlane)) continue;
    ids.add(id);
    result.push({ id, name, workPlane: cloneWorkPlane(raw.workPlane) });
  }
  return result;
}

function loadDraftingSettings(value: unknown): DraftingSettings {
  const defaults = defaultDraftingSettings();
  if (!value || typeof value !== 'object') return defaults;
  const raw = value as Partial<Record<keyof DraftingSettings, unknown>>;
  const angles = Array.isArray(raw.polarAngles)
    ? raw.polarAngles.filter((angle): angle is number => typeof angle === 'number' && Number.isFinite(angle) && angle > 0 && angle <= 180)
    : defaults.polarAngles;
  const modes = Array.isArray(raw.objectSnapModes)
    ? raw.objectSnapModes.filter((mode): mode is ObjectSnapMode => typeof mode === 'string' && OBJECT_SNAP_MODES.has(mode as ObjectSnapMode))
    : defaults.objectSnapModes;
  return {
    orthoEnabled: typeof raw.orthoEnabled === 'boolean' ? raw.orthoEnabled : defaults.orthoEnabled,
    polarEnabled: typeof raw.polarEnabled === 'boolean' ? raw.polarEnabled : defaults.polarEnabled,
    polarAngles: angles.length > 0 ? Array.from(new Set(angles)) : defaults.polarAngles,
    objectSnapEnabled: typeof raw.objectSnapEnabled === 'boolean' ? raw.objectSnapEnabled : defaults.objectSnapEnabled,
    objectSnapTrackingEnabled: typeof raw.objectSnapTrackingEnabled === 'boolean' ? raw.objectSnapTrackingEnabled : defaults.objectSnapTrackingEnabled,
    objectSnapModes: Array.from(new Set(modes)),
  };
}

function loadDimensionStyle(value: unknown): DimensionStyle {
  const defaults = defaultDimensionStyle();
  if (!value || typeof value !== 'object') return defaults;
  const raw = value as Partial<Record<keyof DimensionStyle, unknown>>;
  const positive = (candidate: unknown, fallback: number): number => typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
  return {
    textHeight: positive(raw.textHeight, defaults.textHeight),
    arrowSize: positive(raw.arrowSize, defaults.arrowSize),
    arrowType: raw.arrowType === 'open' || raw.arrowType === 'tick' || raw.arrowType === 'closed' ? raw.arrowType : defaults.arrowType,
    extensionBeyond: positive(raw.extensionBeyond, defaults.extensionBeyond),
    extensionOffset: typeof raw.extensionOffset === 'number' && Number.isFinite(raw.extensionOffset) && raw.extensionOffset >= 0 ? raw.extensionOffset : defaults.extensionOffset,
    textOffset: typeof raw.textOffset === 'number' && Number.isFinite(raw.textOffset) && raw.textOffset >= 0 ? raw.textOffset : defaults.textOffset,
    precision: typeof raw.precision === 'number' && Number.isInteger(raw.precision) && raw.precision >= 0 && raw.precision <= 8 ? raw.precision : defaults.precision,
    scale: positive(raw.scale, defaults.scale),
    layer: typeof raw.layer === 'string' && raw.layer.trim() ? raw.layer : defaults.layer,
  };
}

/**
 * An object's colour index: its own if the file has one, otherwise inferred
 * from the RGB an older file stored — so a drawing from before the palette
 * keeps roughly the colours it had rather than all going white.
 */
function legacyAci(raw: Record<string, unknown>): number {
  if (typeof raw.aci === 'number') return raw.aci;
  return typeof raw.color === 'number' ? rgbToAci(raw.color) : ACI_BYLAYER;
}

/** A per-layer number map, filled in for every layer, with a fallback. */
function layerNumberMap(stored: unknown, layers: string[], fallback: number): Record<string, number> {
  const raw = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {};
  const result: Record<string, number> = {};
  for (const layer of layers) {
    result[layer] = typeof raw[layer] === 'number' && Number.isFinite(raw[layer]) && (raw[layer] as number) > 0 ? raw[layer] as number : fallback;
  }
  return result;
}

/** A per-layer string map, filled in for every layer, with a fallback. */
function layerNameMap(stored: unknown, layers: string[], fallback: string): Record<string, string> {
  const raw = stored && typeof stored === 'object' ? stored as Record<string, unknown> : {};
  const result: Record<string, string> = {};
  for (const layer of layers) result[layer] = typeof raw[layer] === 'string' ? raw[layer] as string : fallback;
  return result;
}

/** The same, per layer, from an older file's `layerColors` map of RGB. */
function legacyLayerAci(stored: unknown, layers: string[]): Record<string, number> {
  const colors = stored && typeof stored === 'object' ? stored as Record<string, number> : {};
  const result: Record<string, number> = { '0': ACI_WHITE };
  for (const layer of layers) {
    result[layer] = typeof colors[layer] === 'number' ? rgbToAci(colors[layer]) : ACI_WHITE;
  }
  return result;
}

function loadGcodeOptions(value: unknown): GcodeOptions {
  const defaults = defaultGcodeOptions();
  if (!value || typeof value !== 'object') return defaults;
  const raw = value as Partial<Record<keyof GcodeOptions, unknown>>;
  const positive = (candidate: unknown, fallback: number): number => typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
  const command = (candidate: unknown, fallback: string): string => typeof candidate === 'string' && candidate.trim() ? candidate.trim() : fallback;
  return {
    feedRate: positive(raw.feedRate, defaults.feedRate),
    travelRate: positive(raw.travelRate, defaults.travelRate),
    penUpCode: command(raw.penUpCode, defaults.penUpCode),
    penDownCode: command(raw.penDownCode, defaults.penDownCode),
    homingCode: command(raw.homingCode, defaults.homingCode),
    segments: typeof raw.segments === 'number' && Number.isInteger(raw.segments) && raw.segments >= 3 ? raw.segments : defaults.segments,
  };
}

function validViewState(value: unknown): value is ProjectViewState {
  if (!value || typeof value !== 'object') return false;
  const view = value as Partial<ProjectViewState>;
  const finite2 = (point: unknown): point is { x: number; y: number } => {
    const p = point as { x?: unknown; y?: unknown } | null;
    return Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y));
  };
  const finite3 = (point: unknown): point is { x: number; y: number; z: number } => {
    const p = point as { x?: unknown; y?: unknown; z?: unknown } | null;
    return Boolean(p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  };
  return (view.mode === '2d' || view.mode === '3d')
    && Boolean(view.twoD && finite2(view.twoD.pan) && Number.isFinite(view.twoD.zoom) && view.twoD.zoom > 0)
    && Boolean(view.threeD
      && finite3(view.threeD.position)
      && finite3(view.threeD.target)
      && finite3(view.threeD.up)
      && (view.threeD.projection === 'perspective' || view.threeD.projection === 'orthographic')
      && Number.isFinite(view.threeD.orbitRadius)
      && view.threeD.orbitRadius > 0
      && (view.threeD.activeStandardView === null || ['top', 'front', 'left', 'right'].includes(view.threeD.activeStandardView)));
}

export function exportAsciiStl(solids: readonly Solid[], name = 'MyCAD'): string {
  const lines = [`solid ${sanitizeName(name)}`];
  for (const solid of solids) {
    const positions = solid.mesh.positions;
    const indices = solid.mesh.indices;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = vertex(positions, indices[i]);
      const b = vertex(positions, indices[i + 1]);
      const c = vertex(positions, indices[i + 2]);
      const normal = triangleNormal(a, b, c);
      lines.push(`  facet normal ${normal.join(' ')}`);
      lines.push('    outer loop');
      lines.push(`      vertex ${a.join(' ')}`);
      lines.push(`      vertex ${b.join(' ')}`);
      lines.push(`      vertex ${c.join(' ')}`);
      lines.push('    endloop');
      lines.push('  endfacet');
    }
  }
  lines.push(`endsolid ${sanitizeName(name)}`);
  return `${lines.join('\n')}\n`;
}

function vertex(positions: Float32Array, index: number): [number, number, number] {
  const offset = index * 3;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
}

function triangleNormal(a: number[], b: number[], c: number[]): [number, number, number] {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z);
  return length < 1e-12 ? [0, 0, 0] : [x / length, y / length, z / length];
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_');
}
