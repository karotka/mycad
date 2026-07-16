import { describe, expect, it, vi } from 'vitest';
import { Document } from '../Document';
import { CommandHistory } from '../history/CommandHistory';
import { CommandManager } from './CommandManager';

/**
 * What happens when the 3D engine will not load.
 *
 * Every boolean, extrusion and sweep waits on manifold's WASM, and not one of
 * the five call sites caught anything. A failure escaped as an unhandled
 * rejection: the height typed into an EXTRUDE went nowhere, the prompt asked
 * for it again, and nothing anywhere said why — indistinguishable from the
 * command ignoring you. Its own file because the module has to be mocked before
 * anything imports it.
 */
vi.mock('manifold-3d', () => ({
  default: () => Promise.reject(new Error('WebAssembly.instantiate(): failed to fetch')),
}));

function setup() {
  const doc = new Document();
  const log = vi.fn();
  const prompt = vi.fn();
  const manager = new CommandManager({
    doc,
    history: new CommandHistory(doc),
    moveObjects: vi.fn(),
    copyWorldDelta: () => undefined,
    log,
    prompt,
    getCursor: () => ({ x: 0, y: 0 }),
    redraw: vi.fn(),
  });
  return { doc, manager, log, prompt };
}

const lines = (log: ReturnType<typeof vi.fn>) => log.mock.calls.map((call) => String(call[0]));

describe('when the 3D engine cannot be loaded', () => {
  it('says so rather than swallowing the height', async () => {
    const { doc, manager, log } = setup();
    const profile = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    doc.addEntity(profile);

    manager.startCommand('EXTRUDE');
    await manager.handleClick({ x: 5, y: 2 }, profile);
    await manager.submitInput('10');

    const failure = lines(log).find((line) => line.includes('failed'));
    expect(failure, `log said: ${lines(log).join(' | ')}`).toBeDefined();
    expect(failure).toContain('EXTRUDE failed');
    // Naming the thing that broke, because "failed" alone sends you looking at
    // your profile when the profile was never the problem.
    expect(failure).toContain('manifold');
  });

  it('leaves the command where it was, so the height can be tried again', async () => {
    const { doc, manager, prompt } = setup();
    const profile = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    doc.addEntity(profile);

    manager.startCommand('EXTRUDE');
    await manager.handleClick({ x: 5, y: 2 }, profile);
    await manager.submitInput('10');

    expect(manager.active).toMatchObject({ name: 'EXTRUDE', stepIndex: 1 });
    expect(prompt).toHaveBeenLastCalledWith(expect.stringContaining('height'));
  });

  it('tries again next time rather than caching the failure', async () => {
    const { doc, manager, log } = setup();
    const profile = doc.createRectangle({ x: 0, y: 0 }, { x: 10, y: 5 });
    doc.addEntity(profile);
    manager.startCommand('EXTRUDE');
    await manager.handleClick({ x: 5, y: 2 }, profile);

    await manager.submitInput('10');
    await manager.submitInput('10');

    // A rejected promise left in the cache would settle every later attempt
    // with the same error without ever reaching the loader again, so one bad
    // load would poison the session. Two reports means two real attempts.
    expect(lines(log).filter((line) => line.includes('failed'))).toHaveLength(2);
  });
});
