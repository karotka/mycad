# Refactoring audit — 2026-09-17

A whole-system audit against `REFACTORING_PLAN.md`: where the plan stands, what
the numbers say now, and what it does not cover. Everything below was measured
on this tree at `67e994b` (311 commits, 130 of them in the last seven days);
the commands used are in each section so the numbers can be rerun.

## Summary

- The plan is sound and is being executed in order: transformations, kernel
  conversion, grips and line/polyline paths are done; circles and ellipses are
  in the working tree. Keep going. One thing to add: track **switches
  removed**, not modules added — today there are more entity-type branches
  than when the plan was written, which is expected mid-migration but only
  acceptable if step 9 actually runs.
- The plan covers one class of fault: two places that both know what an
  entity is. This week produced a second class it does not cover at all —
  **interaction state and defaults** — and it produced seven faults in one
  day, four of them in the same 1,500-line file. That is the main gap and the
  first recommendation below.
- Two large files are hot for a reason the plan's "split only after shared
  abstractions exist" rule does not apply to: `main.ts` is wiring, not
  duplicated logic, and `CommandManager.test.ts` is a 40-second, 438-test file
  that every command change appends to. Both can be split by moving code, now.

## 1. Where the plan stands

| Plan phase | Status | Evidence |
|---|---|---|
| §1.2 transformations | done | `EntityTransform.ts`, 16 branches |
| §1.3 kernel conversion | done | `EntityKernelGeometry.ts`, 8 branches |
| §1.4 grips | done, phase closed | `EntityGrips.ts`, 14 branches |
| §1.5 line/polyline paths, bounds | done | `EntityGeometry.ts`; consumers migrating in the working tree |
| §1.6 circles, ellipses | in progress | uncommitted changes in `Viewport.ts`, `PickingService.ts`, `CommandManager.ts`, `paths.ts` |
| §1.7–9 curves, specialised types, removal | not started | — |
| §2–6 | not started | — |

The plan's own metric, recounted (`grep -cE "\.type === '|\.type !== '|case '[a-z-]+':"`):

| Module | Plan | Now |
|---|---|---|
| `render/Viewport.ts` | 95 | 99 |
| `core/entities/types.ts` | 67 | 74 |
| `interaction/SnapService.ts` | 40 | 55 |
| `interaction/GripController.ts` | 50 | 49 |
| `core/commands/steps/edit2d.ts` | — | 49 |
| `io/DxfExport.ts` | 17 | 24 |
| `core/commands/CommandManager.ts` | — | 23 |
| `interaction/PickingService.ts` | 21 | 22 |
| new shared modules (4) | 0 | 39 |

Net, the tree holds roughly forty more entity-type branches than when the plan
was written. That is the shape of steps 2–5: the shared implementation is
added beside the old one and the old switch is only removed at step 9. It is
also exactly the risk the plan names — "a migration that stops after the move
leaves a tenth switch behind." Recommendation: add a line to each progress
entry stating how many branches were **removed** from the consumer modules,
and set a target for the table above (the four shared modules plus the
declarations in `types.ts`, and nothing else, is the honest end state).

`edit2d.ts` and `DxfExport.ts` were not in the plan's table and grew. Both
belong in it.

## 2. The class of fault the plan does not cover

Seven faults were found and fixed on 2026-09-17, each measured in the running
application before and after. Only one of them (dimensions absent from snap
candidates) is the kind §1 is about. The other six:

| Fault | Where | Root cause class |
|---|---|---|
| Perpendicular not a running snap | `settings.ts` | default not aligned with AutoCAD; no test ties a default to behaviour |
| Object snap tracking never laid a path | `settings.ts` | same — acquiring worked, F11 was off, the feature read as missing |
| Perpendicular matched as a point near the cursor | `PointResolver.ts` | "aimed at an object" was not a concept; Nearest had it as a special case and Perpendicular had to copy it |
| The click ending a grip drag discarded the snap the move showed | `ViewportPointerHandler.ts` | move and click each resolved the point on their own, and asked different questions |
| Snap marker drawn and hidden in the same frame | `ViewportPointerHandler.ts` | nine separate writers of `snapMarker.hidden`; no owner |
| OFFSET offset its own copy on the next run | `edit2d.ts` + `registry.ts` | no rule for what a command leaves selected; preselection consumed it |
| A saved `tangent` snap dropped on load | `ProjectIO.ts` | the snap-mode list is enumerated in five places (`settings.ts`, `ProjectIO.ts`, `shell.ts`, `PointResolver.ts`, `SnapService.ts`) |

