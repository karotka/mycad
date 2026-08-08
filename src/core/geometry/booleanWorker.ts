/**
 * The boolean worker. It owns its own OCCT instance and runs the fuse/cut/common
 * off the main thread, so a boolean that hangs OCCT can be killed with
 * `worker.terminate()` without ever freezing the UI. Operands arrive and the
 * result leaves as serialised B-reps plus a plain mesh — everything structured
 * cloning can carry — so no OCCT handle ever crosses the thread boundary.
 */
import { computeBooleanResult } from './ExactSolid';
import { openCascadeKernelForWorker } from './OpenCascadeRuntime';
import type { BooleanJobRequest, BooleanJobResponse } from './booleanJob';

self.addEventListener('message', (event: MessageEvent<BooleanJobRequest>) => {
  const { id, operation, operands, revision } = event.data;
  void (async () => {
    let response: BooleanJobResponse;
    try {
      const kernel = await openCascadeKernelForWorker();
      response = { id, ok: true, result: computeBooleanResult(kernel, operation, operands, revision) };
    } catch (error) {
      response = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    (self as unknown as Worker).postMessage(response);
  })();
});
