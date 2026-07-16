# MyCAD backlog

Work that is deliberately deferred, with the reasoning behind each decision so it
can be picked up cold. Ordered roughly by value within each section.

Written in English to match the codebase; everything here was verified against the
code at the time of writing unless marked otherwise.

---

## DXF import

The importer now covers LINE, CIRCLE, ARC, LWPOLYLINE/POLYLINE (arcs via bulge),
TEXT, MTEXT, SPLINE and DIMENSION. What is left:

| Entity | Why it is deferred | Effort |
|---|---|---|
| **INSERT / blocks** | Needs a block concept in `Document`: a definition plus references with their own transform. Real AutoCAD drawings are largely blocks, so this is the biggest gap in practice — but it is a model change, not an importer change. | Large |
| **HATCH** | No entity for it. Needs a filled/boundary-path entity and renderer support. | Large |
| **POINT** | No entity type for a bare point. | Small |
| **3DFACE** | Genuinely 3D: a 3- or 4-corner flat face. Could become a `Solid` with `feature: { kind: 'mesh' }`, which already exists — but a face soup is *not watertight*, and our `Solid` assumes a closed body, so Manifold would reject it in a boolean. It would import for viewing and break on UNION/SUBTRACT. Also a legacy entity. | Medium |
| **DIMENSION: angular (types 2, 5) and ordinate (type 6)** | `DimensionEntity.dimensionKind` only has `aligned \| radius \| diameter`. Angular needs an arc dimension line and an angle readout; ordinate needs a leader. Both are new kinds in the model + renderer. | Medium |
| **Dimension refinements** | Style details from the file (DIMSTYLE: arrow size, text height, precision) are ignored; imported dimensions take the current document style. | Medium |

### Known fidelity limits in what *is* imported

These are reported to the user (`approximated` / `ignoredTypes`), not silent:

- **Overridden dimension text** (code 1, e.g. `25 TYP`) is lost — our dimension
  always renders its own measurement.
- **Polyline arcs** are expanded into segments; `PolylineEntity` holds straight
  segments only.
- **General NURBS splines** are sampled into a polyline. Only degree 3 with four
  control points and no weights maps exactly, onto `BezierEntity`.

Not yet reported, and inconsistent with the above:

- **MTEXT is flattened** to a single unformatted line (`\P` → space, formatting
  stripped) but is *not* counted in `approximated`. Either count it, or give
  `TextEntity` real multi-line support. Counting it is a few lines.

### Structural limits

- **Z is flattened.** Entities are 2D within a work plane, so any Z is dropped
  (reported). A true 3D line has no home in the model.
- **ASCII DXF only.** Binary DXF throws a clear error.
- **`pairsFromText` is positional.** It walks the file two lines at a time; one
  stray line desynchronises everything after it. A real DXF is always paired, but
  the parser has no way to notice if it isn't.

---

## DXF export

Missing entirely. Deferred until the import is good enough to be worth
round-tripping. The only export today is ASCII STL, which covers solids only —
a 2D drawing exports to nothing.

---

## Refactor: command registry

`src/core/commands/registry.ts` is now the single declaration of a command:
`CommandName` is *derived* from it, and aliases, autocomplete, help, sticky,
point-input, steps, `data`, `onStart` and `run` all come from the entry.
`startCommand` is down from 443 lines / 45 branches to 28 lines / 0 branches.

What remains:

- **`advanceStep` — 1033 lines, 40 branches.** The last big switch: each command's
  actual behaviour. It should become `execute` on the definition, migrated in
  batches the way the rest was. Once done, adding a command costs two places (the
  definition and an icon) instead of the 15 that TORUS needed.
- **JOIN's special case in `startCommand`.** The one command that can complete on
  start (enough preselected objects means nothing to ask), so it still needs an
  `if` in the manager. Documented in place.
- **`data: Record<string, unknown>`.** The per-run state is an untyped bag, which
  forces casts everywhere (`data.start as Vec2`) and makes a typo a silent
  `undefined`. A generic `ActiveCommand<TData>` would fix it.
- **`CommandStep` has no `repeat`.** POLYLINE's repeating vertex step is faked
  with `optional: true` plus "accumulate and return without advancing" — the same
  trick ARRAY uses. It works, but the step model should say so directly.

---

## Refactor: main.ts

**1893 lines, and the single largest source of bugs in this project.** Three
separate defects this session landed here and were invisible to both the type
checker and the tests, because nothing in `main.ts` is testable:

