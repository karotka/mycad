# MyCAD backlog

Only open work belongs here. Completed features and obsolete implementation
notes are removed rather than kept as a history log. The order is the proposed
implementation order: modelling capability first, then the workflow needed to
use it comfortably, then structural and interoperability work.

---

## 1. DXF interoperability

ASCII DXF import and export both exist. They cover current 2D entities, block
definitions and transformed INSERT references, layers, colours, line types and
line weights. Dimensions are still decomposed into ordinary drawing geometry.

### Import priorities

| Entity or fidelity item | Remaining work | Effort |
|---|---|---|
| **HATCH** | Add a filled/boundary-path entity and renderer support. Reuse the existing face-region loop model where practical. | Large |
| **3DFACE** | Needs a non-watertight surface object; importing it as a `Solid` would make booleans falsely appear supported. | Medium |
| **Ordinate dimensions** | Add X/Y/Z ordinate geometry before mapping DXF type 6. Angular dimensions already exist; native DXF types 2 and 5 still need import mapping. | Medium |
| **DIMSTYLE fidelity** | Read arrow size, text height, precision and other style data instead of applying the current document style. | Medium |

Known import fidelity limits that remain:

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

The block model now exists. Native semantic dimensions still need generated
dimension-picture blocks plus DIMENSION records that reference them.

---

## 2. Further solid-modelling features

These can now build on the shared planar-face and boundary-loop representation.

### Persistent SLICE feature

SLICE currently promotes old mesh bodies when necessary and produces two exact,
capped B-reps, but the result is intentionally stored as a baked shape. A future
feature-tree version could retain the cutting plane and offer keep-both/keep-side
choices. This is useful but lower priority because the existing command is
already usable.

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

## 3. Entity extensibility and drafting workflow

Adding an entity type still touches many switches and `if (entity.type === …)`
chains. Exhaustive core switches catch some omissions, but grips, snaps and 3D
window outlines can silently miss a new type.

- Introduce entity traits for bounds, points, segments, grips, snap candidates,
  drawing and properties.
- Move the 3D window-selection outline sampler into the same trait system.
- Extend object-snap tracking to follow configured polar angles, not only
  horizontal and vertical paths.

### Native editing shortcuts

- **Delete selection:** pressing Delete removes every selected entity and solid
  as one undoable edit. The shortcut must be ignored while an input, textarea or
  editable text is focused.
- **System clipboard:** Cmd/Ctrl+C copies the selected entities and solids in a
  versioned MyCAD clipboard format, Cmd/Ctrl+X copies and removes them as one
  undoable edit, and Cmd/Ctrl+V inserts independent copies with new IDs. Preserve
  layers, work planes and parametric solid feature trees; repeated paste should
  apply a small visible offset.

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

## 4. Performance — measure before changing architecture

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
- OpenCascade modelling runs synchronously on the main thread after async WASM
  initialisation. Move it into a geometry worker if profiling shows visible UI
  stalls.

Measured reference costs were roughly 0.12 ms for measurement candidates and
300–400 ms for large one-off modelling operations. A worker is not justified
until real models show longer blocking operations. The full OpenCascade build is
also a roughly 50 MB WASM asset; before distribution, produce a custom build with
only the used OCCT modules and verify the LGPL distribution obligations.

---

## 5. Project format and robustness before release

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

## 6. Output, text and dimensions

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

- automatically move dimension text or arrows outside when a short dimension
  cannot fit them between its extension lines;
- make dimensions associative, so references to entity points and solid edges
  update after the measured geometry changes;
- add ordinate dimension kinds;
- import DIMSTYLE details;

---

## 7. Housekeeping

- no ESLint, Prettier or CI; tests and `tsc` are run manually;
- `noUnusedLocals` and `noUnusedParameters` are disabled;
- no README;
- panel controllers still lack a shared `Panel { isOpen, render() }` contract;
- global "click outside" listeners are not centralised;
- the unused `data-view-action` listener remains after the zoom flyout replaced it;
- `ActiveCommand.data` is still `Record<string, unknown>` instead of
  command-specific typed state;
- repeating command steps are encoded indirectly instead of having an explicit
  `repeat` property;
- JOIN still needs its documented complete-on-start special case;
- `Document` exposes mutable public fields and can bypass command history;
- `Document.getEntity` is a linear scan;
- layers are parallel arrays/maps/sets maintained by convention;
- `createX` factories are inconsistent about whether they mutate the document.
