/**
 * Runs a boolean off the main thread. A fuse/cut/common over a pathological solid
 * can hang OCCT with no way to interrupt a blocking WASM call, so the only honest
 * guarantee against a frozen UI is a Web Worker we can `terminate()`. This module
 * is that boundary: it serialises the request to the worker, races it against a
 * timeout, and on timeout kills the worker (taking the stuck OCCT with it) so the
 * next call starts a fresh one.
 *
 * In Node — tests and the headless MCP server, which have no UI to freeze and no
 * Worker — it runs the same computation inline instead.
 */
import type { BooleanFeature } from '../entities/types';
import type { SerializedKernelSolid } from './GeometryKernel';
import type { ExactSolidResult } from './ExactSolid';

export interface BooleanJobRequest {
  id: number;
  operation: BooleanFeature['operation'];
  operands: readonly SerializedKernelSolid[];
  revision: number;
}

export type BooleanJobResponse =
  | { id: number; ok: true; result: ExactSolidResult }
  | { id: number; ok: false; error: string };

/**
 * How long a boolean may run before it is treated as hung and cancelled. Generous
 * enough for a genuinely heavy but finite fuse, short enough that a true hang
 * fails in seconds rather than locking the app.
 */
const BOOLEAN_TIMEOUT_MS = 30_000;

const runningInNode = typeof window === 'undefined' && typeof (globalThis as { document?: unknown }).document === 'undefined';

export async function runBooleanJob(
  operation: BooleanFeature['operation'],
  operands: readonly SerializedKernelSolid[],
  revision: number,
  timeoutMs: number = BOOLEAN_TIMEOUT_MS,
): Promise<ExactSolidResult | null> {
  if (runningInNode) {
    // No worker (and no UI to protect): run inline. A hang here would hang the
    // caller, but the node paths (tests, headless automation) use clean solids.
    const { computeBooleanResult } = await import('./ExactSolid');
    const { openCascadeKernel } = await import('./OpenCascadeRuntime');
    try {
      return computeBooleanResult(await openCascadeKernel(), operation, operands, revision);
    } catch {
      return null;
    }
  }
  return runInWorker(operation, operands, revision, timeoutMs);
}

let worker: Worker | null = null;
let nextRequestId = 1;

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./booleanWorker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

/** Drop the worker so the next job starts a clean one — used after a timeout or a crash. */
function discardWorker(): void {
  worker?.terminate();
  worker = null;
}

function runInWorker(
  operation: BooleanFeature['operation'],
  operands: readonly SerializedKernelSolid[],
  revision: number,
  timeoutMs: number,
): Promise<ExactSolidResult | null> {
  const active = ensureWorker();
  const id = nextRequestId++;
  return new Promise<ExactSolidResult | null>((resolve) => {
    let settled = false;
    const finish = (value: ExactSolidResult | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      active.removeEventListener('message', onMessage);
      active.removeEventListener('error', onError);
      resolve(value);
    };
    const onMessage = (event: MessageEvent<BooleanJobResponse>): void => {
      if (event.data.id !== id) return; // a stale reply from a prior request
      finish(event.data.ok ? event.data.result : null);
    };
    const onError = (): void => {
      // The worker itself failed (bad load, out of memory). Kill it so the next
      // job rebuilds a clean one, and report the failure as a clean null.
      discardWorker();
      finish(null);
    };
    const timer = setTimeout(() => {
      // The boolean is hung. Terminate the worker — the only way to stop a blocking
      // OCCT call — and report a clean cancellation instead of a frozen app.
      discardWorker();
      finish(null);
    }, timeoutMs);
    active.addEventListener('message', onMessage);
    active.addEventListener('error', onError);
    active.postMessage({ id, operation, operands, revision } satisfies BooleanJobRequest);
  });
}
