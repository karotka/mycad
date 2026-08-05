import initOpenCascade from 'opencascade.js/dist/node.js';
import { OpenCascadeKernel } from './OpenCascadeKernel';

/** Node-only loader used by tests and command-line migration tools. */
export async function createNodeOpenCascadeKernel(): Promise<OpenCascadeKernel> {
  return new OpenCascadeKernel(await initOpenCascade());
}
