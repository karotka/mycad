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
 * How the drawing comes out as G-code, for a pen plotter: the machine takes one
 * tool around the XY plane and Z only lifts it. Kept beside the other document
 * settings and saved with the drawing, because a plotter's feed and pen heights
 * belong to the drawing that was set up for it, not to whoever opens the file.
 */
export interface GcodeOptions {
  /** Along a line, in mm/min. */
  feedRate: number;
  /** Between lines, pen up, in mm/min. */
  travelRate: number;
  /** Z where the pen touches the paper. Negative for a knife or a router. */
  cutDepth: number;
  /** Z the pen lifts to, clear of the work. */
  safeHeight: number;
  /** How finely curves are broken into straight moves. */
  segments: number;
}

export function defaultGcodeOptions(): GcodeOptions {
  return { feedRate: 800, travelRate: 2400, cutDepth: 0, safeHeight: 5, segments: 64 };
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
