# MyCAD backlog

Only open work belongs here. Completed features and obsolete implementation
notes are removed rather than kept as a history log. The order is the proposed
implementation order: modelling capability first, then the workflow needed to
use it comfortably, then structural and interoperability work.

---

## 1. Make pointer interaction testable outside `main.ts`

`main.ts` is about 2,000 lines and remains the easiest place for interaction
regressions to hide. Frame coalescing and several interaction services are
already extracted; the next boundary is the remaining pointer-move orchestration.

In order:

- move pointer-move decisions into a controller with explicit inputs and
  outcomes, leaving `main.ts` to execute them;
- introduce a small `Panel { isOpen, render() }` contract for tree, properties,
  layers and settings instead of hand-written subscriber branches;
- centralise the repeated global "click outside" listeners;
- remove the obsolete `data-view-action` handler and unused `curvePoints` and
  `solidBounds` imports.

Related command-runtime debt:

- `ActiveCommand.data` is still `Record<string, unknown>`; a generic data type
  would turn misspelled state keys into build errors;
- repeating command steps are encoded indirectly instead of having an explicit
  `repeat` property;
- JOIN still needs its documented complete-on-start special case.

The command registry itself is no longer an open refactor: commands already
dispatch through their definitions and `advanceStep` is only a small guard.

---

## 2. DXF interoperability

ASCII DXF import and export both exist. Export covers current 2D entities,
layers, colours, line types and line weights; dimensions are decomposed into
ordinary drawing geometry because native DXF dimensions require block records.

### Import priorities

| Entity or fidelity item | Remaining work | Effort |
|---|---|---|
| **INSERT / blocks** | Add block definitions plus transformed references to `Document`. This is the largest real-world import gap. | Large |
| **HATCH** | Add a filled/boundary-path entity and renderer support. Reuse the existing face-region loop model where practical. | Large |
| **POINT** | Add a bare point entity, picking, snaps, properties and rendering. | Small |
| **3DFACE** | Needs a non-watertight surface object; importing it as a `Solid` would make booleans falsely appear supported. | Medium |
| **Angular/ordinate dimensions** | Add dimension kinds and their geometry before mapping DXF types 2, 5 and 6. | Medium |
| **DIMSTYLE fidelity** | Read arrow size, text height, precision and other style data instead of applying the current document style. | Medium |

Known import fidelity limits that remain:

- overridden dimension text (DXF code 1, such as `25 TYP`) is dropped;
- polyline bulge arcs are expanded into straight segments;
- general NURBS splines are sampled; only one clamped cubic maps exactly to a
  Bezier entity;
- MTEXT is flattened to an unformatted line and should at least count as an
  approximation in the import report;
- entity Z is flattened because drawing entities are 2D inside a work plane;
- only ASCII DXF is supported;
- `pairsFromText` assumes perfect two-line code/value pairing and cannot report
  a desynchronised malformed file precisely.

### Export follow-up

Native semantic dimensions would require BLOCKS plus DIMENSION records. Do this
with block support rather than creating an export-only block model.

---

## 3. Further solid-modelling features

These can now build on the shared planar-face and boundary-loop representation.

### Delete an arbitrary face and heal the body

Removing CHAMFER/FILLET features is already reversible. What remains is deleting
a face from an imported or otherwise baked mesh. Adjacent analytic surfaces must
be extended and intersected to close the body; deleting triangles is not enough.
Start with planar faces and reuse the existing face representation.

### Persistent SLICE feature

SLICE currently produces two correct capped mesh bodies. A future feature-tree
version could retain the cutting plane and offer keep-both/keep-side choices.
This is useful but lower priority because the existing command is already usable.

### Loft and freeform surfaces

A loft through a sequence of profiles is the smallest useful step toward organic
modelling. It is large and should wait until freeform modelling becomes a real
goal; the current engine is intentionally CSG-oriented.

### Editable sweep inputs

A sweep stores its profile and path but the model tree cannot replace either
with another entity. This needs a geometry-picker control in panels, not another
numeric field.

SECTION remains deferred until drawing views exist. It is a non-destructive view
cut with caps and section edges, not a modelling operation like SLICE.

---

