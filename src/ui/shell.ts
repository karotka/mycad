import type { CommandName } from '../core/commands/CommandManager';
import {
  arrayFlyout, circleFlyout, dimensionFlyout, drawTools, editTools, extrudeFlyout,
  modifyTools, primitiveFlyout, solidTools, toolButtons, zoomFlyout,
} from './toolbar';

/** Which tool each flyout last used, so it opens showing that one. */
export interface ShellTools {
  primitive: CommandName;
  circle: CommandName;
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
      <div class="tool-group" role="group" aria-label="Draw">${toolButtons(drawTools)}${circleFlyout(tools.circle)}</div>
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
      <div class="view-toggle">
        <div id="view-cube" class="view-cube" aria-label="Standard CAD views">
          <button class="cube-face cube-top" data-standard-view="top" title="Top view"><span class="cube-label">TOP</span></button>
          <button class="cube-face cube-right" data-standard-view="right" title="Right view"><span class="cube-label">RIGHT</span></button>
          <button class="cube-face cube-front" data-standard-view="front" title="Front view"><span class="cube-label">FRONT</span></button>
        </div>
        <button class="wcs-reset" id="wcs-reset" title="Return to World Coordinate System" aria-label="Return to World Coordinate System">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M21 12l-3-3M21 12l-3 3"/><circle cx="12" cy="12" r="2"/></svg>
          <span>WCS</span>
        </button>
      </div>
    </section>
    <footer class="statusbar">
      <button class="model-tree-toggle" id="model-tree-toggle" title="Model Tree — how each solid was built" aria-label="Model Tree">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5v13a2 2 0 002 2h3M4 12h5"/><rect x="13" y="2" width="7" height="6" rx="1"/><rect x="13" y="9" width="7" height="6" rx="1"/><rect x="13" y="16" width="7" height="6" rx="1"/><path d="M9 5h4M9 12h4M9 19h4"/></svg>
        <span>TREE</span>
      </button>
      <span class="coords" id="coords">X: 0.0000 mm Y: 0.0000 mm</span><span id="view-status">2D</span><span id="snap-status">SNAP: 0.5 mm · GRID: 1 mm</span>
      <div class="drafting-status" role="group" aria-label="Drafting modes">
        <button id="osnap-toggle" title="Object Snap (F3)" aria-label="Object Snap (F3)">OSNAP <kbd>F3</kbd></button>
        <button id="ortho-toggle" title="Ortho Mode (F8)" aria-label="Ortho Mode (F8)">ORTHO <kbd>F8</kbd></button>
        <button id="snap-toggle" title="Snap Mode — cursor stepping (F9)" aria-label="Snap Mode (F9)">SNAP <kbd>F9</kbd></button>
        <button id="polar-toggle" title="Polar Tracking (F10)" aria-label="Polar Tracking (F10)">POLAR <kbd>F10</kbd></button>
        <button id="otrack-toggle" title="Object Snap Tracking (F11)" aria-label="Object Snap Tracking (F11)">OTRACK <kbd>F11</kbd></button>
      </div>
      <div class="visual-style" role="group" aria-label="Visual style">
        <button class="active" data-visual-style="wireframe" title="Wireframe" aria-label="Wireframe">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zm0 0v9m8-4.5L12 12 4 7.5M12 12v9"/></svg>
        </button>
        <button data-visual-style="shaded" title="Shaded with Edges" aria-label="Shaded with Edges">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="shade-top" d="M12 3l8 4.5-8 4.5-8-4.5L12 3z"/><path class="shade-left" d="M4 7.5l8 4.5v9l-8-4.5v-9z"/><path class="shade-right" d="M20 7.5L12 12v9l8-4.5v-9z"/></svg>
        </button>
        <button data-visual-style="xray" title="X-Ray with Edges" aria-label="X-Ray with Edges">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path class="xray-top" d="M12 3l8 4.5-8 4.5-8-4.5L12 3z"/><path class="xray-left" d="M4 7.5l8 4.5v9l-8-4.5v-9z"/><path class="xray-right" d="M20 7.5L12 12v9l8-4.5v-9z"/><path d="M12 3v18M4 7.5l16 9M20 7.5l-16 9"/></svg>
        </button>
      </div>
      <button class="layer-toggle" id="layer-toggle" title="Layers" aria-label="Layers">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L3 8l9 5 9-5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/></svg>
        <span id="layer-current">0</span>
      </button>
      <button class="properties-toggle" id="properties-toggle" title="Object Properties (Ctrl/⌘+1)" aria-label="Object Properties">PROPERTIES</button>
      <button class="properties-toggle" id="drafting-settings-toggle" title="Drafting Settings — snap step, grid, polar angles" aria-label="Drafting Settings">DRAFTING</button>
      <button class="properties-toggle" id="dimension-style-toggle" title="Dimension Style" aria-label="Dimension Style">DIM STYLE</button>
      <section class="properties-panel model-tree-panel" id="model-tree-panel" hidden>
        <header><strong>Model Tree</strong><button id="model-tree-close" title="Close">×</button></header>
        <div class="properties-content" id="model-tree-list"></div>
      </section>
      <section class="layer-panel" id="layer-panel" hidden>
        <header><strong>Layers</strong><button id="layer-add" title="New layer">+</button></header>
        <div class="layer-list" id="layer-list"></div>
      </section>
      <section class="properties-panel" id="properties-panel" hidden>
        <header><strong>Object Properties</strong><button id="properties-close" title="Close">×</button></header>
        <div class="properties-content" id="properties-content"></div>
      </section>
      <section class="properties-panel dimension-style-panel" id="drafting-settings-panel" hidden>
        <header><strong>Drafting Settings</strong><button id="drafting-settings-close" title="Close">×</button></header>
        <form class="properties-content" id="drafting-settings-form">
          <label class="property-row"><span>Snap step (F9)</span><input id="drafting-snap-size" type="number" min="0.001" step="0.1"></label>
          <label class="property-row"><span>Grid spacing</span><input id="drafting-grid-size" type="number" min="0.001" step="0.1"></label>
          <label class="property-row"><span>Polar angles (F10)</span><input id="drafting-polar-angles" type="text" inputmode="numeric" placeholder="30, 45, 90"></label>
        </form>
      </section>
      <section class="properties-panel dimension-style-panel" id="dimension-style-panel" hidden>
        <header><strong>Dimension Style</strong><button id="dimension-style-close" title="Close">×</button></header>
        <form class="properties-content" id="dimension-style-form">
          <label class="property-row"><span>Text height</span><input id="dimension-text-height" type="number" min="0.1" step="0.1"></label>
          <label class="property-row"><span>Arrow size</span><input id="dimension-arrow-size" type="number" min="0.1" step="0.1"></label>
          <label class="property-row"><span>Arrow type</span><select id="dimension-arrow-type"><option value="closed">Closed filled</option><option value="open">Open</option><option value="tick">Architectural tick</option></select></label>
          <label class="property-row"><span>Extend beyond</span><input id="dimension-extension-beyond" type="number" min="0" step="0.1"></label>
          <label class="property-row"><span>Offset from object</span><input id="dimension-extension-offset" type="number" min="0" step="0.1"></label>
          <label class="property-row"><span>Text offset</span><input id="dimension-text-offset" type="number" min="0" step="0.1"></label>
          <label class="property-row"><span>Precision</span><input id="dimension-precision" type="number" min="0" max="8" step="1"></label>
          <label class="property-row"><span>Scale</span><input id="dimension-scale" type="number" min="0.01" step="0.1"></label>
          <label class="property-row"><span>Layer</span><select id="dimension-layer"></select></label>
        </form>
      </section>
    </footer>
    <section class="command-panel">
      <div class="command-resize-handle" id="command-resize-handle" title="Drag to resize command history"></div>
      <div class="command-log" id="command-log"></div>
      <form class="command-input-row" id="command-form">
        <label class="command-prompt" id="command-prompt" for="command-input">Command:</label>
        <input class="command-input" id="command-input" autocomplete="off" autofocus />
        <div class="command-suggestions" id="command-suggestions" hidden></div>
      </form>
    </section>
  </main>
  <div class="context-menu" id="grip-menu" hidden>
    <section class="one-shot-snaps">
      <div class="context-menu-title">Object snap override</div>
      <button data-grip-mode="mid2p">Mid between 2P</button>
      <button data-grip-mode="end">Endpoint</button>
      <button data-grip-mode="intersection">Intersection</button>
      <button data-grip-mode="apparent-intersection">Apparent intersection</button>
      <button data-grip-mode="center">Center</button>
      <button data-grip-mode="perpendicular">Perpendicular</button>
    </section>
    <section class="persistent-snaps">
      <div class="context-menu-title">Running object snaps · F3</div>
      <button data-persistent-snap="end">Endpoint</button>
      <button data-persistent-snap="middle">Midpoint</button>
      <button data-persistent-snap="center">Center</button>
      <button data-persistent-snap="intersection">Intersection</button>
      <button data-persistent-snap="apparent-intersection">Apparent intersection</button>
      <button data-persistent-snap="perpendicular">Perpendicular</button>
    </section>
  </div>
  <section class="text-options" id="text-options" hidden>
    <strong>Text style</strong>
    <label>Font
      <select id="text-font">
        <option value="Arial">Arial</option>
        <option value="Helvetica">Helvetica</option>
        <option value="Verdana">Verdana</option>
        <option value="Times New Roman">Times New Roman</option>
        <option value="Courier New">Courier New</option>
      </select>
    </label>
    <label>Height (mm)
      <input id="text-height" type="number" min="0.1" step="0.5" value="2.5" />
    </label>
    <button id="text-options-continue" type="button">Specify insertion point</button>
  </section>`;
}