- the grip `angle` was dropped by a `map` that rebuilt the object field by field;
- ortho/tracking priority was wrong three times over;
- picking was fed the grid-snapped cursor instead of the real one.

Every one of them would have failed instantly in a tested layer. Extracting this
is not cosmetic.

Candidates, in order:

- **`pointermove`** (~146 lines) — the last of the pointer handling still doing
  its own thinking. `pointerdown` now asks PointerGesture and ViewportAction and
  only carries out what they say.
- **`Panel` interface `{ isOpen, render() }`** — three controllers already
  implement it informally; the subscriber has a hand-written `if` per panel.
- **One "click outside" manager** — there are seven separate global `pointerdown`
  listeners doing the same thing.

### Dead code in main.ts (verified)

- **`data-view-action` handler** (~21 lines) never runs: no element in the shell
  carries that attribute. Three `querySelector` calls against it are no-ops
  (lines ~342, ~1394, ~1847). `activateZoom()` is a working duplicate of it.
- **Unused imports**: `curvePoints`, `solidBounds` — zero uses. `tsc` does not
  catch these because `noUnusedLocals` is off.

---

## Solid modelling: what is actually missing

Modelling the reference elephant was a probe of the solid engine, and it turned
up one missing capability, one primitive that cannot be expressed, and a
systemic hole. `scale` and the model tree are done; the rest is here.

### The feature tree is thrown away by half the app

**This is the biggest one, and the least visible.** A `Solid` keeps how it was
built in `feature`. Five places overwrite it with `{ kind: 'mesh' }`, and the
model history is destroyed and cannot come back. Three of them need not:

| Place | What bakes it | Could it be expressed instead? |
|---|---|---|
| `PropertiesController:162` | Any width/depth/height edit on a solid whose feature is not a bare primitive | **Yes**, mostly. See below. |
| ~~SCALE~~ | ~~`CommandManager:317`~~ | **Done** — `scaledFeature`. |
| ~~ROTATE~~ | ~~`CommandManager:342`~~ | **Done** — `rotatedFeature`. |
| `CommandManager:1364` | FILLET / CHAMFER | **No.** There is no fillet feature, and the mesh is cut by `modifySolidEdge`. A legitimate bake — or the beginning of a fillet feature. |
| `CommandManager:1730` | PRESSPULL **on a picked face** | **No** — an arbitrary face push is not a parameter of anything. |

They baked for the same reason: **the feature had nowhere to put the result**,
so the mesh was mutated and the history dropped. A move is the work plane's
origin, a rotation is its axes, a scale is `scale` — and none of that was true
when the code was written, which is why the comment saying it could not be done
was honest and stopped being true without anyone noticing.

What is left of it: a **resize of a boolean** in the properties panel. There is
no single work plane to move and "make this union 20% wider" is not a question
its operands can answer. Options: refuse it and point at the tree; or wrap the
root in a transform feature. Do not guess — pick one deliberately. A **sweep**
can be rotated (it is its work plane, like the rest) but not scaled: its size is
its profile and its path, which are shapes rather than numbers.

`PRESSPULL` already shows the pattern and is worth copying: on a picked face it
bakes, but on an extrusion it edits `feature.height` and regenerates
(`CommandManager:1731`). Express it where you can; bake only where you cannot.

`PropertiesController` also cannot regenerate anything but a primitive, because
`regenerateSolidFeature` is async for booleans (Manifold) and `updateSolid` is
sync. The model tree does it properly and is async throughout. So the properties
panel probably should not offer size fields for feature-backed solids at all.

### The CSP has to allow `unsafe-eval`, and should not have to

`index.html` allows `'unsafe-eval'` for one reason: manifold's Emscripten
bindings build their invokers with `new Function(args, body)`. embind composes
JavaScript out of strings from the type signatures it registers, so compiling
the WASM is not the part that needs permission and `'wasm-unsafe-eval'` alone is
not enough. Without it every boolean, extrusion and sweep throws on its first
call. Upstream still does this in 3.5.1, so upgrading does not fix it.

The real fix is a manifold build with `-sDYNAMIC_EXECUTION=0`, which makes
embind fall back to closures. That means building manifold from source and
vendoring it, or getting the option upstream. Until then the policy stays as it
is, and `csp.test.ts` pins the coupling — the tests run in Node, where there is
no policy to violate, so tightening the CSP breaks the app while every test
still passes. That is how this got shipped in the first place.

