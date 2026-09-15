/**
 * The loop of drawn geometry that encloses a point.
 *
 * AutoCAD's BOUNDARY: click inside an area and get back the outline around it
 * as one closed object, without having to have drawn that outline as one thing.
 * The area is normally bounded by pieces of several objects — three overlapping
 * circles, a wall crossed by a window, a shape cut by a construction line — and
 * the whole value is that the pieces need not be trimmed first.
 *
 * The work is planar-graph tracing, so it is written against plain geometry
 * rather than entities: `BoundaryPiece` is a line or an arc, and that is all
 * this file knows. Turning a drawing's entities into pieces, and the traced
 * loop back into a polyline, is the caller's job — which keeps the part that
 * can be wrong testable with a handful of numbers.
 *
 * Exactness is kept on purpose. Tracing happens on chords, because intersecting
 * every curve with every other curve exactly is a far larger problem, but each
 * chord remembers the piece and the span of it that it came from — so an arc
 * that survives into the loop comes back out as an arc, with its radius, rather
 * than as the string of little straight lines it was traced with.
 */
import type { Vec2 } from '../../math/geometry';

export type BoundaryPiece =
  | { kind: 'line'; start: Vec2; end: Vec2 }
  | { kind: 'arc'; center: Vec2; radius: number; startAngle: number; sweepAngle: number };

/** A span of one piece, in that piece's own 0..1 parameter. */
export interface BoundarySpan {
  piece: number;
  from: number;
  to: number;
}

export interface TracedBoundary {
  /** The loop's corners, in order, without repeating the first at the end. */
  vertices: Vec2[];
  /** One per segment leaving the vertex of the same index; 0 is straight. */
  bulges: number[];
}

/** How far apart two points may be and still be the same graph vertex. Model
 *  units; the caller scales it to the drawing it is working on. */
const DEFAULT_TOLERANCE = 1e-6;

/** Straight pieces of an arc per full turn: fine enough that the traced chord
 *  chain follows the curve closely, coarse enough not to flood the graph. */
const ARC_CHORDS_PER_TURN = 96;

export function pointOnPiece(piece: BoundaryPiece, t: number): Vec2 {
  if (piece.kind === 'line') {
    return { x: piece.start.x + (piece.end.x - piece.start.x) * t, y: piece.start.y + (piece.end.y - piece.start.y) * t };
  }
  const angle = piece.startAngle + piece.sweepAngle * t;
  return { x: piece.center.x + Math.cos(angle) * piece.radius, y: piece.center.y + Math.sin(angle) * piece.radius };
}

/** The chords a piece is traced with, as parameter breakpoints including 0 and 1. */
function pieceBreakpoints(piece: BoundaryPiece): number[] {
  if (piece.kind === 'line') return [0, 1];
  const count = Math.max(2, Math.ceil(Math.abs(piece.sweepAngle) / (Math.PI * 2) * ARC_CHORDS_PER_TURN));
  return Array.from({ length: count + 1 }, (_, index) => index / count);
}

interface Chord {
  piece: number;
  from: number;
  to: number;
  start: Vec2;
  end: Vec2;
}

/**
 * Where two pieces cross, exactly.
 *
 * Tracing runs on chords, but the crossings must not: a crossing found on a
 * chord sits a sagitta away from the real one, and that error ends up in the
 * traced outline's own corners. These are the three closed forms — two lines,
 * a line and a circle, two circles — so a corner of the result is the corner
 * the drawing has.
 */
function pieceCrossings(a: BoundaryPiece, b: BoundaryPiece): Vec2[] {
  if (a.kind === 'line' && b.kind === 'line') return lineLineCrossings(a, b);
  if (a.kind === 'line' && b.kind === 'arc') return lineCircleCrossings(a, b);
  if (a.kind === 'arc' && b.kind === 'line') return lineCircleCrossings(b, a);
  if (a.kind === 'arc' && b.kind === 'arc') return circleCircleCrossings(a, b);
  return [];
}

function lineLineCrossings(a: Extract<BoundaryPiece, { kind: 'line' }>, b: Extract<BoundaryPiece, { kind: 'line' }>): Vec2[] {
  const ax = a.end.x - a.start.x, ay = a.end.y - a.start.y;
  const bx = b.end.x - b.start.x, by = b.end.y - b.start.y;
  const denominator = ax * by - ay * bx;
  if (Math.abs(denominator) < 1e-15) return []; // parallel, including collinear
  const dx = b.start.x - a.start.x, dy = b.start.y - a.start.y;
  const t = (dx * by - dy * bx) / denominator;
  return [{ x: a.start.x + ax * t, y: a.start.y + ay * t }];
}

