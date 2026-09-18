# Refactoring plan

This plan records incremental refactoring opportunities identified in the
current codebase. Its purpose is to reduce duplicated knowledge and improve
consistency without changing observable CAD behaviour or blocking feature work.

Refactoring should be delivered in small changes. Existing behaviour must be
covered by characterization tests before implementations are consolidated.

## Progress

### 2026-09-13 — entity rotation consolidated

Status: **completed and verified**.

- Added `src/core/entities/EntityTransform.ts` as the shared implementation of
  drawing-entity rotation.
- Removed the duplicate per-entity rotation switches from the ROTATE command
  and `PreviewController`; command execution, polar arrays and live previews now
  use the same function.
- The shared implementation covers MLINE and HATCH, all dimension placement
  points, and orientation metadata for ellipses, arcs, hatches, text,
  dimensions and inserts.
- Rectangle rotation still intentionally produces a closed polyline, but no
  longer needs a `Document` factory.
- Added regression coverage for 3D Bezier elevation, dimensions, hatch pattern
  vectors and rectangle conversion.
- Verification: TypeScript check passed; the full suite passed with 100 test
  files and 1320 tests.

Remaining in the transformation phase: consolidate scaling (including the
duplicate feature-tree implementation), then assess whether translation and
mirroring need public core operations beyond `transformEntityPoints()`.

### 2026-09-13 — entity scaling consolidated

Status: **completed and verified**.

- Added pure `scaleEntity()` beside `rotateEntity()` in
  `src/core/entities/EntityTransform.ts`.
- The SCALE command and embedded loft feature transformation now consume the
  same implementation; the duplicate switch in `featureTransform.ts` was
  removed.
- Command selection and embedded work-plane placement remain caller concerns,
  so the core transform has no UI or feature-tree side effects.
- Scaling now covers geometry-dependent values that the duplicated
  implementations both omitted: HATCH spacing and pattern vectors, MLINE
  offsets and dimension display scale.
- Added regression coverage for 3D Bezier elevation and the derived HATCH,
  MLINE and dimension values.
- Verification: TypeScript check passed; the full suite passed with 101 test
  files and 1329 tests.

Remaining in the transformation phase: audit translation and mirroring for
duplicated entity semantics. Extract public core operations only where they
replace real duplication; `transformEntityPoints()` remains the lower-level
point mapper.

### 2026-09-13 — entity-to-kernel paths and profiles extracted

Status: **completed and verified**.

- Added `src/core/geometry/EntityKernelGeometry.ts`, deliberately in the
  geometry layer so entity definitions do not depend on OpenCascade or kernel
  vocabulary.
- Extracted the renderer-independent conversion of lines, polylines, analytic
  arcs/circles and Bezier chains to `SweepPathSegment3` values.
- Extracted closed entity conversion to exact sweep/loft profiles.
- `ExactSolid.ts` now consumes these shared conversions for SWEEP, LOFT, guided
  loft rails/guides and curved-profile extrusion instead of owning another
  entity-type switch.
- Every point conversion explicitly carries the optional elevation through its
  work plane; arcs and circle profiles now follow the same rule as Bezier and
  polyline points.
- Added pure tests for elevated Bezier poles, analytic arcs and closed/open
  Bezier profiles, without loading OpenCascade.
- Verification: TypeScript check passed; the full suite passed with 102 test
  files and 1336 tests.

Remaining in the kernel phase: evaluate the specialized extrusion conversion
before sharing it, then connect canonical display paths only where doing so does
not replace analytic kernel geometry with tessellation.

### 2026-09-14 — basic entity reshape grips consolidated

Status: **completed and verified**.

- Added `src/interaction/EntityGrips.ts` with the shared basic grip layout and
  reshape operation for lines, circles, polylines, Bezier chains and arcs.
- Ordinary document entities and entities embedded in loft profiles,
  rails/guides or paths now use the same indices and editing implementation.
- Optional point elevation is preserved for line/polyline/Bezier edits and for
  circle/arc centers and rim grips; an explicitly elevated axis-drag cursor
  still overrides the previous value.
- Closed polyline editing keeps the first and repeated closing vertex in sync.
- Midpoint/whole-edge grips, arc sagitta reshaping, ellipse, rectangle and
  dimension grips remain intentionally specialized in `GripController` because
  embedded loft members do not expose the same interaction set.
- Added direct regression tests for grip indices, spatial rim grips, elevation
  preservation and closed-polyline editing.
