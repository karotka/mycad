export interface PreviewFrame {
  type: string;
  data: unknown;
}

export class PreviewController {
  private frame: PreviewFrame | undefined;
  private dimensionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly dimension: HTMLElement,
    readonly measureOrigin: HTMLElement,
    readonly measureTarget: HTMLElement,
    readonly snapMarker: HTMLElement,
    private readonly projectPoint?: (point: { x: number; y: number; z: number }) => { x: number; y: number } | null,
    private readonly copyWorldDelta?: (delta: Vec2) => { x: number; y: number; z: number } | undefined,
    private readonly drawingPlaneMarker: HTMLElement = snapMarker,
    /** The plane a curve preview would otherwise be pinned flat to, or null
     *  where a flat preview is the only meaningful one (the 2D view). Only
     *  BEZIER/SPLINE use it, to notice that their points no longer all sit
     *  on it — see `curvePreviewChain`. */
    private readonly curvePreviewPlane?: () => WorkPlane | null,
  ) {}

  get preview(): PreviewFrame | undefined { return this.frame; }

  setPreview(preview: PreviewFrame | undefined): void { this.frame = preview; }

  clearPreview(): void { this.frame = undefined; }

  /**
   * The whole world-space point chain a BEZIER/SPLINE preview should follow —
   * every point already clicked plus where the cursor sits now — but only
   * once they no longer all share one elevation on the active plane. A flat
   * curve (the ordinary case, and every curve in the 2D view) gets null back
   * and keeps the plain local-frame preview, unchanged.
   *
   * Reported live, right after the curves themselves started bending through
   * 3D correctly: "funguje, ale nahled se generuje blbe, pouze ve 2d" — the
   * preview reads the same `points` the command collects, which are local
   * (x, y) only, so it stayed pinned flat to one plane while drawing.
   */
  private curvePreviewChain(active: ActiveCommand, cursor: Vec2): Vec3[] | null {
    const plane = this.curvePreviewPlane?.() ?? null;
    if (!plane) return null;
    const points = (active.data.points as Vec2[] | undefined) ?? [];
    const worldPoints = active.data.worldPoints as Vec3[] | undefined;
    const cursorWorld = (cursor as Vec2 & { world?: Vec3 }).world;
    if (!worldPoints || !cursorWorld || worldPoints.length !== points.length) return null;
    const chain = [...worldPoints, cursorWorld];
    return worldPointsShareElevation(plane, chain) ? null : chain;
  }

  private isTextEntryStep(active: ActiveCommand): boolean {
    return ((active.name === 'TEXT' || active.name === 'MTEXT') && active.stepIndex === 3)
      || (active.name === 'TEXTEDIT' && active.stepIndex === 1);
  }

  update(active: ActiveCommand | null, cursor: Vec2, ucsHoverPoint: { x: number; y: number; z: number } | null): void {
    if (active && this.isTextEntryStep(active)) {
      // The on-canvas text editor drives this preview itself, as the user types
      // and edits height — the cursor has nothing to do with it, so a pointer
      // move must leave it alone rather than clearing it back to nothing.
      return;
    }
    this.clearPreview();
    if (!active) return;
    // A first snap outside the UCS establishes a parallel drawing plane.  The
    // preview must carry that plane too; otherwise the final entity is correct
    // but its rubber-band preview is drawn back on the active UCS.
    const drawingPlane = active.data.drawingPlane as WorkPlane | undefined;
    if (active.name === 'UCS') {
      this.setPreview({
        type: 'ucs',
        data: { origin: active.data.origin, xPoint: active.data.xPoint, yPoint: active.data.yPoint, hover: ucsHoverPoint, step: active.stepIndex },
      });
      return;
    }
    if (active.name === 'POLYLINE' || active.name === 'AREA') {
      // The whole chain so far, not just the segment being dragged: the vertices
      // are only a polyline once the command ends, so until then this preview is
      // the only thing that shows what has been drawn.
      const vertices = (active.data.vertices as Vec2[]) ?? [];
      if (vertices.length > 0) this.setPreview({ type: active.name === 'AREA' ? 'area' : 'polyline', data: { vertices, cursor, workPlane: drawingPlane } });
      return;
    }
    if (active.name === 'MLINE') {
      const vertices = (active.data.vertices as Vec2[]) ?? [];
      const style = active.data.mlineStyle as MlineStyle | undefined;
      if (vertices.length > 0 && style) {
        this.setPreview({ type: 'mline', data: { vertices, cursor, workPlane: drawingPlane, elements: style.elements, justification: 'zero' } });
      }
      return;
    }
    if (active.name === 'SPLINE') {
      const points = (active.data.points as Vec2[]) ?? [];
      if (points.length === 0) return;
      // Interpolated through every clicked point plus where the cursor sits
      // now, so the preview is the actual curve a click here would produce —
      // not a straight stand-in for it, and not a fit that can reshape an
      // already-placed span once another point goes down further along.
      // A curve bent out of the plane fits in world space instead, exactly as
      // drawSpline itself does once the command finishes.
      const bent = this.curvePreviewChain(active, cursor);
      const fits = bent ? interpolatingBeziers3(bent) : interpolatingBeziers([...points, cursor]);
      this.setPreview(fits.length > 0
        ? { type: 'spline', data: { start: fits[0].start, segments: fits.map((fit) => ({ control1: fit.control1, control2: fit.control2, end: fit.end })), workPlane: bent ? WORLD_WORK_PLANE : drawingPlane } }
        : { type: 'polyline', data: { vertices: points, cursor, workPlane: drawingPlane } });
      return;
    }
    if (active.name === 'ELLIPSE' && active.data.center) {
      if (active.stepIndex === 1) this.setPreview({ type: 'line', data: { start: active.data.center, end: cursor } });
      else if (active.stepIndex === 2 && active.data.axisPoint) {
        this.setPreview({ type: 'ellipse', data: { center: active.data.center, axisPoint: active.data.axisPoint, cursor } });
      }
      return;
    }
    if (active.name === 'POLYGON' && active.stepIndex === 2 && active.data.center && active.data.sides) {
      this.setPreview({ type: 'polygon', data: { center: active.data.center, cursor, sides: active.data.sides } });
      return;
    }
    if (active.name === 'ARC') {
      if (active.stepIndex === 1 && active.data.center) this.setPreview({ type: 'circle', data: { center: active.data.center, cursor, workPlane: drawingPlane } });
      else if (active.stepIndex === 2 && active.data.center && active.data.start) this.setPreview({ type: 'arc', data: { center: active.data.center, start: active.data.start, cursor, workPlane: drawingPlane } });
      return;
    }
    if (active.name === 'ARC_SER' && active.stepIndex === 1 && active.data.start) {
      // The centre isn't known until the third point (or a typed radius)
      // fixes it, so there's nothing arc-shaped to preview yet — just the
      // chord being picked.
      this.setPreview({ type: 'line', data: { start: active.data.start, end: cursor, workPlane: drawingPlane } });
      return;
    }
    if (active.name === 'ARC_SER' && active.stepIndex === 2 && active.data.start && active.data.end) {
      const arc = arcFromSagitta(active.data.start as Vec2, active.data.end as Vec2, cursor);
      if (arc) {
        this.setPreview({
          type: 'arcRadius',
          data: { center: arc.center, radius: arc.radius, startAngle: arc.startAngle, sweepAngle: arc.sweepAngle, workPlane: drawingPlane },
        });
      }
      return;
    }
    if (active.name === 'BEZIER') {
      // Every already-placed segment shown as the real curve it is, plus one
      // more live segment following the cursor from wherever the chain — and
      // whatever control points already exist for it — currently ends.
      const points = (active.data.points as Vec2[]) ?? [];
      if (points.length === 0) return;
      // Same chain, in world space, once the control points stop sharing one
      // elevation — see curvePreviewChain.
      const bent = this.curvePreviewChain(active, cursor);
      const chain: Vec2[] = bent ? bent.slice(0, -1) : points;
      const tip: Vec2 = bent ? bent[bent.length - 1] : cursor;
      const fullSegments = Math.floor((chain.length - 1) / 3);
      const pending = chain.slice(1 + fullSegments * 3);
      const segments = Array.from({ length: fullSegments }, (_unused, index) => ({
        control1: chain[1 + index * 3],
        control2: chain[2 + index * 3],
        end: chain[3 + index * 3],
      }));
      segments.push({ control1: pending[0] ?? tip, control2: pending[1] ?? tip, end: tip });
      this.setPreview({ type: 'spline', data: { start: chain[0], segments, workPlane: bent ? WORLD_WORK_PLANE : drawingPlane } });
      return;
    }
    if (active.name === 'INSERT' && active.stepIndex === 1) {
      const template = active.data.previewInsert as Entity | undefined;
      if (template?.type !== 'insert') return;
      const ghost = cloneEntity(template);
      ghost.position = { ...cursor };
      ghost.color = 0xe6f4ff;
      ghost.selected = false;
      this.setPreview({ type: 'insert', data: { entities: [ghost] } });
      return;
    }
    if (active.name === 'MOVE' && active.stepIndex === 2 && active.data.basePoint) {
      // The objects ride under the cursor so you see what you are placing — and
      // it keeps its own kind, not a plain line, because a move reads how far it
      // went in x and in y, not the length of the hop.
      const base = active.data.basePoint as Vec2;
      const entities = this.translatedGhosts(active.data.entities as Entity[], { x: cursor.x - base.x, y: cursor.y - base.y });
      this.setPreview({ type: 'move', data: { start: base, end: cursor, entities } });
      return;
    }
    if (active.name === 'COPY' && active.stepIndex === 2 && active.data.basePoint) {
      const base = active.data.basePoint as Vec2;
      const entities = this.translatedGhosts(active.data.entities as Entity[], { x: cursor.x - base.x, y: cursor.y - base.y });
      this.setPreview({ type: 'copy', data: { start: base, end: cursor, entities } });
      return;
    }
    // The base point is also the reference origin, so only one reference click
    // is needed before live scaling begins.
    if (active.name === 'SCALE' && active.stepIndex === 2 && active.data.basePoint) {
      this.setPreview({ type: 'line', data: { start: active.data.basePoint as Vec2, end: cursor } });
      return;
    }
    // No transformed entity clones are made here. The renderer applies one
    // canvas transform to the originals, keeping pointermove cheap for hundreds
    // of Bezier curves.
    if (active.name === 'SCALE' && active.stepIndex === 3 && active.data.basePoint && active.data.referenceLength) {
      const base = active.data.basePoint as Vec2;
      const reference = active.data.referenceLength as number;
      const factor = Math.hypot(cursor.x - base.x, cursor.y - base.y) / reference;
      this.setPreview({ type: 'scale', data: { start: base, end: cursor, entities: active.data.entities as Entity[], factor } });
      return;
    }
    if (active.name === 'ROTATE' && active.stepIndex === 2 && active.data.basePoint) {
      const base = active.data.basePoint as Vec2;
      const angle = Math.atan2(cursor.y - base.y, cursor.x - base.x);
      const entities = (active.data.entities as Entity[]).map((entity) => rotateEntity(entity, base, angle));
      this.setPreview({ type: 'rotate', data: { start: base, end: cursor, entities } });
      return;
    }
    if ((active.name === 'BOX' || active.name === 'WEDGE') && active.stepIndex === 1 && active.data.start) {
      this.setPreview({ type: 'rectangle', data: { start: active.data.start, end: cursor } });
      return;
    }
    if (['CYLINDER', 'SPHERE', 'CONE', 'PYRAMID', 'TORUS'].includes(active.name) && active.stepIndex === 1 && active.data.center) {
      this.setPreview({ type: 'circle', data: { center: active.data.center, cursor } });
      return;
    }
    if ((active.name === 'MEASURE' || active.name === 'DIMALIGNED') && active.data.start && active.stepIndex >= 1) {
      let start = active.data.start as Vec2;
      // Picking the second point, the cursor is that point and the dimension has
      // nowhere to sit yet, so it lies on the two points and simply reads them.
      // Placing the line, the points are settled and the cursor is the location.
      const placing = active.stepIndex >= 2 && Boolean(active.data.end);
      let end = placing ? active.data.end as Vec2 : cursor;
      // Once the line is placed the cursor moves on to the text, so the offset
      // stops following it and the text starts.
      const settled = active.stepIndex >= 3 && Boolean(active.data.offset);
      let offset = settled ? active.data.offset as Vec2 : cursor;
      let textPosition = settled ? cursor : undefined;
      const aligned = active.name === 'DIMALIGNED';
      const placement = aligned && settled
        ? active.data.dimensionPlacement as {
          sourceWorkPlane: WorkPlane;
          workPlane: WorkPlane;
          start: Vec2;
          end: Vec2;
          offset: Vec2;
        } | null | undefined
        : null;
      if (placement) {
        start = placement.start;
        end = placement.end;
        offset = placement.offset;
        const cursorWorld = localToWorld(
          placement.sourceWorkPlane,
          cursor,
          (cursor as Vec2 & { z?: number }).z ?? 0,
        );
        const localText = worldToLocal(placement.workPlane, cursorWorld);
        textPosition = { x: localText.x, y: localText.y };
      }
      this.setPreview({
        type: 'dimension',
        data: {
          start, end, offset, textPosition,
          workPlane: placement?.workPlane,
          kind: aligned ? 'aligned' : 'linear',
          // The same rule the command will apply, asked early. With the line not
          // yet pulled anywhere it can only answer from the points themselves,
          // which is the honest answer: an axis-aligned pair reads its length,
          // and a slope reads across until the location says otherwise.
          rotation: aligned ? undefined : linearDimensionRotation(start, end, offset),
          style: active.data.dimensionStyle,
        },
      });
      return;
    }
    if (active.name === 'DIMANGULAR' && active.data.angularSource && active.stepIndex >= 5) {
      const source = active.data.angularSource as {
        workPlane: WorkPlane;
        vertex: Vec2;
        first: Vec2;
        second: Vec2;
      };
      const settled = active.stepIndex >= 6 && Boolean(active.data.angularArcPoint);
      this.setPreview({
        type: 'dimension',
        data: {
          start: source.vertex,
          end: source.first,
          offset: source.second,
          arcPoint: settled ? active.data.angularArcPoint : cursor,
          textPosition: settled ? cursor : undefined,
          kind: 'angular',
          workPlane: source.workPlane,
          style: active.data.dimensionStyle,
        },
      });
      return;
    }
    if ((active.name === 'DIMRADIUS' || active.name === 'DIMDIAMETER') && active.stepIndex === 1) {
      const entity = active.data.entity as Entity | undefined;
      const source = active.data.radialSource as { center: Vec2; radius: number; workPlane: WorkPlane } | undefined
        ?? (entity?.type === 'circle' || entity?.type === 'arc'
          ? {
            center: entity.center,
            radius: entity.radius,
            workPlane: entity.workPlane ?? WORLD_WORK_PLANE,
          }
          : undefined);
      if (!source) return;
      let dx = cursor.x - source.center.x, dy = cursor.y - source.center.y;
      const distance = Math.hypot(dx, dy) || 1; dx /= distance; dy /= distance;
      this.setPreview({
        type: 'dimension',
        data: {
          start: source.center,
          end: { x: source.center.x + dx * source.radius, y: source.center.y + dy * source.radius },
          offset: cursor,
          kind: active.name === 'DIMRADIUS' ? 'radius' : 'diameter',
          workPlane: source.workPlane,
          style: active.data.dimensionStyle,
        },
      });
      return;
    }
    if (active.stepIndex !== 1) return;
    if (active.name === 'LINE' && active.data.start) this.setPreview({ type: 'line', data: { start: active.data.start, end: cursor, workPlane: drawingPlane } });
    else if (active.name === 'RECTANGLE' && active.data.start) this.setPreview({ type: 'rectangle', data: { start: active.data.start, end: cursor } });
    else if ((active.name === 'CIRCLE' || active.name === 'CIRCLE_DIAMETER') && active.data.center) this.setPreview({ type: active.name === 'CIRCLE' ? 'circle' : 'circleDiameter', data: { center: active.data.center, cursor, workPlane: drawingPlane } });
    else if (active.name === 'OCTAGON' && active.data.center) this.setPreview({ type: 'octagon', data: { center: active.data.center, cursor } });
    else if (active.name === 'PRINTAREA' && active.data.start) this.setPreview({ type: 'rectangle', data: { start: active.data.start, end: cursor } });
  }

  /**
   * The selected entities shifted by a work-plane drag and coloured as a ghost —
   * what MOVE and COPY show riding under the cursor before the click commits.
   * A viewport-supplied world delta moves the whole work plane (so 3D geometry
   * keeps its shape); otherwise the points shift in the plane.
   */
  private translatedGhosts(entities: Entity[], delta: Vec2): Entity[] {
    return entities.map((entity) => {
      const worldDelta = this.copyWorldDelta?.(delta);
      const ghost = worldDelta
        ? cloneEntity(entity)
        : transformEntityPoints(entity, (point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
      if (worldDelta) {
        const plane = cloneWorkPlane(ghost.workPlane ?? WORLD_WORK_PLANE);
        plane.origin.x += worldDelta.x; plane.origin.y += worldDelta.y; plane.origin.z += worldDelta.z;
        ghost.workPlane = plane;
      }
      ghost.color = 0xe6f4ff;
      ghost.selected = false;
      return ghost;
    });
  }

  showDimension(text: string | null, x: number, y: number): void {
    if (!text) return;
    this.dimension.textContent = text;
    this.dimension.style.left = `${x + 16}px`;
    this.dimension.style.top = `${y - 34}px`;
    this.dimension.hidden = false;
    if (this.dimensionTimer) clearTimeout(this.dimensionTimer);
    this.dimensionTimer = setTimeout(() => { this.dimension.hidden = true; }, 1200);
  }

  showMarker(marker: HTMLElement, x: number, y: number): void {
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
    marker.hidden = false;
  }

  showSnap(point: { x: number; y: number; z: number }, fallbackX: number, fallbackY: number, mode?: string): void {
    const projected = this.projectPoint?.(point);
    // The symbol tells the modes apart the way AutoCAD does — a square for an
    // endpoint, a right angle for perpendicular, and so on.
    this.snapMarker.dataset.snap = mode ?? 'end';
    this.showMarker(this.snapMarker, projected?.x ?? fallbackX, projected?.y ?? fallbackY);
  }

  hideSnap(): void { this.snapMarker.hidden = true; }

  /** AutoCAD's own convention when a picked point establishes a temporary,
   *  UCS-parallel drawing plane: a cross where the plane sits, so a point
   *  landing somewhere unexpected later in the same command has an obvious
   *  reason why — not just an implicit rule the user has to remember. */
  showDrawingPlaneOrigin(point: { x: number; y: number; z: number }, fallbackX: number, fallbackY: number): void {
    const projected = this.projectPoint?.(point);
    this.showMarker(this.drawingPlaneMarker, projected?.x ?? fallbackX, projected?.y ?? fallbackY);
  }

  hideDrawingPlaneOrigin(): void { this.drawingPlaneMarker.hidden = true; }

  hideMeasurements(): void {
    this.measureOrigin.hidden = true;
    this.measureTarget.hidden = true;
  }

  reset(): void {
    this.clearPreview();
    this.hideSnap();
    this.hideDrawingPlaneOrigin();
    this.hideMeasurements();
    this.dimension.hidden = true;
    if (this.dimensionTimer) clearTimeout(this.dimensionTimer);
    this.dimensionTimer = undefined;
  }
}

function rotateEntity(entity: Entity, base: Vec2, angle: number): Entity {
  const rotate = (point: Vec2): Vec2 => {
    const dx = point.x - base.x, dy = point.y - base.y;
    return { x: base.x + dx * Math.cos(angle) - dy * Math.sin(angle), y: base.y + dx * Math.sin(angle) + dy * Math.cos(angle) };
  };
  if (entity.type === 'rectangle') {
    const corners = [entity.first, { x: entity.opposite.x, y: entity.first.y }, entity.opposite, { x: entity.first.x, y: entity.opposite.y }];
    return { id: entity.id, type: 'polyline', layer: entity.layer, aci: entity.aci, color: 0xe6f4ff, selected: false, workPlane: entity.workPlane, vertices: corners.map(rotate), closed: true };
  }
  const result = cloneEntity(entity);
  result.color = 0xe6f4ff;
  result.selected = false;
  switch (result.type) {
    case 'point': result.position = rotate(result.position); break;
    case 'line': result.start = rotate(result.start); result.end = rotate(result.end); break;
    case 'circle':
    case 'ellipse': result.center = rotate(result.center); break;
    case 'octagon': result.center = rotate(result.center); result.vertices = result.vertices.map(rotate); break;
    case 'polyline':
    case 'mline': result.vertices = result.vertices.map(rotate); break;
    case 'arc': result.center = rotate(result.center); result.startAngle += angle; break;
    case 'bezier':
      result.start = rotate(result.start);
      result.segments = result.segments.map((segment) => ({ control1: rotate(segment.control1), control2: rotate(segment.control2), end: rotate(segment.end) }));
      break;
    case 'text': result.position = rotate(result.position); result.rotation = (result.rotation ?? 0) + angle; break;
    case 'dimension': result.start = rotate(result.start); result.end = rotate(result.end); result.offset = rotate(result.offset); if (result.textPosition) result.textPosition = rotate(result.textPosition); break;
    case 'insert': result.position = rotate(result.position); result.rotation += angle; break;
  }
  return result;
}
import type { ActiveCommand } from '../core/commands/CommandManager';
import { linearDimensionRotation } from '../core/entities/types';
import { cloneEntity, transformEntityPoints, type Entity } from '../core/entities/types';
import type { Vec2, Vec3 } from '../math/geometry';
import { cloneWorkPlane, localToWorld, worldPointsShareElevation, worldToLocal, WORLD_WORK_PLANE, type WorkPlane } from '../math/workplane';
import { interpolatingBeziers, interpolatingBeziers3 } from '../math/bezierFit';
import { arcFromSagitta } from '../math/arcFit';
import type { MlineStyle } from '../core/settings';
