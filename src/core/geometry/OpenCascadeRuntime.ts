import { OpenCascadeKernel } from './OpenCascadeKernel';
import type { OpenCascadeInstance } from 'opencascade.js';

let kernelPromise: Promise<OpenCascadeKernel> | null = null;

/**
 * One lazily loaded OCCT instance for the application. Browser builds receive
 * the WASM as a separate Vite chunk; Node tests use the package's filesystem
 * loader without making that Node adapter part of the renderer bundle.
 */
export function openCascadeKernel(): Promise<OpenCascadeKernel> {
  if (kernelPromise) return kernelPromise;
  const runningInNode = typeof window === 'undefined'
    || (typeof process !== 'undefined' && Boolean(process.env?.VITEST));
  kernelPromise = (runningInNode
    ? loadNodeKernel()
    : loadBrowserKernel()).catch((error) => {
      kernelPromise = null;
      throw error;
    });
  return kernelPromise;
}

async function loadBrowserKernel(): Promise<OpenCascadeKernel> {
  const [{ default: initOpenCascade }, { default: wasmUrl }] = await Promise.all([
    import('opencascade.js/dist/opencascade.full.js'),
    import('opencascade.js/dist/opencascade.full.wasm?url'),
  ]);
  const initialize = initOpenCascade as unknown as (options: {
    locateFile(path: string): string;
  }) => Promise<OpenCascadeInstance>;
  const oc = await initialize({
    locateFile: (path) => path.endsWith('.wasm') ? wasmUrl : path,
  });
  return new OpenCascadeKernel(oc);
}

async function loadNodeKernel(): Promise<OpenCascadeKernel> {
  const nodeEntry = 'opencascade.js/dist/node.js';
  const { default: initOpenCascade } = await import(/* @vite-ignore */ nodeEntry);
  return new OpenCascadeKernel(await initOpenCascade());
}