- Verification: TypeScript check passed; the full suite passed with 104 test
  files and 1370 tests.

Remaining in the grip phase: assess whether ellipse/rectangle helpers are
reusable without forcing embedded loft members to expose inappropriate grips;
otherwise retain them as controller-specific extensions and move to canonical
paths/bounds.

### 2026-09-14 — ellipse and rectangle reshape grips consolidated

Status: **completed and verified; grip phase closed**.

- Ellipse center/axis grips and their rotated-axis resizing now use the shared
  `EntityGrips` implementation for ordinary and embedded entities.
- Rectangle corner construction and corner reshaping are shared, including
  optional elevation on all four displayed corners.
- Embedded ellipse and rectangle profiles now reshape through their visible
  basic grips instead of falling back to moving the entire profile regardless
  of which grip was dragged.
- Rectangle center movement and four mid-edge stretches, arc sagitta reshaping,
  and dimension grips remain controller extensions because their interaction
  semantics do not apply to loft members.
- Added direct tests for elevated rectangle grip placement, rotated ellipse
  resizing and fixed-opposite-corner rectangle reshaping.
- Verification: TypeScript check passed; the full suite passed with 104 test
  files and 1373 tests.

No further grip refactoring is planned before user-facing grip behaviour changes.
The next independent phase is canonical paths/bounds and picking.

### 2026-09-14 — canonical line/polyline paths and bounds

Status: **completed and verified; first path/bounds migration complete**.

- Added `src/core/entities/EntityGeometry.ts` as the UI-independent owner of
  canonical display paths and path-derived bounds for lines and polylines.
- Canvas drawing, Three.js entity construction, projected viewport picking,
  window selection, command hit testing and the export-oriented `entityToPaths()`
  API now consume the same line/polyline path instead of rebuilding it locally.
- Polyline bulge segments are expanded once through `polylineOutline()`, so
  drawing, picking, exporting and bounds all see the same curved outline and
  the same closed/open semantics.
- Exact solid/kernel conversion remains analytic and deliberately does not use
  these sampled display paths.
- Added direct regression coverage for lines, closed polylines, bulged-polyline
  extents and finite empty-polyline bounds.
- Verification: TypeScript check passed; the full suite passed with 105 test
  files and 1410 tests.

Next in the path/bounds phase: migrate circles and ellipses while retaining
their analytic rendering and hit tests. Arcs and Beziers follow only with an
explicit shared quality/tolerance policy.

### 2026-09-17 — canonical circle/ellipse paths and bounds

Status: **completed and verified**.

- Extended `EntityGeometry.ts` with canonical sampled display/export paths for
  circles and rotated ellipses, including optional elevation carried by their
  centre and an explicit segment count at each quality-sensitive call site.
- Path export, projected window selection and Three.js construction now use
  that shared sampling. Canvas continues to draw both types analytically.
- Circle and rotated-ellipse bounds remain exact analytic calculations rather
  than depending on sampled display points. Circle outline hit testing and
  ellipse containment also remain analytic; this migration does not turn
  stored analytic entities into polylines.
- Removed four duplicate circle/ellipse sampling implementations and two
  duplicate bounds formulas. No consumer `case` labels were removed in this
  incremental migration; their dispatch responsibilities remain distinct.
- Added direct coverage for sampling density, closed paths, off-plane Z and
  exact rotated-ellipse bounds.

Next in the path/bounds phase: define the shared curve quality/tolerance policy
before migrating arcs and Beziers. Do not migrate them using an unexplained
fixed segment count.

### 2026-09-17 — canonical arc/Bezier paths, quality and exact bounds

Status: **completed and verified**.

- Added an explicit `GeometryQuality` contract with curve tolerance, minimum
  segments and a safety ceiling. Numeric segment counts remain supported for
  plot/G-code callers that intentionally request a fixed budget.
- Arcs choose their tessellation from radius, sweep and permitted chord error.
  Cubic Bezier chains subdivide adaptively and retain every segment join plus
  optional per-control-point elevation.
- Display/export paths, projected picking, Three.js construction, command hit
  testing and SVG arc output now consume the canonical curve paths. Native
  Canvas and SVG cubic Beziers remain analytic.
- Arc bounds are exact over endpoints and included cardinal angles. Bezier
  bounds are exact over endpoints and derivative roots, independent of display
  quality. Exact kernel geometry remains entirely separate from tessellation.