function lineCircleCrossings(line: Extract<BoundaryPiece, { kind: 'line' }>, arc: Extract<BoundaryPiece, { kind: 'arc' }>): Vec2[] {
  const dx = line.end.x - line.start.x, dy = line.end.y - line.start.y;
  const fx = line.start.x - arc.center.x, fy = line.start.y - arc.center.y;
  const a = dx * dx + dy * dy;
  if (a < 1e-18) return [];
  const halfB = fx * dx + fy * dy;
  const c = fx * fx + fy * fy - arc.radius * arc.radius;
  const discriminant = halfB * halfB - a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [(-halfB - root) / a, (-halfB + root) / a]
    .map((t) => ({ x: line.start.x + dx * t, y: line.start.y + dy * t }));
}

function circleCircleCrossings(a: Extract<BoundaryPiece, { kind: 'arc' }>, b: Extract<BoundaryPiece, { kind: 'arc' }>): Vec2[] {
  const dx = b.center.x - a.center.x, dy = b.center.y - a.center.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-12 || distance > a.radius + b.radius || distance < Math.abs(a.radius - b.radius)) return [];
  const along = (distance * distance + a.radius * a.radius - b.radius * b.radius) / (2 * distance);
  const height2 = a.radius * a.radius - along * along;
  if (height2 < 0) return [];
  const height = Math.sqrt(height2);
  const midX = a.center.x + (dx / distance) * along, midY = a.center.y + (dy / distance) * along;
  const offX = -(dy / distance) * height, offY = (dx / distance) * height;
  return [{ x: midX + offX, y: midY + offY }, { x: midX - offX, y: midY - offY }];
}

/**
 * Where `point` sits along `piece`, as its own 0..1 — or null when it is not on
 * the drawn part of it at all, which is how a crossing with the *circle* an arc
 * lies on gets rejected when the arc itself does not reach there.
 */
function pieceParameterAt(piece: BoundaryPiece, point: Vec2, tolerance: number): number | null {
  if (piece.kind === 'line') {
    const dx = piece.end.x - piece.start.x, dy = piece.end.y - piece.start.y;
    const length2 = dx * dx + dy * dy;
    if (length2 < 1e-18) return null;
    const t = ((point.x - piece.start.x) * dx + (point.y - piece.start.y) * dy) / length2;
    if (t < -1e-9 || t > 1 + 1e-9) return null;
    const nearest = { x: piece.start.x + dx * t, y: piece.start.y + dy * t };
    if (Math.hypot(nearest.x - point.x, nearest.y - point.y) > tolerance) return null;
    return Math.min(1, Math.max(0, t));
  }
  const dx = point.x - piece.center.x, dy = point.y - piece.center.y;
  if (Math.abs(Math.hypot(dx, dy) - piece.radius) > tolerance) return null;
  const turn = Math.atan2(dy, dx) - piece.startAngle;
  const full = Math.PI * 2;
  // The turn from the start, taken the way this arc actually sweeps.
  const normalized = piece.sweepAngle >= 0
    ? ((turn % full) + full) % full
    : -((((-turn) % full) + full) % full);
  const t = normalized / piece.sweepAngle;
  if (t < -1e-9 || t > 1 + 1e-9) return null;
  return Math.min(1, Math.max(0, t));
}

interface HalfEdge {
  from: number;
  to: number;
  /** Direction of travel at `from`, for ordering the edges around it. */
  angle: number;
  span: BoundarySpan;
}

/** A vertex store that treats points within `tolerance` as the same vertex. */
class VertexStore {
  readonly points: Vec2[] = [];
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly tolerance: number) {}

  private key(point: Vec2): string {
    const size = Math.max(this.tolerance, 1e-12) * 4;
    return `${Math.floor(point.x / size)}:${Math.floor(point.y / size)}`;
  }

  add(point: Vec2): number {
    const size = Math.max(this.tolerance, 1e-12) * 4;
    const cellX = Math.floor(point.x / size), cellY = Math.floor(point.y / size);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const index of this.buckets.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
          const existing = this.points[index];
          if (Math.hypot(existing.x - point.x, existing.y - point.y) <= this.tolerance) return index;
        }
      }
    }
    const index = this.points.push({ ...point }) - 1;
    const key = this.key(point);
    this.buckets.set(key, [...(this.buckets.get(key) ?? []), index]);
    return index;
  }
}

/**
 * The loop of pieces that encloses `inside`, or null when the point is not
 * enclosed by anything (the tracer walks off to infinity, which is exactly what
 * AutoCAD reports as "valid hatch boundary not found").
 */