Worth doing at the same time: **manifold 3.5.1** is out (we are on 2.5.1) and
its WASM is 541 KB against our 916 KB. Its API differs; treat it as its own job.

### ~~No truncated cone~~ — done

`createConeMesh` takes a `radiusTop`: 0 is a cone, anything else a frustum, the
same value as `radius` a cylinder. `PrimitiveFeature.radiusTop` carries it, both
panels offer it, and the tree line says `r 10 → 4` — because two cones of one
radius can be different shapes. The elephant's trunk is four tapered cones now
rather than four capsules of one radius each pretending to taper.

### No loft, no freeform surface

The reference picture is a sculpted organic model. Everything here is a surface
of revolution plus booleans, so anything genuinely freeform is out of reach.
A loft through a stack of profiles would be the smallest useful step. Large, and
only worth it if organic modelling is actually a goal — CSG is a different craft.

### Primitives with no UI

`torus` is reachable from `TORUS` and now from the panels. Check the rest: the
lesson from `tubeRadius` is that a capability existing in `PrimitiveFeature` and
`ManifoldEngine` says nothing about whether anything can reach it.

### Sweep is a black box in the tree

`featureParams` returns nothing for a sweep, because its profile and its path are
shapes, not numbers. Editing it means picking a different entity — a different
kind of control than a number field. Deliberate; revisit when there is a way to
select geometry from a panel.

---

## Extensibility: entities

Adding an entity type still costs ~17 places across 11 files. The switches in
`core/entities/types.ts` are exhaustive via their return types, so they fail the
build — but `GripController` and `SnapService` use ~69 `if (entity.type === …)`
chains with no fallback, so a new entity silently gets no grips and no snaps.

- **Entity traits** — one object per entity (`bounds`, `points`, `segments`,
  `grips`, `snapPoints`, `draw`, `properties`) instead of scattered switches.
- **3D window select** — does not exist. Needs an entity outline sampler to
  project entities to screen (`getEntityPoints` returns only the centre for a
  circle), which is exactly what traits would provide. `SelectionController:71`
  has a latent bug waiting for it: the 3D path computes world coordinates via
  `renderer2d.screenToWorld`. Unreachable today because 3D never starts a
  selection window.
- **Object snap tracking follows horizontal/vertical paths only.** With Polar
  (F10) on, AutoCAD also tracks the polar angles. `alignmentPath` in
  `DraftingService` is the one function to extend.

---

## Performance

> **Open report, parked deliberately: the viewport stutters while orbiting** — and
> the reporter's own reading is that it may be **the sphere only**; box, cylinder
> and the rest were never tried. That is the first thing to establish, because it
> splits the problem in two: a sphere is ~550 vertices where a box is 8, so if it
> is sphere-only the cost is per-vertex and this list is where to look; if every
> solid does it, the cost is per-frame and fixed, and the list is wrong.
>
> Already ruled out **by measurement**, against the reported model (a sphere with
> a cylinder subtracted — 550 vertices, 1100 triangles):
> - `measurementCandidates` rebuilds every solid vertex per pointer move: **0.12 ms**.
> - Booleans block the frame, but only when one runs: **306 ms** for a sweep.
>
> Already changed, effect unconfirmed: `redraw` now coalesces into one
> `requestAnimationFrame`, the chrome only redraws when its inputs change, and
> `syncGrips` compares before rebuilding.
>
> **What would settle it:** a Performance recording of three seconds of orbit,
> range-selected, Bottom-Up by self time. Note that **INP is the wrong
> instrument** — it measures discrete interactions and ignores the continuous
> pointer moves an orbit is made of, so a green INP says nothing about this.

Nothing here is proven to bite yet, but all of it is O(n) or worse per frame:

- **No spatial index anywhere.** Every pick, window select and zoom-extents is a
  linear scan, and `entityBounds` is recomputed inside a sort comparator.
- **`intersectionCandidates` is O(n²) over entity pairs × O(m²) over their
  segments**, with a work-plane transform inside the inner loop — and it runs on
  every `pointermove` while intersection snap is on. Likely the first thing to
  make the UI stutter.
- **`entityRenderKey` is `JSON.stringify(entity)`**, computed per entity per
  frame as a dirty key. Solids already use a `revision` integer; entities should
  too.