- Removed seven duplicate curve-sampling call sites and one sampled bounds
  implementation. No consumer `case` labels were removed; the remaining
  dispatch branches still own distinct rendering, picking or export policy.
- Added direct tests proving tolerance changes density, Z survives sampling,
  and arc/Bezier bounds retain analytic extrema.
- Verification: TypeScript check passed; the full suite passed with 113 test
  files and 1662 tests.

Next in §1: migrate the remaining specialised path-producing entity types only
where they duplicate geometry, then remove obsolete helpers/switch bodies.
Snap-specific endpoint/intersection logic must remain definition-based rather
than being replaced by display samples.

## What this plan is for: four bugs it would have prevented

The duplication below is not hypothetical. Each of these was found in use, in
one week, and each is the same fault: two places that both know what an entity
is, drifting apart.

- **A spline's endpoint did not exist for Endpoint snap.** `addEntityEnds` read
  a curve's ends as `curvePoints(entity, 2)`, whose resolution is for the whole
  curve rather than per segment — so from three segments up, index 2 is an
  interior joint and the real end was never offered. Sampling density as a
  correctness bug, which is exactly what §1's quality policy is about.
- **LOFT flattened its own rails.** `exactSweepPath` built every rail point with
  `localToWorld(plane, point)`, whose elevation argument defaults to zero, so a
  genuinely 3D spline entered the kernel flat while the guides did not. The
  surface collapsed.
- **SWEEP read a profile's position as an offset.** `exactSweepProfile` mapped
  the profile's own local x and y into the cross-section plane, so a circle
  drawn where it belongs — on the start of its path — was swept from that far
  off the spine. On gentle paths it silently built the solid in the wrong place.
- **MIRROR flattened a 3D curve.** Entity transforms ran points through helpers
  returning `{x, y}`, dropping any elevation. It applied to move, copy, rotate
  and scale as much as to mirror.

Two of those four live in `ExactSolid.ts` — a layer the first draft of this
plan did not list at all, which is itself the argument for listing it (§1).

## Goals

- Keep rendering, picking, snapping, bounds, transformations and exports
  consistent for every entity type.
- Reduce the number of parallel switch statements required by a new entity.
- Share repeated command and input mechanics while keeping tool-specific
  geometry explicit.
- Reduce repeated settings-form infrastructure.
- Split large modules only after useful shared abstractions exist.

## Non-goals

- Do not redesign the whole entity data model in one change.
- Do not introduce a global registry coupled to UI, rendering and I/O.
- Do not replace analytic geometry with sampled display geometry.
- Do not mix refactoring with unrelated feature changes.
- Do not change project/DXF formats or command behaviour implicitly.

## 1. Canonical entity geometry

### Problem

Knowledge about entity types is repeated across nine modules. The counts are
`entity.type` comparisons and `case` labels, as a rough measure of how much each
one would have to learn about a new entity type:

| Module | Branches | Knows about |
|---|---|---|
| `src/render/Viewport.ts` | 95 | Canvas and Three.js rendering, picking |
| `src/core/entities/types.ts` | 67 | bounds, points, transformations |
| `src/interaction/GripController.ts` | 50 | grip layouts and grip edits |
| `src/interaction/SnapService.ts` | 40 | snap candidates |
| `src/interaction/PickingService.ts` | 21 | projected outlines |
| `src/core/geometry/ExactSolid.ts` | 21 | entity → exact kernel geometry |
| `src/io/DxfExport.ts` | 17 | DXF export |
| `src/core/entities/paths.ts` | 14 | drawable paths |
| `src/render/SvgExport.ts` | 14 | SVG export |

`src/core/commands/CommandManager.ts` holds 2D hit testing on top of these.

This allows drawing, picking and snapping to use different sampling densities or
selection semantics.

Two of these deserve naming because they are where the known faults came from,
and because neither is an obvious place to look:

- **`GripController`** carries the per-type layouts twice: `activeGrips()` and
  `updateEntity()` for a selected entity, and `gripsForEmbeddedEntity()` and
  `applyEmbeddedEntityGripDrag()` for the same types embedded in a Surface's
  loft feature. A rule added to one has to be added to the other by hand, and
  twice this week it was not. Grips are also where a new entity type fails most
  quietly — it simply cannot be edited.
- **`ExactSolid.ts`** converts entities into kernel geometry (`exactSweepPath`,
  `exactSweepProfile`, `bezierWireEdges`) with no relation to the paths the
  renderer or the snap service build from the same entities. Two of the four
  bugs above were this layer disagreeing with the rest about what a point is.