export function traceBoundary(
  pieces: readonly BoundaryPiece[],
  inside: Vec2,
  tolerance = DEFAULT_TOLERANCE,
): TracedBoundary | null {
  const chords = splitChords(pieces, tolerance);
  if (chords.length === 0) return null;

  const vertices = new VertexStore(tolerance);
  const edges: HalfEdge[] = [];
  for (const chord of chords) {
    const from = vertices.add(chord.start);
    const to = vertices.add(chord.end);
    if (from === to) continue; // a chord shorter than the tolerance is not an edge
    edges.push({ from, to, angle: Math.atan2(chord.end.y - chord.start.y, chord.end.x - chord.start.x), span: { piece: chord.piece, from: chord.from, to: chord.to } });
    edges.push({ from: to, to: from, angle: Math.atan2(chord.start.y - chord.end.y, chord.start.x - chord.end.x), span: { piece: chord.piece, from: chord.to, to: chord.from } });
  }
  if (edges.length === 0) return null;

  // Edges leaving each vertex, sorted by direction, so "the next one round" is
  // a lookup rather than a search.
  const leaving = new Map<number, number[]>();
  edges.forEach((edge, index) => leaving.set(edge.from, [...(leaving.get(edge.from) ?? []), index]));
  for (const [vertex, list] of leaving) {
    leaving.set(vertex, list.sort((a, b) => edges[a].angle - edges[b].angle));
  }

  const start = firstEdgeRightOf(edges, vertices.points, inside);
  if (start === null) return null;

  const loop: number[] = [];
  const seen = new Set<number>();
  let current = start;
  while (!seen.has(current)) {
    seen.add(current);
    loop.push(current);
    current = nextEdgeOfFace(edges, leaving, current);
    if (current === start) return buildBoundary(pieces, edges, vertices.points, loop, tolerance);
    // A walk that leaves the graph, or wanders longer than the graph is big,
    // is not going round anything.
    if (loop.length > edges.length) return null;
  }
  return null;
}

/**
 * Every piece drawn out as chords, cut at every exact crossing with another
 * piece — so a crossing is always a shared vertex of the graph, and never two
 * vertices a hair apart that the walk would fall between.
 */
function splitChords(pieces: readonly BoundaryPiece[], tolerance: number): Chord[] {
  const cuts = pieces.map(() => [] as number[]);
  for (let a = 0; a < pieces.length; a++) {
    for (let b = a + 1; b < pieces.length; b++) {
      for (const point of pieceCrossings(pieces[a], pieces[b])) {
        const ta = pieceParameterAt(pieces[a], point, tolerance * 1e3 + 1e-9);
        const tb = pieceParameterAt(pieces[b], point, tolerance * 1e3 + 1e-9);
        if (ta === null || tb === null) continue;
        cuts[a].push(ta);
        cuts[b].push(tb);
      }
    }
  }
  const result: Chord[] = [];
  pieces.forEach((piece, index) => {
    const stops = [...pieceBreakpoints(piece), ...cuts[index]]
      .filter((t) => t >= 0 && t <= 1)
      .sort((x, y) => x - y);
    for (let step = 0; step + 1 < stops.length; step++) {
      if (stops[step + 1] - stops[step] < 1e-9) continue;
      result.push({
        piece: index,
        from: stops[step],
        to: stops[step + 1],
        start: pointOnPiece(piece, stops[step]),
        end: pointOnPiece(piece, stops[step + 1]),
      });
    }
  });
  return result;
}

/**
 * The half-edge to start walking from: the nearest edge a ray cast to the right
 * of `inside` meets, taken in the direction that keeps the point on its left.
 *
 * Going round the face on the left of the direction of travel is what the walk
 * below does, so this is what decides *which* face gets traced — the one the
 * point is in, rather than the one next door.
 */
function firstEdgeRightOf(edges: readonly HalfEdge[], points: readonly Vec2[], inside: Vec2): number | null {
  let best: number | null = null;
  let bestX = Infinity;
  for (let index = 0; index < edges.length; index++) {
    const a = points[edges[index].from];
    const b = points[edges[index].to];
    // Half-open in y, so a vertex shared by two edges is counted once.
    if ((a.y <= inside.y) === (b.y <= inside.y)) continue;
    const t = (inside.y - a.y) / (b.y - a.y);
    const x = a.x + (b.x - a.x) * t;
    if (x <= inside.x || x >= bestX) continue;
    bestX = x;
    // Upward through the ray means the inside is on this half-edge's left.
    best = b.y > a.y ? index : twin(index);
  }
  return best;
}

/** Half-edges are made in pairs, so a twin is its neighbour in the array. */
function twin(index: number): number {
  return index % 2 === 0 ? index + 1 : index - 1;
}

/**
 * The next half-edge of the face on the left: arriving along `edge`, turn back
 * along its twin and take the next edge clockwise from it. Walking a planar
 * graph this way traces one face and always comes back to where it started.
 */
function nextEdgeOfFace(edges: readonly HalfEdge[], leaving: Map<number, number[]>, edge: number): number {
  const back = twin(edge);
  const around = leaving.get(edges[back].from) ?? [];
  const position = around.indexOf(back);
  if (position < 0) return back;
  return around[(position - 1 + around.length) % around.length];
}

