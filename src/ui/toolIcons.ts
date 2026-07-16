import type { CommandName } from '../core/commands/CommandManager';

/** Anything the toolbar can draw an icon for: a command, or one of the zoom actions. */
export type ToolbarIcon = CommandName | 'ZOOM_ALL' | 'ZOOM_WINDOW';

/** The toolbar's icon set. Pure data — a path per tool, drawn into a 24×24 box. */
export function toolIcon(command: ToolbarIcon): string {
  const paths: Partial<Record<ToolbarIcon, string>> = {
    LINE: '<line x1="4" y1="20" x2="20" y2="4"/><circle cx="4" cy="20" r="1.5"/><circle cx="20" cy="4" r="1.5"/>',
    POLYLINE: '<path d="M3 19l5-7 5 4 8-11"/><circle cx="3" cy="19" r="1.5"/><circle cx="8" cy="12" r="1.5"/><circle cx="13" cy="16" r="1.5"/><circle cx="21" cy="5" r="1.5"/>',
    RECTANGLE: '<rect x="4" y="6" width="16" height="12"/><path d="M4 4v4M2 6h4M20 16v4M18 18h4"/>',
    CIRCLE: '<circle cx="12" cy="12" r="8"/><path d="M12 2v20M2 12h20"/>',
    CIRCLE_DIAMETER: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M6 10l-2 2 2 2M18 10l2 2-2 2"/>',
    ELLIPSE: '<ellipse cx="12" cy="12" rx="9" ry="5.5"/><path d="M3 12h18M12 6.5v11"/>',
    POLYGON: '<path d="M12 3l8 6-3 10H7L4 9l8-6z"/><circle cx="12" cy="12" r="1"/>',
    ARC: '<path d="M5 18A10 10 0 0119 6"/><circle cx="5" cy="18" r="1.5"/><circle cx="19" cy="6" r="1.5"/>',
    BEZIER: '<path d="M3 18C8 3 16 21 21 6"/><path d="M3 18L8 6M21 6l-5 10" stroke-dasharray="2 2"/>',
    TEXT: '<path d="M4 20L11 4h2l7 16M7 14h10"/>',
    MOVE: '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M22 12l-3-3M22 12l-3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3"/>',
    COPY: '<rect x="7" y="7" width="13" height="13"/><path d="M4 16V4h12M4 4l3 3M4 4l3-3"/>',
    SCALE: '<path d="M4 20L20 4M4 20v-7M4 20h7M20 4v7M20 4h-7"/><rect x="8" y="8" width="8" height="8"/>',
    ROTATE: '<path d="M19 8V3l-2 2a8 8 0 10 2.2 10M19 3h-5"/><circle cx="12" cy="12" r="1.5"/>',
    BOX: '<path d="M4 8l8-4 8 4v9l-8 4-8-4V8zm0 0l8 4 8-4M12 12v9"/>',
    CYLINDER: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 18c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
    WEDGE: '<path d="M4 18h16L7 7H4v11zm3-11l13 5v6M4 18l3-3"/>',
    SPHERE: '<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="4" ry="8"/><path d="M4 12h16"/>',
    TORUS: '<ellipse cx="12" cy="12" rx="9" ry="6"/><ellipse cx="12" cy="12" rx="3.5" ry="2"/><path d="M3 12a9 6 0 0018 0"/>',
    CONE: '<ellipse cx="12" cy="18" rx="8" ry="3"/><path d="M4 18L12 3l8 15"/>',
    PYRAMID: '<path d="M12 3L3 17l9 4 9-4L12 3zM3 17l9-3 9 3M12 14v7"/>',
    ARRAY_RECTANGULAR: '<path d="M4 6h4v4H4V6zm6 0h4v4h-4V6zm6 0h4v4h-4V6zM4 12h4v4H4v-4zm6 0h4v4h-4v-4zm6 0h4v4h-4v-4z"/>',
    ARRAY_POLAR: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.4"/><path d="M12 4.5v3M12 16.5v3M4.5 12h3M16.5 12h3M16.8 7.2l-2.1 2.1M9.3 14.7l-2.1 2.1M7.2 7.2l2.1 2.1M14.7 14.7l2.1 2.1"/>',
    EXTRUDE: '<path d="M3 18h11l4-4H7L3 18zM12 11V2M8 6l4-4 4 4"/>',
    SWEEP: '<path d="M4 17c4-1 6-4 8-7s4-5 8-6"/><path d="M14 4h6v6M10 14l4 4"/>',
    UNION: '<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/><path d="M12 7.2a6 6 0 010 9.6"/>',
    SUBTRACT: '<circle cx="9" cy="12" r="7"/><path d="M12 5.7a7 7 0 010 12.6M14 12h7"/>',
    MIRROR: '<path d="M12 2v20M9 5L3 9v6l6 4V5zM15 5l6 4v6l-6 4" stroke-dasharray="2 2"/>',
    JOIN: '<path d="M3 18l6-7 5 4 7-10M7 11h4M12 15h4"/><circle cx="9" cy="11" r="1.5"/><circle cx="14" cy="15" r="1.5"/>',
    EXPLODE: '<rect x="7" y="7" width="10" height="10"/><path d="M7 7L3 3M17 7l4-4M7 17l-4 4M17 17l4 4M3 3h4M3 3v4M21 3h-4M21 3v4M3 21h4M3 21v-4M21 21h-4M21 21v-4"/>',
    EXTEND: '<path d="M4 19L19 4M3 9h8M8 6l3 3-3 3"/><path d="M14 9l5-5" stroke-dasharray="2 2"/>',
    TRIM: '<path d="M4 20L20 4M4 5l15 15M8 9l3 3"/><circle cx="8" cy="9" r="1.5"/>',
    OFFSET: '<path d="M4 17L17 4M7 20L20 7M8 14l3 3M14 8l3 3"/>',
    CHAMFER: '<path d="M4 19V7h7l9 9v3H4zM11 7v5l5 5"/>',
    FILLET: '<path d="M4 20V5h15M4 20c0-8.3 6.7-15 15-15"/>',
    PRESSPULL: '<path d="M3 17l9 4 9-4-9-4-9 4zM12 13V4M9 7l3-3 3 3M9 10l3 3 3-3"/>',
    ERASE: '<path d="M4 16L14 4l6 5-9 11H7l-3-4zM11 20h10"/>',
    MEASURE: '<path d="M4 19L19 4M3 15l6 6M15 3l6 6M8 14l2 2M11 11l2 2M14 8l2 2"/>',
    DIMALIGNED: '<path d="M4 20L20 4"/><path d="M2 14l4 4M18 2l4 4" stroke-dasharray="2 2"/><path d="M6 18l3 1-1-3M18 6l-3-1 1 3"/>',
    DIMRADIUS: '<circle cx="11" cy="12" r="7"/><path d="M11 12l5-5M14 7h2v2"/><text class="tool-icon-label" x="17" y="22">R</text>',
    DIMDIAMETER: '<circle cx="11" cy="12" r="7"/><path d="M6 17L16 7M6 15v2h2M14 7h2v2"/><text class="tool-icon-label" x="17" y="22">Ø</text>',
    UCS: '<path d="M5 19V7M5 19h12M5 19l7-7M5 7l-2 3M5 7l2 3M17 19l-3-2M17 19l-3 2M12 12l-1-4M12 12l4-1"/>',
    ZOOM_ALL: '<circle cx="13" cy="8.5" r="5.5"/><path d="M17 12.5l4.5 4.5"/><text class="tool-icon-label" x="1" y="22">ALL</text>',
    ZOOM_WINDOW: '<circle cx="13" cy="8.5" r="5.5"/><path d="M17 12.5l4.5 4.5"/><text class="tool-icon-label" x="1" y="22">WIN</text>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[command] ?? '<circle cx="12" cy="12" r="8"/>'}</svg>`;
}