A third pair worth folding in: transformations exist as
`transformEntityPoints()` in `types.ts` and `rotateEntity()` in
`steps/transform.ts`, one a generic point map and the other a per-type switch.
The elevation bug had to be fixed in both.

### Proposal

Introduce small, UI-independent modules:

```text
src/core/entities/geometry/
  EntityPaths.ts
  EntityBounds.ts
  EntityHitTest.ts
  EntityTransform.ts
  EntitySnapPoints.ts
  EntityGrips.ts        // grip layout and grip edits, today in GripController
  EntityKernelGeometry.ts // entity → kernel wires, today in ExactSolid
```

**Most of this is not new code.** `entityBounds()`, `getEntityPoints()` and
`transformEntityPoints()` already exist in `types.ts`, and `hitTestEntity()` in
`CommandManager.ts`. Moving them into new files changes nothing on its own: the
work — and the entire benefit — is making the nine modules above consume them
instead of their own copies. A migration that stops after the move leaves a
tenth switch behind and a plan that looks finished.

Candidate contracts:

```ts
interface GeometryQuality {
  curveTolerance?: number;
  minimumSegments?: number;
}

interface EntityPath {
  points: Vec2[];
  closed: boolean;
}

function entityPaths(entity: Entity, quality?: GeometryQuality): EntityPath[];
function entityBounds(entity: Entity): Bounds;
function hitTestEntity(entity: Entity, point: Vec2, tolerance: number): boolean;
function transformEntity(entity: Entity, transform: EntityTransform): Entity;
function entitySnapPoints(entity: Entity, context: SnapContext): SnapCandidate[];
```

Analytic entities must remain analytic. For example, consuming sampled circle
paths in a renderer must not convert the stored circle to a polyline.

### Migration order

Ordered by where drift has actually caused faults, not by what is easiest to
move. Lines and polylines are the safest starting point and the least valuable
one: nothing has ever gone wrong there.

1. Add characterization tests for Beziers and arcs across all consumers —
   paths, bounds, snap points, grips, kernel conversion — pinning the sampling
   density and elevation handling each one currently uses. Curves are where
   every known fault has been.
2. Consolidate **transformations** first (`transformEntityPoints` and
   `rotateEntity`): one pair, a clear contract, and elevation handling proven
   by an existing regression.