## 4. Entity extensibility and drafting workflow

Adding an entity type still touches many switches and `if (entity.type === …)`
chains. Exhaustive core switches catch some omissions, but grips, snaps and 3D
window outlines can silently miss a new type.

- Introduce entity traits for bounds, points, segments, grips, snap candidates,
  drawing and properties.
- Move the 3D window-selection outline sampler into the same trait system.
- Extend object-snap tracking to follow configured polar angles, not only
  horizontal and vertical paths.

Remaining F-key workflow:

| Key | Open work |
|---|---|
| F1 | Bind the existing HELP command. |
| F2 | Expand/collapse the resizable command-history panel. |
| F4 | Decide whether 3D snaps need a separate toggle; solid edge, centre and perpendicular candidates already work in 3D. |
| F5 | Isoplane cycle; large and currently low value. |
| F12 | Dynamic input near the cursor; the existing dimension toast is not editable input. |

Drafting values are saved per drawing. There is still no application-level
preferences store for defaults such as "my snap step is always 0.5". Decide this
before the first release. `snapEnabled`, snap/grid sizes and the other drafting
toggles also live in two different document structures; consolidate them only
with a file-format migration.

---

## 5. Performance — measure before changing architecture

The reported orbit stutter remains unconfirmed. Establish first whether it is
sphere/high-triangle specific or affects simple boxes too, using a three-second
Performance recording and Bottom-Up self time. Frame requests already coalesce
through `requestAnimationFrame`, so old notes blaming queued redraw calls no
longer apply.

Current candidates, only if profiling points at them:

- picks, window selection and bounds scans have no spatial index;
- intersection snap is O(entity pairs × segment pairs) and performs work-plane
  transforms inside the nested loops on every relevant pointer move;
- `entityRenderKey` serialises each mutable entity with `JSON.stringify`;
- Manifold booleans run synchronously on the main thread after async WASM init.

Measured reference costs were roughly 0.12 ms for measurement candidates and
300–400 ms for large one-off sweep/union operations. A worker is not justified
until real models show longer blocking operations.

---

## 6. Project format and robustness before release

Do this before the first release or as soon as drawings become worth preserving,
whichever comes first. Parametric `Solid.feature` data is part of the native
model and must survive migrations.

- introduce explicit project DTOs instead of serialising live entities;
- add version migrations instead of rejecting every version except 1;
- validate entities on load instead of blind casting;
- avoid pretty-printed raw mesh floats making large files enormous;
- bound or reset Electron's session-wide `writableFiles` set;
- escape `<` as well as `&` and `"` in layer names inserted through `innerHTML`.

---

## 7. Output, text and dimensions

### G-code

Settings, layer ordering and single-stroke text paths are available. Remaining:

- retain circular geometry long enough to emit G2/G3 instead of only G1
  segments;
- optionally support different feed/depth settings per layer;
- add tool-radius compensation only if router use becomes a goal. The current
  centreline path is correct for pens and lasers.

### Text

- render text in 3D using the existing stroke polylines on the work plane;
- add glyph coverage beyond ASCII so Czech characters do not disappear;
- measure stroke-font bounds exactly; system-font bounds remain an estimate.

### Dimensions

- add angular and ordinate dimension kinds;
- import DIMSTYLE details;
- preserve overridden dimension text.

---

## 8. Manifold dependency and CSP

The browser CSP still needs `unsafe-eval` because manifold 2.5.1's Emscripten
embind creates invokers with `new Function`. Tightening the policy without
changing the build breaks every boolean, extrusion and sweep while Node tests
continue to pass.

The real fix is a manifold build with `-sDYNAMIC_EXECUTION=0`, either vendored or
supported upstream. Evaluate that together with a manifold upgrade as a separate
job: newer releases have API differences and a smaller WASM payload.

---

## 9. Housekeeping

- no ESLint, Prettier or CI; tests and `tsc` are run manually;
- `noUnusedLocals` and `noUnusedParameters` are disabled;
- no README;
- `Document` exposes mutable public fields and can bypass command history;
- `Document.getEntity` is a linear scan;
- layers are parallel arrays/maps/sets maintained by convention;
- `createX` factories are inconsistent about whether they mutate the document.
