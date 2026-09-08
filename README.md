# MyCAD

AutoCAD-style 2D/3D CAD for macOS — Electron + TypeScript, with a canvas/Three.js
renderer and a command-line-driven workflow (type a command name or click its
toolbar icon; most commands accept the same abbreviations AutoCAD does, e.g.
`L` for LINE, `PL` for POLYLINE). No UI framework: the interface is built from
plain DOM controllers under `src/ui/`.

## Development

```bash
npm install
npm run electron:dev   # Vite dev server + the Electron shell, with hot reload
npm run dev             # renderer only, in a browser tab (no Electron, no MCP)
```

## Tests and typechecking

```bash
npm test                                    # vitest run
npx tsc --noEmit -p tsconfig.json           # renderer/core
npx tsc --noEmit -p tsconfig.electron.json  # Electron main/preload
```

## Building a Mac installer

```bash
npm run electron:build
```

Produces a `.dmg` and a `.zip` under `release/`. The build is unsigned (no
Apple Developer ID / notarization is configured). On Apple Silicon, macOS
usually refuses to open it at all — **"MyCAD is damaged and can't be
opened"** — rather than offering an "unidentified developer" bypass; that
message is misleading, the app isn't actually corrupt, it just isn't
signed. Clear the quarantine flag once and it opens normally:

```bash
xattr -cr /Applications/MyCAD.app
```

(Right-click → Open → Open sometimes works instead, but on arm64 it
usually doesn't for an ad-hoc build like this — go straight to `xattr`.)

This is expected and fine for installing on your own Mac; it isn't suitable
for distributing to other people without a paid Apple Developer ID.

## AI / MCP integration

MyCAD ships a local MCP server for agent-driven CAD work against the open
document — see [MCP.md](MCP.md).

## Roadmap

Open work (DXF fidelity, modelling gaps, etc.) is tracked in
[BACKLOG.md](BACKLOG.md).

## Command reference

Type a command name (or an alias) at the command line, or click its toolbar
icon. `TAB`/typing narrows suggestions; most drawing commands restart
themselves after finishing (press `Esc` or start another command to stop).

### Drawing (2D)

| Command | Aliases | What it does |
|---|---|---|
| `LINE` | `L` | draw line |
| `POLYLINE` | `PL`, `PLINE` | draw a connected polyline |
| `MLINE` | `ML` | draw a multiline (parallel lines) using the current MLSTYLE |
| `RECTANGLE` | `R`, `REC` | draw rectangle |
| `CIRCLE` | `C` | draw circle |
| `CIRCLE_DIAMETER` | `CD`, `CIRCLEDIAMETER` | draw circle by diameter |
| `ELLIPSE` | `EL` | draw ellipse |
| `POLYGON` | `P`, `POL` | draw regular polygon |
| `OCTAGON` | `OCT` | draw a regular octagon |
| `ARC` | `A` | draw arc by center, start point, end point |
| `ARC_SER` | `ASER` | draw arc by start point, end point, radius |
| `SPLINE` | `SPL` | draw a smooth curve through clicked points |
| `BEZIER` | `BEZ` | draw a spline by control points (does not pass through them) |
| `TEXT` | `T` | draw single- or multi-line text |
| `MTEXT` | `MT` | draw multi-line text with the on-canvas editor |
| `TEXTEDIT` | `ED`, `DDEDIT` | edit TEXT/MTEXT content, or a dimension's text override (also reachable by double-clicking the object) |
| `HATCH` | `HA` | hatch closed boundaries using the current Hatch settings |

### Multiline styles (MLSTYLE)

`MLINE` draws against the document's *current* named style (see the **MLSTYLE**
panel in the status bar): how many parallel lines, their offsets, and each
one's colour/linetype. Editing a style only affects multilines drawn with it
afterwards — it never reaches back into ones already on the drawing.

### Measurement and annotation

| Command | Aliases | What it does |
|---|---|---|
| `AREA` | `AA` | measure polygon area and perimeter |
| `MEASURE` | `D`, `DI`, `DIM`, `DIMENSION` | dimension the horizontal or vertical distance |
| `DIMALIGNED` | `DAL` | dimension the true distance between two points |
| `DIMANGULAR` | `DAN` | dimension the angle between two lines or three points |
| `DIMRADIUS` | `DR`, `DRA` | dimension a circle's or arc's radius |
| `DIMDIAMETER` | `DD`, `DDI` | dimension a circle's or arc's diameter |
| `QDIM` | `QD` | dimension a whole selection at once — one aligned dimension per side of a multi-sided shape (polyline/rectangle/octagon), a chained dimension along one axis for everything else |

