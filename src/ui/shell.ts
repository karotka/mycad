import type { CommandName } from '../core/commands/CommandManager';
import {
  arcFlyout, arrayFlyout, circleFlyout, curveFlyout, dimensionFlyout, drawTools, editTools, extrudeFlyout,
  modifyTools, primitiveFlyout, solidTools, toolButtons, zoomFlyout,
} from './toolbar';
import {
  STROKE_FONT, STROKE_FONT_DUPLEX, STROKE_FONT_GOTHIC, STROKE_FONT_SCRIPT, STROKE_FONT_TRIPLEX,
} from '../core/text/strokeFont';

/** Shared by the pre-placement text-style panel and the on-canvas text editor,
 *  so the two font pickers never drift apart. */
const TEXT_FONT_OPTIONS = `
  <option value="${STROKE_FONT}">Single-stroke (plottable)</option>
  <option value="${STROKE_FONT_DUPLEX}">Single-stroke Duplex (plottable)</option>
  <option value="${STROKE_FONT_TRIPLEX}">Single-stroke Triplex (plottable)</option>
  <option value="${STROKE_FONT_SCRIPT}">Single-stroke Script (plottable)</option>
  <option value="${STROKE_FONT_GOTHIC}">Single-stroke Gothic (plottable)</option>
  <option value="Arial">Arial</option>
  <option value="Helvetica">Helvetica</option>
  <option value="Verdana">Verdana</option>
  <option value="Times New Roman">Times New Roman</option>
  <option value="Courier New">Courier New</option>
`;

/** Which tool each flyout last used, so it opens showing that one. */
export interface ShellTools {
  primitive: CommandName;
  circle: CommandName;
  curve: CommandName;
  arc: CommandName;
  dimension: CommandName;
  zoom: 'ZOOM_ALL' | 'ZOOM_WINDOW';
}

/**
 * The application's markup, in one place. Everything here is static but the
 * flyouts, which show whichever tool they were last used with — hence the
 * argument. Nothing is wired up here: main.ts finds the elements and binds them.
 */