/** Merges the walked chords back into as few segments as they really are, and
 *  gives each arc span the bulge that reproduces it exactly. */
function buildBoundary(
  pieces: readonly BoundaryPiece[],
  edges: readonly HalfEdge[],
  points: readonly Vec2[],
  loop: readonly number[],
  tolerance: number,
): TracedBoundary | null {
  const spans: Array<{ span: BoundarySpan; startVertex: number; bulge: number; sweep: number }> = [];
  for (const index of loop) {
    const edge = edges[index];
    const previous = spans[spans.length - 1];
    const continues = previous
      && previous.span.piece === edge.span.piece
      && Math.abs(previous.span.to - edge.span.from) < 1e-9
      // Both halves of the span must run the same way along the piece.
      && Math.sign(previous.span.to - previous.span.from) === Math.sign(edge.span.to - edge.span.from);
    if (continues) previous.span.to = edge.span.to;
    else spans.push({ span: { ...edge.span }, startVertex: edge.from, bulge: 0, sweep: 0 });
  }
  if (spans.length === 0) return null;
  // A loop that closed on the same piece it started on joins those two spans.
  if (spans.length > 1) {
    const first = spans[0], last = spans[spans.length - 1];
    if (first.span.piece === last.span.piece
      && Math.abs(last.span.to - first.span.from) < 1e-9
      && Math.sign(last.span.to - last.span.from) === Math.sign(first.span.to - first.span.from)) {
      first.span.from = last.span.from;
      first.startVertex = last.startVertex;
      spans.pop();
    }
  }
  for (const entry of spans) {
    entry.sweep = spanSweep(pieces[entry.span.piece], entry.span);
    entry.bulge = spanBulge(pieces[entry.span.piece], entry.span);
  }
  // Two spans that carry on round the same circle are one arc, however many
  // pieces that circle was cut into — an isolated circle is held as two halves,
  // so a loop that runs through one of those joins would otherwise report two
  // arcs where the drawing has one.
  mergeContinuingArcs(pieces, spans, tolerance);
  const vertices = spans.map((entry) => ({ ...points[entry.startVertex] }));
  const bulges = spans.map((entry) => entry.bulge);
  // Two vertices with no curvature between them is a line doubled back on
  // itself, not an area.
  if (vertices.length < 3 && bulges.every((bulge) => Math.abs(bulge) < 1e-9)) return null;
  if (loopArea(vertices, tolerance) < tolerance) return null;
  return { vertices, bulges };
}

/** The angle a span actually turns through, signed. */
function spanSweep(piece: BoundaryPiece, span: BoundarySpan): number {
  return piece.kind === 'line' ? 0 : piece.sweepAngle * (span.to - span.from);
}

/** Joins neighbouring segments that run on round one and the same circle. */
function mergeContinuingArcs(
  pieces: readonly BoundaryPiece[],
  spans: Array<{ span: BoundarySpan; startVertex: number; bulge: number; sweep: number }>,
  tolerance: number,
): void {
  const sameCircle = (a: BoundaryPiece, b: BoundaryPiece): boolean =>
    a.kind === 'arc' && b.kind === 'arc'
    && Math.abs(a.radius - b.radius) <= tolerance
    && Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) <= tolerance;
  for (let index = 0; index < spans.length; index++) {
    while (spans.length > 2) {
      const next = spans[(index + 1) % spans.length];
      if (next === spans[index]) break;
      const here = pieces[spans[index].span.piece], there = pieces[next.span.piece];
      if (!sameCircle(here, there)) break;
      if (Math.sign(spans[index].sweep) !== Math.sign(next.sweep)) break;
      const total = spans[index].sweep + next.sweep;
      // A whole turn has no chord to bulge from, so it stays two segments.
      if (Math.abs(total) > Math.PI * 2 - 1e-6) break;
      spans[index].sweep = total;
      spans[index].bulge = Math.tan(total / 4);
      spans.splice((index + 1) % spans.length, 1);
      if ((index + 1) % (spans.length + 1) === 0) index--; // the wrap case removed the first
    }
  }
}

/** The bulge of the segment that reproduces this span of this piece. */
function spanBulge(piece: BoundaryPiece, span: BoundarySpan): number {
  if (piece.kind === 'line') return 0;
  return Math.tan(piece.sweepAngle * (span.to - span.from) / 4);
}

/** Twice the signed area, unsigned — only its size is used, as a "is this a
 *  real area or a degenerate sliver" check. */
function loopArea(vertices: readonly Vec2[], tolerance: number): number {
  let sum = 0;
  for (let index = 0; index < vertices.length; index++) {
    const a = vertices[index], b = vertices[(index + 1) % vertices.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2 + (vertices.length < 3 ? tolerance * 2 : 0);
}