### Edit and transform

| Command | Aliases | What it does |
|---|---|---|
| `MOVE` | `MO` | move in view plane |
| `COPY` | `CO`, `CP` | copy objects repeatedly |
| `SCALE` | `SC` | scale objects by a reference length, or a typed factor |
| `ROTATE` | `RO` | rotate objects around a base point |
| `MIRROR` | `MI` | mirror objects |
| `JOIN` | `J` | join connected 2D lines/arcs/Beziers/polylines into one polyline or spline |
| `MLCUT` | `MLC` | cut an open multiline into two at a point |
| `MLWELD` | `MLW` | weld two multilines sharing an endpoint into one (requires matching MLSTYLE layouts) |
| `MLCORNER` | `MLCO` | trim two crossing multilines back to their corner |
| `EXPLODE` | `X` | break compound objects into parts |
| `EXTEND` | `EX` | extend lines to boundaries |
| `TRIM` | `TR` | trim objects at cutting edges |
| `OFFSET` | `O`, `EQUID`, `EKVID` | create an equidistant parallel line |
| `SIMPLIFY` | `REDUCE` | reduce a polyline's vertex count within a tolerance |
| `CHAMFER` | `CHA` | chamfer a solid edge, or the corner between two 2D lines |
| `FILLET` | `F` | round a solid edge, or the corner between two 2D lines |
| `DELETEFACE` | `DF` | delete a solid face and heal the body |
| `ARRAY_RECTANGULAR` | `ARR`, `ARRAY`, `RECTARRAY`, ... | create a rectangular array |
| `ARRAY_POLAR` | `POLARARRAY`, `ARRAYPOLAR` | create a polar array |
| `ERASE` | — | delete object |
| `OPTIMIZEPATHS` | `OP` | refit and join curves using a geometric tolerance |
| `OVERKILL` | `OK` | delete objects that exactly duplicate another object's geometry |

### Blocks

| Command | Aliases | What it does |
|---|---|---|
| `BLOCK` | `B` | create a named reusable block from 2D objects and 3D solids |
| `INSERT` | `I` | insert a reference to a named block |
| `PURGEBLOCKS` | — | delete block definitions not reachable from anything placed in the drawing |

### 3D solids

| Command | Aliases | What it does |
|---|---|---|
| `BOX` | `BX` | draw a box primitive |
| `WEDGE` | `WE` | draw a wedge primitive |
| `SPHERE` | `SPH` | draw a sphere primitive |
| `CONE` | — | draw a cone primitive |
| `CYLINDER` | `CYL` | draw a cylinder primitive |
| `PYRAMID` | `PYR` | draw a pyramid primitive |
| `TORUS` | `TOR` | draw a torus primitive |
| `EXTRUDE` | `E`, `EXT` | extrude closed profile |
| `SWEEP` | `SW` | sweep profile along path |
| `PRESSPULL` | `PP` | modify a planar face region |
| `UNION` | `U`, `UNI` | join solids |
| `SUBTRACT` | `S`, `SUB`, `SUBSTRACT` | subtract solids |
| `INTERSECT` | `IN`, `INT` | keep the common volume of solids |
| `THREAD` | `THR` | add a cosmetic thread to a hole or shaft |
| `SLICE` | `SL` | split solids with a plane |
| `UCS` | — | define a user coordinate system |

### Export and print

| Command | Aliases | What it does |
|---|---|---|
| `EXPORTSTL` | `STL` | export selected 3D solids or 3D blocks to STL |
| `EXPORTSTEP` | `STEP` | export selected 3D solids or 3D blocks to STEP |
| `PRINTAREA` | `PLOT` | pick a window to print to PDF |

### View and system

| Command | Aliases | What it does |
|---|---|---|
| `VIEW2D` | `V2` | switch to the 2D view |
| `VIEW3D` | `V3` | switch to the 3D view |
| `ZOOM` | `Z` | zoom to extents or a window |
| `SNAP` | `SN` | toggle grid snap |
| `UNDO` | — | undo last edit |
| `REDO` | — | redo last edit |
| `HELP` | `?`, `H` | list all commands |
| `HIDEOBJECTS` | `HIDE` | hide selected objects |
| `ISOLATEOBJECTS` | `ISOLATE` | hide all but the selected objects |
| `SHOWALL` | `UNISOLATE` | show all hidden objects |
| `LAYCUR` | — | move selected objects to the current layer |