export function shellHtml(tools: ShellTools): string {
  return `
  <main class="app">
    <nav class="toolbar" aria-label="CAD tools">
      <div class="tool-group" role="group" aria-label="Draw">${toolButtons(drawTools)}${circleFlyout(tools.circle)}${arcFlyout(tools.arc)}${curveFlyout(tools.curve)}</div>
      <div class="tool-divider" aria-hidden="true"></div>
      <div class="tool-group" role="group" aria-label="2D edit">${toolButtons(editTools)}</div>
      <div class="tool-divider" aria-hidden="true"></div>
      <div class="tool-group" role="group" aria-label="Modify">${toolButtons(modifyTools)}${arrayFlyout()}${dimensionFlyout(tools.dimension)}</div>
      <div class="tool-divider" aria-hidden="true"></div>
      <div class="tool-group" role="group" aria-label="3D operations">${primitiveFlyout(tools.primitive)}${extrudeFlyout()}${toolButtons(solidTools)}</div>
      <div class="tool-divider" aria-hidden="true"></div>
      <div class="tool-group" role="group" aria-label="View and coordinate system">
        ${zoomFlyout(tools.zoom)}
        ${toolButtons([['UCS', 'UCS']])}
      </div>
    </nav>
    <section class="viewport-wrap" id="viewport">
      <canvas id="canvas2d"></canvas>
      <div id="viewport3d"></div>
      <div class="crosshair" id="crosshair"></div>
      <div class="selection-window" id="selection-window" hidden></div>
      <div class="measure-marker measure-origin" id="measure-origin" hidden></div>
      <div class="measure-marker measure-target" id="measure-target" hidden></div>
      <div class="snap-marker" id="snap-marker" hidden></div>
      <div class="tracking-line" id="tracking-line" hidden></div>
      <div class="dimension-toast" id="dimension-toast" hidden></div>
      <input class="dyn-dim-input" id="dyn-dim-width" type="text" inputmode="decimal" autocomplete="off" aria-label="Rectangle width" hidden />
      <input class="dyn-dim-input" id="dyn-dim-height" type="text" inputmode="decimal" autocomplete="off" aria-label="Rectangle height" hidden />
      <input class="dyn-dim-input" id="dyn-dim-length" type="text" inputmode="decimal" autocomplete="off" aria-label="Length" hidden />
      <span class="dyn-dim-label" id="dyn-dim-length-angle-separator" aria-hidden="true" hidden>&lt;</span>
      <input class="dyn-dim-input" id="dyn-dim-angle" type="text" inputmode="decimal" autocomplete="off" aria-label="Angle" hidden />
      <span class="dyn-dim-label" id="dyn-dim-angle-degree" aria-hidden="true" hidden>&deg;</span>
      <span class="dyn-dim-label" id="dyn-dim-x-prefix" aria-hidden="true" hidden>x:</span>
      <input class="dyn-dim-input" id="dyn-dim-x" type="text" inputmode="decimal" autocomplete="off" aria-label="X coordinate" hidden />
      <span class="dyn-dim-label" id="dyn-dim-y-prefix" aria-hidden="true" hidden>y:</span>
      <input class="dyn-dim-input" id="dyn-dim-y" type="text" inputmode="decimal" autocomplete="off" aria-label="Y coordinate" hidden />
      <input class="dyn-dim-input" id="dyn-dim-arc-radius" type="text" inputmode="decimal" autocomplete="off" aria-label="Arc radius" hidden />
      <section class="mtext-editor" id="mtext-editor" hidden>
        <label class="mtext-editor-font">Font<select id="mtext-editor-font">${TEXT_FONT_OPTIONS}</select></label>
        <label class="mtext-editor-height">Height (mm)<input id="mtext-editor-height" type="number" min="0.1" step="0.5" value="2.5" /></label>
        <textarea id="mtext-input" spellcheck="false" rows="4" placeholder="Type the text…"></textarea>
        <div class="mtext-editor-actions">
          <button id="mtext-done" type="button" title="Finish (⌘/Ctrl+Enter)">Done</button>
          <button id="mtext-cancel" type="button" title="Cancel (Esc)">Cancel</button>
        </div>
      </section>
      <div class="view-toggle">
        <div class="view-cube-stage">
          <svg class="view-compass" viewBox="0 0 132 118" aria-hidden="true">
            <defs>
              <radialGradient id="compass-disc" cx="0.5" cy="0.5" r="0.5">
                <stop offset="0.55" stop-color="rgba(120,130,140,0)"/>
                <stop offset="0.9" stop-color="rgba(120,130,140,0.16)"/>
                <stop offset="1" stop-color="rgba(120,130,140,0)"/>
              </radialGradient>
            </defs>
            <ellipse class="compass-disc" cx="66" cy="74" rx="64" ry="26"/>
            <ellipse class="compass-track" cx="66" cy="74" rx="60" ry="23"/>
            <ellipse class="compass-track compass-track-inner" cx="66" cy="74" rx="50" ry="18.5"/>
            <text class="compass-mark" x="66" y="42">N</text>
            <text class="compass-mark" x="66" y="106">S</text>
            <text class="compass-mark" x="4" y="74">W</text>
            <text class="compass-mark" x="128" y="74">E</text>
          </svg>
          <div id="view-cube" class="view-cube" aria-label="Standard CAD views">
            <div class="cube3d" id="cube3d">
              <button class="cube3d-face cube3d-top" data-standard-view="top" title="Top view"><span>TOP</span></button>
              <button class="cube3d-face cube3d-bottom" data-standard-view="bottom" title="Bottom view"><span>BOTTOM</span></button>
              <button class="cube3d-face cube3d-front" data-standard-view="front" title="Front view"><span>FRONT</span></button>
              <button class="cube3d-face cube3d-back" data-standard-view="back" title="Back view"><span>BACK</span></button>
              <button class="cube3d-face cube3d-left" data-standard-view="left" title="Left view"><span>LEFT</span></button>
              <button class="cube3d-face cube3d-right" data-standard-view="right" title="Right view"><span>RIGHT</span></button>
            </div>
          </div>
        </div>
        <div class="ucs-bar" aria-label="Saved coordinate systems">
          <button class="wcs-reset" id="wcs-reset" title="Return to World Coordinate System" aria-label="Return to World Coordinate System">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M21 12l-3-3M21 12l-3 3"/><circle cx="12" cy="12" r="2"/></svg>
            <span>WCS</span>
          </button>
          <div class="named-ucs-list" id="named-ucs-list"></div>
        </div>
      </div>
    </section>
    <section class="command-panel">
      <div class="command-resize-handle" id="command-resize-handle" title="Drag to resize command history"></div>
      <div class="command-log" id="command-log"></div>
      <form class="command-input-row" id="command-form">
        <label class="command-prompt" id="command-prompt" for="command-input">Command:</label>
        <input class="command-input" id="command-input" autocomplete="off" autofocus />
        <div class="command-suggestions" id="command-suggestions" hidden></div>
      </form>
    </section>
    <footer class="statusbar">
      <button class="bar-toggle" id="model-tree-toggle" title="Model Tree — how each solid was built" aria-label="Model Tree">TREE</button>
      <button class="bar-toggle" id="properties-toggle" title="Object Properties (Ctrl/⌘+1)" aria-label="Object Properties">PROPERTIES</button>
      <button class="bar-toggle" id="layer-toggle" title="Layers" aria-label="Layers">LAYERS <span id="layer-current">0</span></button>
      <button class="bar-toggle" id="block-toggle" title="Block library" aria-label="Block library">BLOCKS <span id="block-count">0</span></button>
      <span class="coords" id="coords">X: 0.0000 mm Y: 0.0000 mm</span>
      <div class="drafting-status" role="group" aria-label="Drafting modes">
        <button id="osnap-toggle" title="Object Snap (F3)" aria-label="Object Snap (F3)">OSNAP <kbd>F3</kbd></button>
        <button id="ducs-toggle" title="Dynamic UCS on planar faces (F6)" aria-label="Dynamic UCS (F6)">DUCS <kbd>F6</kbd></button>
        <button id="ducs-save" title="Save the current Dynamic UCS as a named UCS" aria-label="Save Dynamic UCS" hidden>SAVE UCS</button>
        <button id="grid-toggle" title="Grid display (F7)" aria-label="Grid display (F7)">GRID <kbd>F7</kbd></button>
        <button id="area-toggle" title="Print/cut area (Shift+F7)" aria-label="Print/cut area (Shift+F7)">AREA <kbd>⇧F7</kbd></button>
        <button id="ortho-toggle" title="Ortho Mode (F8)" aria-label="Ortho Mode (F8)">ORTHO <kbd>F8</kbd></button>
        <button id="snap-toggle" title="Snap Mode — cursor stepping (F9)" aria-label="Snap Mode (F9)">SNAP <kbd>F9</kbd></button>
        <button id="polar-toggle" title="Polar Tracking (F10)" aria-label="Polar Tracking (F10)">POLAR <kbd>F10</kbd></button>
        <button id="otrack-toggle" title="Object Snap Tracking (F11)" aria-label="Object Snap Tracking (F11)">OTRACK <kbd>F11</kbd></button>
      </div>
      <div class="visual-style" role="group" aria-label="Visual style">
        <button data-visual-style="wireframe" title="Wireframe — see-through, design edges only (no faces)" aria-label="Wireframe — design edges only, no faces">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 0v9m8-4.5L12 12 4 7.5M12 12v9"/></svg>
        </button>
        <button class="active" data-visual-style="xray" title="X-Ray — translucent faces with edges (see through the model)" aria-label="X-Ray — translucent faces with edges">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="xray-top" d="M12 3l8 4.5-8 4.5-8-4.5L12 3z"/><path class="xray-left" d="M4 7.5l8 4.5v9l-8-4.5v-9z"/><path class="xray-right" d="M20 7.5L12 12v9l8-4.5v-9z"/><path d="M12 3v18M4 7.5l16 9M20 7.5l-16 9"/></svg>
        </button>
        <button data-visual-style="shaded" title="Shaded — solid opaque faces with edges (hidden edges occluded)" aria-label="Shaded — solid faces with edges">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="shade-top" d="M12 3l8 4.5-8 4.5-8-4.5L12 3z"/><path class="shade-left" d="M4 7.5l8 4.5v9l-8-4.5v-9z"/><path class="shade-right" d="M20 7.5L12 12v9l8-4.5v-9z"/></svg>
        </button>
      </div>
      <section class="properties-panel model-tree-panel" id="model-tree-panel" hidden>
        <header><strong>Model Tree</strong><button id="model-tree-close" title="Close">×</button></header>
        <div class="properties-content" id="model-tree-list"></div>
      </section>
      <section class="layer-panel" id="layer-panel" hidden>
        <header><strong>Layers</strong><span class="panel-header-actions"><button id="layer-add" title="New layer">+</button><button id="layer-close" title="Close">×</button></span></header>
        <div class="layer-list" id="layer-list"></div>
      </section>
      <section class="layer-panel block-panel" id="block-panel" hidden>
        <header><strong>Blocks</strong><span class="panel-header-actions"><button id="block-create" title="Create block from selection">+</button><button id="block-purge" title="Delete every block definition not reachable from anything placed in the drawing">Purge</button><button id="block-close" title="Close">×</button></span></header>
        <div class="block-list" id="block-list"></div>
      </section>
      <section class="properties-panel" id="properties-panel" hidden>
        <header><strong>Object Properties</strong><button id="properties-close" title="Close">×</button></header>
        <div class="properties-content" id="properties-content"></div>
      </section>
      <section class="settings-window" id="settings-window" hidden>
        <header class="settings-header">
          <strong>Settings</strong>
          <div class="settings-tabs" role="tablist">
            <button class="settings-tab" id="settings-tab-drafting" role="tab">Drafting</button>
            <button class="settings-tab" id="settings-tab-dimension" role="tab">Dimensions</button>
            <button class="settings-tab" id="settings-tab-hatch" role="tab">Hatch</button>
            <button class="settings-tab" id="settings-tab-gcode" role="tab">G-code</button>
            <button class="settings-tab" id="settings-tab-print" role="tab">Print</button>
          </div>
          <button id="settings-close" title="Close">×</button>
        </header>
        <form class="properties-content settings-tab-panel" id="drafting-settings-form" hidden>
          <label class="property-row"><span>Snap step (F9)</span><input id="drafting-snap-size" type="number" min="0.001" step="0.1"></label>
          <label class="property-row"><span>Grid spacing</span><input id="drafting-grid-size" type="number" min="0.001" step="0.1"></label>
          <label class="property-row"><span>Polar angles (F10)</span><input id="drafting-polar-angles" type="text" inputmode="numeric" placeholder="30, 45, 90"></label>
        </form>
        <form class="properties-content settings-tab-panel" id="dimension-style-form" hidden>
          <label class="property-row"><span>Text height</span><input id="dimension-text-height" type="number" min="0.1" step="0.1"></label>
          <label class="property-row"><span>Arrow size</span><input id="dimension-arrow-size" type="number" min="0.1" step="0.1"></label>
          <label class="property-row"><span>Arrow type</span><select id="dimension-arrow-type"><option value="closed">Closed filled</option><option value="open">Open</option><option value="tick">Architectural tick</option></select></label>
          <label class="property-row"><span>Extend beyond</span><input id="dimension-extension-beyond" type="number" min="0" step="0.1"></label>
          <label class="property-row"><span>Offset from object</span><input id="dimension-extension-offset" type="number" min="0" step="0.1"></label>
          <label class="property-row"><span>Text offset</span><input id="dimension-text-offset" type="number" min="0" step="0.1"></label>
          <label class="property-row"><span>Length precision</span><input id="dimension-precision" type="number" min="0" max="8" step="1"></label>
          <label class="property-row"><span>Angle precision</span><input id="dimension-angular-precision" type="number" min="0" max="8" step="1"></label>
          <label class="property-row"><span>Length units</span><select id="dimension-unit-suffix"><option value="none">No suffix</option><option value="mm">mm</option></select></label>
          <label class="property-row"><span>Scale</span><input id="dimension-scale" type="number" min="0.01" step="0.1"></label>
          <label class="property-row"><span>Layer</span><select id="dimension-layer"></select></label>
        </form>
        <form class="properties-content settings-tab-panel" id="hatch-settings-form" hidden>
          <label class="property-row"><span>Pattern</span><select id="hatch-pattern"><option value="lines">Lines</option><option value="cross">Cross</option><option value="solid">Solid</option></select></label>
          <label class="property-row"><span>Angle</span><input id="hatch-angle" type="number" step="1"></label>
          <label class="property-row"><span>Spacing</span><input id="hatch-spacing" type="number" min="0.001" step="0.1"></label>
        </form>
        <form class="properties-content settings-tab-panel" id="gcode-settings-form" hidden>
          <label class="property-row"><span>Homing code</span><input id="gcode-homing-code" type="text" spellcheck="false" title="Controller command emitted before the first move"></label>
          <label class="property-row"><span>Pen up code</span><input id="gcode-pen-up-code" type="text" spellcheck="false" title="Controller command that lifts or disables the pen"></label>
          <label class="property-row"><span>Pen down code</span><input id="gcode-pen-down-code" type="text" spellcheck="false" title="Controller command that lowers or enables the pen"></label>
          <label class="property-row"><span>Pen delay</span><input id="gcode-pen-delay" type="number" min="0" step="10" title="Pause in ms after raising or lowering the pen, so a servo has time to actually move"></label>
          <label class="property-row"><span>Travel feed</span><input id="gcode-travel-rate" type="number" min="1" step="50" title="mm/min while the pen is lifted"></label>
          <label class="property-row"><span>Draw feed</span><input id="gcode-feed-rate" type="number" min="1" step="50" title="mm/min while the pen is down"></label>
          <label class="property-row"><span>Show area</span><input id="gcode-frame-visible" type="checkbox" title="Show the non-exported print/cut area"></label>
          <label class="property-row"><span>Frame width</span><input id="gcode-frame-width" type="number" min="0.1" step="1" title="Print/cut area width in mm"></label>
          <label class="property-row"><span>Frame height</span><input id="gcode-frame-height" type="number" min="0.1" step="1" title="Print/cut area height in mm"></label>
          <label class="property-row"><span>Frame origin X</span><input id="gcode-frame-origin-x" type="number" step="1" title="Lower-left corner X in world coordinates"></label>
          <label class="property-row"><span>Frame origin Y</span><input id="gcode-frame-origin-y" type="number" step="1" title="Lower-left corner Y in world coordinates"></label>
          <label class="property-row"><span>Curve steps</span><input id="gcode-segments" type="number" min="3" max="512" step="1" title="Straight moves per full circle"></label>
          <label class="property-row"><span>Circles as</span><select id="gcode-hole-mode" title="How circles are cut: a traced outline for a plotter, or a single plunge at the centre for a drilling machine">
            <option value="contour">Outline (plotter/laser)</option>
            <option value="drill">Drill point (drilling machine)</option>
          </select></label>
        </form>
        <form class="properties-content settings-tab-panel" id="print-settings-form" hidden>
          <label class="property-row"><span>Paper size</span><select id="print-paper">
            <option value="A4">A4</option>
            <option value="A3">A3</option>
            <option value="A2">A2</option>
            <option value="A1">A1</option>
            <option value="A0">A0</option>
          </select></label>
          <label class="property-row"><span>Orientation</span><select id="print-orientation">
            <option value="landscape">Landscape</option>
            <option value="portrait">Portrait</option>
          </select></label>
          <label class="property-row"><span>Output</span><select id="print-color-mode">
            <option value="color">Color</option>
            <option value="grayscale">Grayscale</option>
            <option value="black">Black &amp; white</option>
          </select></label>
          <label class="property-row"><span>Lineweights</span><input id="print-keep-lineweights" type="checkbox" checked title="Keep each layer's pen width; unchecked prints every object at the same hairline width"></label>
          <p class="property-hint">The picked window is fit to the page and centred, keeping its proportions. Pure white always prints as black.</p>
          <button type="button" id="print-select">Select area &amp; export to PDF…</button>
        </form>
      </section>
    </footer>
  </main>
  <div class="context-menu" id="grip-menu" hidden>
    <section class="one-shot-snaps">
      <div class="context-menu-title">Object snap override</div>
      <button data-grip-mode="end">Endpoint</button>
      <button data-grip-mode="middle">Midpoint</button>
      <button data-grip-mode="perpendicular">Perpendicular</button>
      <button data-grip-mode="tangent">Tangent</button>
      <button data-grip-mode="intersection">Intersection</button>
      <button data-grip-mode="center">Center</button>
      <button data-grip-mode="apparent-intersection">Apparent intersection</button>
      <button data-grip-mode="mid2p">Mid between 2P</button>
      <button data-grip-mode="node">Node</button>
    </section>
    <section class="vertex-actions" hidden>
      <button data-grip-action="delete-vertex">Delete vertex</button>
    </section>
    <section class="persistent-snaps">
      <div class="context-menu-title">Running object snaps · F3</div>
      <button data-persistent-snap="end">Endpoint</button>
      <button data-persistent-snap="middle">Midpoint</button>
      <button data-persistent-snap="perpendicular">Perpendicular</button>
      <button data-persistent-snap="tangent">Tangent</button>
      <button data-persistent-snap="intersection">Intersection</button>
      <button data-persistent-snap="center">Center</button>
      <button data-persistent-snap="apparent-intersection">Apparent intersection</button>
      <button data-persistent-snap="node">Node</button>
      <button data-persistent-snap="nearest">Nearest</button>
    </section>
  </div>
  <section class="text-options" id="text-options" hidden>
    <strong>Text style</strong>
    <label>Font
      <select id="text-font">${TEXT_FONT_OPTIONS}</select>
    </label>
    <label>Height (mm)
      <input id="text-height" type="number" min="0.1" step="0.5" value="2.5" />
    </label>
    <button id="text-options-continue" type="button">Specify insertion point</button>
  </section>`;
}
