import { describe, expect, it, vi } from 'vitest';
import type { CommandManager } from '../core/commands/CommandManager';
import { DrawingInteractionController } from './DrawingInteractionController';

describe('DrawingInteractionController', () => {
  it('consumes a contextual snap after one drawing point', async () => {
    const commands = {
      active: { name: 'LINE', stepIndex: 0, steps: [{ kind: 'point', label: 'start' }], data: {} },
      handleClick: vi.fn(),
    } as unknown as CommandManager;
    const controller = new DrawingInteractionController(commands);
    controller.setTargetSnapMode('end');

    expect(controller.isPointStep).toBe(true);
    await controller.handleClick({ x: 1, y: 2 });

    expect(commands.handleClick).toHaveBeenCalledWith({ x: 1, y: 2 }, undefined, undefined, undefined, undefined);
    expect(controller.targetSnapMode).toBeNull();
  });

  it('uses the midpoint of two picked points for Mid between 2P', async () => {
    const commands = {
      active: { name: 'LINE', stepIndex: 0, steps: [{ kind: 'point', label: 'start' }], data: {} },
      handleClick: vi.fn(),
    } as unknown as CommandManager;
    const controller = new DrawingInteractionController(commands);
    controller.setTargetSnapMode('mid2p');

    await controller.handleClick({ x: 0, y: 2 });
    expect(commands.handleClick).not.toHaveBeenCalled();
    await controller.handleClick({ x: 10, y: 6 });

    expect(commands.handleClick).toHaveBeenCalledWith({ x: 5, y: 4 }, undefined, undefined, undefined, undefined);
    expect(controller.targetSnapMode).toBeNull();
  });
});
