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
