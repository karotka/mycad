export type ObjectSnapMode = 'end' | 'center' | 'middle' | 'mid2p' | 'intersection' | 'apparent-intersection' | 'perpendicular';

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
  precision: number;
  scale: number;
  layer: string;
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
  };
}

export function defaultDraftingSettings(): DraftingSettings {
  return {
    orthoEnabled: false,
    polarEnabled: false,
    polarAngles: [30, 45, 90],
    objectSnapEnabled: true,
    objectSnapTrackingEnabled: true,
    objectSnapModes: ['end', 'center', 'intersection'],
  };
}

export function defaultDimensionStyle(): DimensionStyle {
  return { textHeight: 2.5, arrowSize: 2.5, arrowType: 'closed', extensionBeyond: 1.25, extensionOffset: 0.625, textOffset: 0.625, precision: 2, scale: 1, layer: 'dims' };
}