Four of the six live in `ViewportPointerHandler.ts`, which has:

- 1,527 lines; a 586-line `pointerdown` handler and a 415-line `pointermove`
  handler (measured by the gap to the next top-level declaration);
- 42 hard-coded command-name checks (`active.name === 'MEASURE'`, …), the
  most of any file; `PreviewController.ts` has 31, `main.ts` 20,
  `CommandManager.ts` 13, `DragEditing.ts` 10, `PointResolver.ts` 5 — 121
  places where a generic layer knows a command by name;
- the second-highest churn in the repository (38 of the last 200 commits);
- one unit test, for a pure helper (`ucsCursorLegEndpoints`).

The plan's §6 lists this file for a later split. That is the wrong remedy for
this class: the file is not too big because it duplicates entity knowledge,
it is too big because **the same question — where is the point, what snap is
it on, what should be shown — is answered separately for the move, for the
click, for the drawing case, for the grip-drag case, and for several
commands by name.** Splitting it into smaller files would keep all of those.

### Recommendation: a new plan phase, ahead of §2

**§7. One pointer frame.** A single value computed once per pointer event and
consumed everywhere in that event:

```ts
interface PointerFrame {
  cursor: Vec2;                      // raw, in the active plane
  snap: SnapTarget | null;           // the object snap that won, if any
  tracked: Vec2 | null;              // where an acquired path caught the cursor
  guides: AlignmentGuide[];          // the dotted paths to draw
  point: Vec2;                       // where a click lands
}
```

- `PointResolver` produces it. `ViewportPointerHandler`'s move and click
  both read it; neither resolves anything itself. The grip-drag click fault
  becomes impossible by construction.
- A `SnapPresenter` (or the existing `PreviewController`) is the only writer
  of the snap marker and the guide lines, fed from the frame. The nine
  `snapMarker.hidden = true` sites go away with it.
- "Aimed at an object" (Nearest, Perpendicular, a tracking path meeting an
  edge) and "a point near the cursor" (endpoint, midpoint, centre,
  intersection) become the two explicit kinds of candidate the resolver
  ranks, instead of one general path plus special cases.
- Today's seven cases are unit tests of the frame — they are currently only
  live-verified, which the commit messages say outright. This phase is what
  makes them testable without a DOM.

Two smaller items belong with it:

- **Defaults are behaviour.** One test file asserting AutoCAD-parity defaults
  *through the resolver* (the way the OTRACK test now does), so a default
  cannot be off without a test saying which gesture stops working.
- **One list of snap modes.** Derive `ObjectSnapMode`'s members once (a
  `const` array the type is built from) and have settings, persistence, the
  context menu and the resolver consume it.

**§8. Command lifecycle rules.** What a command may leave selected when it
ends, and whether the next command's preselection may consume it. Today each
command decides ad hoc (`selectEntity(parallel.id)` in OFFSET was the fault;
LEADER, PROJECT and INTERFERE clear; FILLET selects). One rule, stated in
`CommandDef`, replaces the guesswork.

## 3. Hot files, by the numbers

Source: 162 non-test files, 45,271 lines; 112 test files, 25,521 lines;
1,658 tests, 41 s wall, 155 s CPU.

| File | Lines | Note |
|---|---|---|
| `render/Viewport.ts` | 2,921 | two classes (`Canvas2DRenderer`, `Viewport3D`); 99 type branches; 22 preview kinds that `PreviewController` also knows by command name |
| `core/geometry/OpenCascadeKernel.ts` | 2,784 | one class, 53 methods; the interface has 50; 21 `as unknown as` escapes (binding typing) |
| `main.ts` | 2,001 | 310 top-level statements, 46 listeners, 30 controllers constructed, 34 manual `redraw()` calls, plus the MCP dispatcher; **most-churned file** (44/200) |
| `core/commands/steps/edit2d.ts` | 1,871 | 7 command steps and ~20 pure geometry functions (`splitCubicBezier`, `offsetPolygon`, `circleCircleIntersections`, …) in one file |
| `core/entities/types.ts` | 1,578 | 46 type declarations and 33 functions; the plan's "declarations versus operations" split |
| `interaction/ViewportPointerHandler.ts` | 1,527 | see §2 |
| `core/commands/CommandManager.test.ts` | ~4,200 | 438 tests, 40.8 s in one worker — the whole run's critical path; the file both agents append to |