- **Manifold runs on the main thread.** The API is `async`, but only the WASM
  init is awaited — the boolean itself is synchronous, so it blocks the frame.
  Measured, after this was first written as "freezes the UI for seconds" on no
  evidence at all: a circle swept along a circle (64 extrusions, then one union
  of 64) takes **306 ms**; a union of 64 spheres takes **378 ms**. That is a
  visible hitch on a one-off command, not a freeze, and nowhere near worth a
  worker yet. Revisit if a sweep along a long polyline, or a model with hundreds
  of parts, makes it minutes — the cost is per-operand, so it scales with the
  model.
- **`redraw()` is a full synchronous sync** on every pointer move, with
  `getElementById` calls in the hot path and no `requestAnimationFrame`
  batching.

---

## Robustness and file format

> **Decided: not now.** There are no drawings worth keeping yet, so nothing is at
> risk and there is nothing to migrate. The whole item below — versioning, the DTO
> boundary, load validation — waits.
>
> **Trigger to revisit: before the first release, or the first time a drawing is
> worth reopening.** Whichever comes first. Doing it while `.mycad` files still
> only live on one machine is cheap; doing it afterwards means writing migrations
> for shapes nobody designed.
>
> Parametric solids stay. `Solid.feature` is the model, not an optimisation, and
> no interchange format holds it — which is why DXF is the export path and not the
> native one.

- **`writableFiles` grows unbounded** for the session — after opening fifty
  files the renderer may write to all fifty until it quits.
- **`ProjectIO` serialises `doc.entities` directly** — the in-memory model *is*
  the file format, so any refactor of the entity types silently breaks saved
  files. Wants a DTO boundary.
- **`ProjectIO` has no migration path**: `version !== 1` throws. The first bump
  makes every existing file unopenable, and a newer file gives the same generic
  error as a corrupt one.
- **Entities are loaded with a blind cast** (`{ ...raw } as Entity`) with no
  validation, so a corrupt file crashes in the renderer rather than at load.
  Solids and settings *are* validated.
- **Meshes serialise as pretty-printed JSON numbers**, one float per line. A
  100k-vertex solid becomes tens of megabytes.
- **`LayerController`'s `escapeHtml` does not escape `<`** (`PropertiesController`'s
  does). Layer names reach `innerHTML` and can come from a `.mycad` or DXF file.
  CSP makes real XSS unlikely; it is still a hole in defence in depth, and the two
  copies should be one.

---

## Housekeeping

- **No ESLint, no Prettier, no CI.** 230 tests and a clean `tsc` are all enforced
  by hand today.
- **`noUnusedLocals` / `noUnusedParameters` are off** — see the dead imports above.
- **No README.**
- **`Document` exposes public mutable fields** and a global singleton
  (`export const document = new Document()`, which also shadows the DOM global).
  History can be bypassed: nothing forces a mutation through an edit.
- **`Document.getEntity` is a linear scan**, called per pick.
- **Layers are three parallel structures** (`layers[]`, `layerColors{}`,
  `hiddenLayers`) kept in sync by hand.
- **`createX` factories are inconsistent**: `createLine` returns a detached
  entity, while `createDimension` mutates the document (registering its style
  layer). That bit the DXF import, which had to snapshot and restore
  `doc.layers` to stay side-effect free.
- **GRID was removed** as a dead command (aliases `GR`/`GRID` resolved but the
  switch never handled it, and there is no grid visibility state to toggle). A
  real grid toggle would be a small feature: a field on `Document` plus renderer
  support.

---

## Drafting modes and F keys

We have three of AutoCAD's toggles wired to keys and to buttons in the status
bar: F3, F8, F10. The rest of the map, with what it would cost:

| Key | AutoCAD | Here |
|---|---|---|
| F1 | Help | HELP exists as a command; no key. Trivial. |
| F2 | Expanded command history | The command log panel exists and resizes; no key to expand it. Small. |
| **F3** | Object snap | **Done** — key and status button. |
| F4 | 3D object snap | No 3D object snap at all. Large. |
| F5 | Isoplane cycle | No isometric drafting mode. Large, low value for us. |
| F6 | Dynamic UCS | UCS exists as a command, but not the "hover a face to align" behaviour. Medium. |
| F7 | Grid display | **No grid visibility state** — the grid is always drawn. Needs a field on `Document` plus renderer support. This is also what the removed GRID command would have toggled. Small. |
| **F8** | Ortho | **Done** — key and status button. |
| **F9** | Snap mode (cursor stepping) | **Done** — key and status button. The step itself is still only settable in code (`doc.snapSize`); see below. |
| **F10** | Polar tracking | **Done** — key and status button. |
| **F11** | Object snap tracking | **Done** — key and status button. |
| F12 | Dynamic input | No dynamic input. The dimension toast is a different thing. Medium. |

