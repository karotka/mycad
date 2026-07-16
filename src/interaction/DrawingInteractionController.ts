import type { CommandManager } from '../core/commands/CommandManager';
import type { Entity, SolidEdgeSelection, SolidFaceSelection } from '../core/entities/types';
import type { Vec2 } from '../math/geometry';
import type { ObjectSnapMode } from './SnapService';

import { takesPointInput } from '../core/commands/registry';

export class DrawingInteractionController {
  private snapMode: ObjectSnapMode | null = null;
  private midpointFirst: Vec2 | null = null;

  constructor(private readonly commands: CommandManager) {}

  get targetSnapMode(): ObjectSnapMode | null { return this.snapMode; }

  get isPointStep(): boolean {
    const active = this.commands.active;
    return Boolean(active && takesPointInput(active.name) && active.steps[active.stepIndex]?.kind === 'point');
  }

  setTargetSnapMode(mode: ObjectSnapMode | null): void {
    this.snapMode = mode;
    this.midpointFirst = null;
  }

  cancel(): void { this.snapMode = null; this.midpointFirst = null; }

  async handleClick(
    point: Vec2,
    entity?: Entity,
    solidId?: string,
    face?: SolidFaceSelection,
    edge?: SolidEdgeSelection,
  ): Promise<void> {
    if (this.snapMode === 'mid2p') {
      if (!this.midpointFirst) {
        this.midpointFirst = { ...point };
        return;
      }
      point = { x: (this.midpointFirst.x + point.x) / 2, y: (this.midpointFirst.y + point.y) / 2 };
      this.midpointFirst = null;
    }
    const consumeSnap = this.isPointStep && this.snapMode !== null;
    await this.commands.handleClick(point, entity, solidId, face, edge);
    if (consumeSnap) this.snapMode = null;
  }
}
