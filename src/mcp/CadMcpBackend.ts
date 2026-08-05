import type { DocumentSummary, LineSegmentInput, PrimitiveInput, SelectionMode } from './CadModelApi';

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
  booleanOperation(operation: 'union' | 'subtract' | 'intersect', solidIds: readonly string[], name?: string): Awaitable<Record<string, unknown>>;
  deleteFeature(
    solidId: string,
    point: { x: number; y: number; z: number },
    normal: { x: number; y: number; z: number },
  ): Awaitable<Record<string, unknown>>;
  deleteObjects(ids: readonly string[]): Awaitable<DocumentSummary>;
  undo(): Awaitable<DocumentSummary>;
  redo(): Awaitable<DocumentSummary>;
  exportStl(path: string, solidIds?: readonly string[]): Awaitable<{ path: string; solidIds: string[] }>;
}