### Settings are per drawing, not per application

`snapSize`, `gridSize` and the polar angles are saved into the `.mycad` file, so
they travel with it: open someone else's drawing and you get their snap step.
AutoCAD does the same, so this is a defensible default — but there is no
application-level settings store at all (localStorage only remembers which tool a
flyout last used), so "my step is always 0.5" has nowhere to live. Worth deciding
before the first release.

Note also that `snapEnabled`, `snapSize` and `gridSize` sit on `Document` while
the other drafting toggles live in `drafting`, which is why F9 needs its own
toggle function rather than going through `toggleDraftingMode`. Tidying that
touches the file format, so it waits with the rest of that item.

---

## Text: single-stroke fonts

> **Done for the plotter.** The Hershey simplex roman font ("rowmans") is
> vendored as data in `core/text/hersheyData.ts` — public domain, with the
> acknowledgement its licence asks for — and `strokeFont.ts` decodes it. Both the
> 2D renderer and `entityToPaths` draw from that one function, so what is on the
> screen is what the pen draws. `TextEntity.font` chooses: `Single-stroke` plots,
> and a system font is still filled and still reported as unplottable, which is
> the honest answer rather than a silent gap.

What is left:

- **No 3D text.** The 3D renderer has no text geometry at all, and now that
  glyphs are polylines it could have some cheaply — they are just polylines on
  the work plane.
- **One font, ASCII only.** Anything outside 32..126 is skipped, so `č` draws
  nothing. Hershey has cyrillic and a script face in the same format; the decoder
  takes them unchanged, and the data is one more file each.
- **DXF export of text** would want this too — it is the same reason: an outline
  is not a path a machine can follow.
- **`entityBounds` still guesses** for system fonts (`length × height × .62`).
  A stroke font measures itself exactly, so only the unplottable case is a guess.

---

## G-code export

> **Decided: a pen plotter. Slicing is a slicer's job and not this app's** —
> the earlier idea of reading PrusaSlicer's configuration and producing print
> G-code is withdrawn, along with the notes for it. One pass per visible
> layer, in layer order, from the 2D geometry. `GcodeExport.ts` does that today:
> `G28` first, points put back through `localToWorld` so the file agrees with the
> screen, geometry off the world XY plane refused rather than cut flat in the
> wrong place, and unsupported types reported rather than dropped quietly. Layer
> order is drag-to-reorder in the panel.

What is left, in the order it bites:

- **No settings dialog.** `exportGcode` runs on `DEFAULT_GCODE_OPTIONS` — feed
  800, travel 2400, cut depth 0, safe height 5. The options object and its
  plumbing exist; it needs a panel, and `DraftingSettingsController` is the shape
  to copy. Per-layer settings (a different depth or feed per pass) would be the
  step after, and would change `GcodeOptions` from one object to one per layer.
- **Text is skipped**, and reported as skipped. It needs single-stroke fonts,
  above: an outline font engraves the *outline* of each letter rather than the
  letter.
- **No arcs.** Everything curved is broken into `G1` segments. Real machines take
  `G2`/`G3`, which is fewer lines and a smoother path. `entityToPaths` throws the
  arc away by flattening; emitting arcs means keeping them.
- **No tool compensation.** The path runs along the geometry, which is exactly
  right for a pen and for a laser. A router would cut half a tool-width off on
  each side — only worth solving if this ever drives one.

---

## Dimensions: what is left

`linear` and `aligned` both exist now, and DXF types 0 and 1 map onto them
exactly. Still missing:

- **Angular (DXF types 2 and 5) and ordinate (type 6)** — new kinds, each needing
  geometry of its own: an arc dimension line and an angle readout, or a leader.
- **DIMSTYLE from the file** — an imported dimension takes the current document
  style; the arrow size, text height and precision in the file are ignored.
- **Overridden dimension text** (DXF code 1, e.g. `25 TYP`) — our dimension always
  renders its own measurement, so an override is dropped. Reported.
