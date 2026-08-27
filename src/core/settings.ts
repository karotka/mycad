export type ObjectSnapMode = 'end' | 'center' | 'middle' | 'node' | 'mid2p' | 'intersection' | 'apparent-intersection' | 'perpendicular' | 'nearest';

export interface DraftingSettings {
  orthoEnabled: boolean;
  polarEnabled: boolean;
  polarAngles: number[];
  objectSnapEnabled: boolean;
  /** Object snap tracking (F11): whether an acquired point lays an alignment path. */
  objectSnapTrackingEnabled: boolean;
  objectSnapModes: ObjectSnapMode[];
}

export interface DimensionStyle {
  textHeight: number;
  arrowSize: number;
  arrowType: 'closed' | 'open' | 'tick';
  extensionBeyond: number;
  extensionOffset: number;
  textOffset: number;
  /** Decimal places for linear, aligned, radius and diameter dimensions. */
  precision: number;
  /** Angular dimensions normally need fewer decimals than lengths. */
  angularPrecision: number;
  /** Length unit printed after the value; the drawing itself remains in mm. */
  unitSuffix: 'none' | 'mm';
  scale: number;
  layer: string;
}

export interface HatchSettings {
  pattern: 'lines' | 'cross' | 'solid';
  angle: number;
  spacing: number;
}

export function defaultHatchSettings(): HatchSettings {
  return { pattern: 'lines', angle: 45, spacing: 2 };
}

/**
 * How the drawing comes out as G-code for a pen plotter. Tool state is expressed
 * as configurable controller commands rather than assuming the machine owns a
 * Z axis. Kept with the drawing because speeds and firmware commands belong to
 * the machine the drawing was prepared for.
 */
export interface GcodeOptions {
  /** Along a line, in mm/min. */
  feedRate: number;
  /** Between lines, pen up, in mm/min. */
  travelRate: number;
  /** Controller command that lifts or disables the pen. */
  penUpCode: string;
  /** Controller command that lowers or enables the pen. */
  penDownCode: string;
  /** Controller-specific homing sequence emitted before any coordinate move. */
  homingCode: string;
  /** Whether the non-exported print/cut area overlay is visible. */
  frameVisible: boolean;
  /** Print/cut area in world XY millimetres; A4 landscape by default. */
  frameWidth: number;
  frameHeight: number;
  frameOriginX: number;
  frameOriginY: number;
  /** How finely curves are broken into straight moves. */
  segments: number;
  /**
   * What a circle means to the target machine. 'contour' traces the outline —
   * right for a plotter, laser or router. 'drill' plunges once at the centre —
   * right for a drilling machine, where a hole is a point, not a path.
   */
  holeMode: 'contour' | 'drill';
}

export function defaultGcodeOptions(): GcodeOptions {
  return {
    feedRate: 4000,
    travelRate: 6000,
    penUpCode: 'M5',
    penDownCode: 'M3 S19',
    homingCode: '$H',
    frameVisible: false,
    frameWidth: 297,
    frameHeight: 210,
    frameOriginX: 0,
    frameOriginY: 0,
    segments: 64,
    holeMode: 'contour',
  };
}

export function defaultDraftingSettings(): DraftingSettings {
  return {
    orthoEnabled: false,
    polarEnabled: false,
    polarAngles: [30, 45, 90],
    objectSnapEnabled: true,
    objectSnapTrackingEnabled: false,
    // 'intersection' is O(entity pairs × segment pairs) with the segments
    // recomputed on every pair instead of once — on a few thousand entities it
    // does not finish inside a pointer move at all. 'middle'/'center'/'node'
    // are comparatively cheap but add up; keep only the cheapest, most-used
    // mode on by default until the intersection algorithm itself is fixed.
    objectSnapModes: ['end'],
  };
}

export function defaultDimensionStyle(): DimensionStyle {
  return {
    textHeight: 2.5,
    arrowSize: 2.5,
    arrowType: 'closed',
    extensionBeyond: 1.25,
    extensionOffset: 0.625,
    textOffset: 0.625,
    precision: 2,
    angularPrecision: 1,
    unitSuffix: 'none',
    scale: 1,
    layer: 'dims',
  };
}