3. Consolidate **kernel conversion** (`ExactSolid`'s per-type paths) against the
   same point contract. Two of the four bugs were here, and it is the layer
   with no tests of its own beyond whole-command ones.
4. Consolidate **grips**, collapsing the standalone and loft-embedded pairs into
   one layout and one edit per type.
5. Move paths and bounds for lines and polylines behind the shared API.
6. Move circles and ellipses while retaining analytic hit tests.
7. Move arcs and Beziers with an explicit quality/tolerance policy — see the
   spline endpoint fault: a curve's ends must come from its own definition, not
   from a sampling whose resolution is a whole-curve budget.
8. Add specialized handling for text, dimensions, hatches and inserts.
9. Remove old switches only after all consumers have migrated.

## 2. Unified picking primitives

### Problem

Selection geometry is independently represented by `hitTestEntity()` in
`CommandManager.ts`, `entityOutline()` in `PickingService.ts`, and projected
picking code in `Viewport.ts`. This can make visible objects hard to select or
cause 2D and 3D selection to behave differently.

### Proposal

Expose renderer-independent primitives:

```ts
type PickPrimitive =
  | { kind: 'point'; point: Vec3 }
  | { kind: 'curve'; points: Vec3[]; closed: boolean }
  | { kind: 'region'; loops: Vec3[][] };
```

Both viewports consume the same primitives. Projection and screen tolerance
remain viewport concerns. Filled-region and boundary selection remain explicit
policies rather than side effects of a bounds test.

### Required tests

- Equivalent locations select the same entity in 2D and 3D.
- Work-plane transforms do not displace picking geometry.
- Hatch holes are excluded from filled-region picking.
- Curve tolerance behaves consistently in screen space.
- Testing expanded insert contents still returns the parent insert.

## 3. Repeating point command step

`POLYLINE`, `MLINE`, `SPLINE` and `AREA` repeat the same interaction state:

- append a point and update the tracking origin;
- advance after the first point and remain on subsequent points;
- finish on Enter;
- require a minimum point count;
- optionally close through a keyword or the first point.

Add a reusable command step such as:

```ts
repeatPointStep({
  storage: 'vertices',
  minimum: 3,
  allowKeywordClose: true,
  closeOnFirstPoint: true,
  onFinish(points, run) {
    // Command-specific result.
  },
});
```

Only interaction mechanics should be shared. MLINE styles, spline fitting,
entity creation and AREA calculation remain inside their commands. Start with
`POLYLINE` and `MLINE`, then migrate `AREA`; migrate `SPLINE` only when the API
can represent its world-space point data cleanly.

## 4. Dynamic input session

The coordinate, length, rectangle and arc dynamic-input controllers repeat DOM
element interfaces, first-show focus, text selection, Tab traversal, Enter
confirmation and Escape cancellation.

Create a `DynamicInputSession` responsible for field lifecycle and keyboard
navigation. Specialized controllers should only define fields, parsing,
validation and geometric meaning. Preview calculations remain tool-specific.

## 5. Settings form binding

Settings controllers repeat the `input` listener, recursion guard, DOM lookup,
value assignment, numeric validation, default persistence, `doc.notify()` and
the external `changed()` callback.

Introduce a small helper rather than a general form framework:

```ts
class SettingsFormBinding {
  input(id: string): HTMLInputElement;
  set(id: string, value: unknown): void;
  number(id: string, fallback: number, rule: NumberRule): number;
  guardedApply(update: () => void): void;
}
```

Each controller continues to own the mapping between fields and `Document`.
Migrate two similar controllers first and evaluate before broader adoption.

## 6. Split large modules by responsibility

`Viewport.ts`, `ViewportPointerHandler.ts`, `types.ts`, `edit2d.ts` and `main.ts`
contain several responsibilities. Splitting them before the earlier shared
abstractions exist would mostly relocate duplicate code.

After the earlier phases, extract cohesive areas such as:

- Canvas entity drawing;
- Three.js entity construction;
- viewport overlays and previews;
- pointer gesture state machines;
- entity declarations versus geometry operations;
- edit commands versus shared edit utilities;
- application construction versus controller wiring.

Dependencies should continue pointing from UI and rendering into core, never
from core back into UI.

## Delivery strategy

Every refactoring change should:

1. characterize current behaviour with focused tests;
2. introduce one abstraction alongside the existing implementation;
3. migrate a limited set of types or consumers;
4. run type checking and the full test suite;
5. remove obsolete code only when no consumer remains;
6. avoid files concurrently owned by another active change where possible.

Suggested commit boundaries:

1. Characterization tests for curves across paths, grips, snaps and kernel
   conversion, plus picking and work planes.
2. One transformation path for entities.
3. One entity → kernel conversion.
4. One grip layout and edit per type, standalone and loft-embedded alike.
5. Canonical paths and bounds for simple entities.
6. Shared 2D/3D picking primitives.
7. Curved-entity geometry and quality policy.
8. Repeating point command step.
9. Dynamic input session.
10. Settings form binding.
11. Responsibility-based module splits.

## Validation gates

- TypeScript compilation and the full automated test suite pass.
- Drawing and picking agree on rotated and translated work planes.
- Snap points belong to the visible entity in world coordinates.
- Circles, ellipses, arcs and Beziers preserve their analytic types.
- A curve carrying per-point elevation stays bent: through drawing, grip edits,
  every transform, loft rails and sweep paths.
- DXF, SVG and G-code output do not change unintentionally.
- Large drawings do not regress in rendering or selection latency.

Performance-sensitive phases should be measured with a representative drawing
containing hundreds of Bezier segments. Avoid per-frame insert expansion and
repeated curve tessellation. Cache derived display geometry with explicit
invalidation when an entity or display-quality setting changes.

## Main risks

- A shared path representation accidentally becomes the source of truth for
  exact geometry.
- A point's elevation off its work plane is dropped in a shared helper, which
  flattens every 3D curve at once instead of in one command. Every point-mapping
  contract in this plan has to carry `Vec2 & { z?: number }` through explicitly,
  because the type system does not: the elevation travels as an ad-hoc property
  on a `Vec2`, so dropping it is silent.
- A work-plane transform is applied twice or omitted during migration.
- Cached geometry becomes stale after grips or property edits.
- Bounds-only picking selects large empty regions.
- An over-general command abstraction hides important CAD semantics.

Mitigate these risks through incremental migration and side-by-side tests of old
and new implementations before deleting old branches.