Other measurements worth knowing:

- **Command state is untyped.** `active.data` is `Record<string, unknown>`;
  the steps cast it 234 times (`data.entities as …` 34×, `data.solids as …`
  27×, `data.surfaces as …` 16×). Every step re-declares what it stored. The
  `kind: 'surface'` step handing an id where an object was expected, found
  earlier this week, was this.
- **Layering is clean.** Nothing under `core/` imports `ui/`, `render/` or
  `interaction/` (verified by grep). One exception in the other direction:
  `ui/PropertiesController.ts` imports `solidBounds` from
  `interaction/PickingService.ts`; it belongs in `core/solids`.
- **The MCP client drifts.** `mcp/CadModelApi.ts` (767 lines) calls
  `booleanExactSolids`, `modifyExactSolidEdge`, `buildExactFeature` directly
  and knows nothing of surfaces, THICKEN, SURFOFFSET or SURFSCULPT. It is a
  second client of the solid pipeline with no parity test.
- **One `TODO` in 45,000 lines.** Comments explain intent rather than defer
  it; that is worth keeping as it is.

## 4. Recommendations, in order

1. **Finish §1 as planned**, and add the "branches removed" line to each
   progress entry with a target for the table (§1 above).
2. **Add §7 (pointer frame) and §8 (command lifecycle) to the plan, ahead of
   §2.** Evidence: six of seven faults this week, four in one file, none
   preventable by §1–§6. Start by characterising the seven with unit tests
   of `PointResolver` and `DraftingService`, which is where the frame will
   live.
3. **Split `main.ts` by wiring domain now** — viewport wiring, command line,
   panels, file/project, MCP — and move the MCP dispatcher out entirely. This
   deviates from §6's "after shared abstractions" rule deliberately: the file
   is not duplicated logic, it is construction, and it is where two agents
   editing concurrently collide most (44 of the last 200 commits).
4. **Split `CommandManager.test.ts` by command family** (draw, edit2d,
   solids, surfaces, dimensions, transform, enquiry). Pure moves; halves the
   suite's wall time and ends the append-to-one-file collisions.
5. **Move `edit2d.ts`'s pure geometry to `math/`** (`geometry.ts` and
   `bezierFit.ts` already live there). No behaviour change; the functions get
   tests of their own instead of only through commands.
6. **Type the command state.** Give `CommandDef` a type parameter for `data`
   and migrate one family at a time; each migration deletes its casts. Pairs
   naturally with §3 (repeating point step).
7. **Replace command-name checks with capabilities.** `pointInput` and
   `sticky` already show the shape; add what the 121 sites actually ask
   (face-picking command, records target pick point, per-point dynamic UCS,
   preview kind) as flags or hooks on the definition, and delete the checks
   as each is covered.
8. Smaller, any time: one snap-mode list; `solidBounds` into `core/solids`;
   split `GeometryKernel` into capability interfaces (booleans, sweeps and
   lofts, surfaces, measurement, projection) so a test can fake one slice;
   an MCP parity test that lists which commands both clients expose.

## 5. What not to do

- Do not split `ViewportPointerHandler.ts` by file before §7. It would
  preserve every duplicate resolution and make the frame harder to introduce.
- Do not let the shared display path (§1.5–7) reach the kernel conversion;
  the plan says this and the audit found no violation — keep it so.
- Do not migrate arcs and Beziers to shared paths without the quality policy
  §1.7 asks for. The spline-endpoint fault the plan cites was a sampling
  budget standing in for a definition; the plan's remedy is right.

## Reproducing the numbers

```sh
find src -name "*.ts" ! -name "*.test.ts" -exec wc -l {} + | sort -rn | head
grep -cE "\.type === '|\.type !== '|case '[a-z-]+':" <file>
grep -cE "\.name === '[A-Z_]+'" <file>
grep -c "snapMarker.hidden = true" src/interaction/ViewportPointerHandler.ts
grep -rhoE "data\.[a-zA-Z]+ as " src/core/commands | wc -l
git log --oneline -200 --name-only --pretty=format: | grep "^src/" | sort | uniq -c | sort -rn
npx vitest run --reporter=json --outputFile=vitest.json   # per-file timings
```
