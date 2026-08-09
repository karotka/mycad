import type { DocumentSummary, EdgeModifyInput, ExtrudeInput, LineSegmentInput, PressPullInput, PrimitiveInput, SelectionMode, SliceInput, TransformInput, UcsInput } from './CadModelApi';

type Awaitable<T> = T | Promise<T>;

/** Operations exposed by both the live desktop bridge and headless file mode. */
export interface CadMcpBackend {
  newDocument(): Awaitable<DocumentSummary>;
  openProject(path: string): Awaitable<DocumentSummary>;
  saveProject(path?: string): Awaitable<{ path: string; summary: DocumentSummary }>;
  summary(): Awaitable<DocumentSummary>;
  listObjects(selectedOnly?: boolean): Awaitable<Array<Record<string, unknown>>>;
  getObject(id: string): Awaitable<Record<string, unknown>>;
  selectObjects(ids: readonly string[], mode?: SelectionMode): Awaitable<DocumentSummary>;
  createPrimitive(input: PrimitiveInput): Awaitable<Record<string, unknown>>;
  createLines(segments: readonly LineSegmentInput[]): Awaitable<Array<Record<string, unknown>>>;
  extrude(input: ExtrudeInput): Awaitable<Record<string, unknown>>;
  booleanOperation(operation: 'union' | 'subtract' | 'intersect', solidIds: readonly string[], name?: string): Awaitable<Record<string, unknown>>;
  deleteFeature(
    solidId: string,
    point: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number },
  ): Awaitable<Record<string, unknown>>;
  deleteObjects(ids: readonly string[]): Awaitable<DocumentSummary>;
  describeSolid(id: string): Awaitable<Record<string, unknown>>;
  transformSolids(input: TransformInput): Awaitable<Array<Record<string, unknown>>>;
  pressPull(input: PressPullInput): Awaitable<Record<string, unknown>>;
  modifyEdge(input: EdgeModifyInput, rounded: boolean): Awaitable<Record<string, unknown>>;
  sliceSolid(input: SliceInput): Awaitable<Array<Record<string, unknown>>>;
  setUcs(input: UcsInput): Awaitable<DocumentSummary>;
  restoreWcs(): Awaitable<DocumentSummary>;
  createLayer(name: string, makeCurrent?: boolean): Awaitable<DocumentSummary>;
  setCurrentLayer(name: string): Awaitable<DocumentSummary>;
  setObjectLayer(ids: readonly string[], layer: string): Awaitable<DocumentSummary>;
  undo(): Awaitable<DocumentSummary>;
  redo(): Awaitable<DocumentSummary>;
  exportStl(path: string, solidIds?: readonly string[]): Awaitable<{ path: string; solidIds: string[] }>;
}
