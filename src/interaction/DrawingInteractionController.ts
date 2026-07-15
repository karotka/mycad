import type { CommandManager } from '../core/commands/CommandManager';
import type { Entity, SolidEdgeSelection, SolidFaceSelection } from '../core/entities/types';
import type { Vec2 } from '../math/geometry';
import type { GripMode } from './GripController';

const POINT_COMMANDS = new Set(['LINE', 'RECTANGLE', 'CIRCLE', 'POLYGON', 'ARC', 'BEZIER', 'TEXT', 'ROTATE', 'MOVE']);

export class DrawingInteractionController {
  private snapMode: GripMode | null = null;

  constructor(private readonly commands: CommandManager) {}

  get targetSnapMode(): GripMode | null { return this.snapMode; }

  get isPointStep(): boolean {
    const active = this.commands.active;
    return Boolean(active && POINT_COMMANDS.has(active.name) && active.steps[active.stepIndex]?.kind === 'point');
  }

  setTargetSnapMode(mode: GripMode | null): void { this.snapMode = mode; }

  cancel(): void { this.snapMode = null; }

  async handleClick(
    point: Vec2,
    entity?: Entity,
    solidId?: string,
    face?: SolidFaceSelection,
    edge?: SolidEdgeSelection,
  ): Promise<void> {
    const consumeSnap = this.isPointStep && this.snapMode !== null;
    await this.commands.handleClick(point, entity, solidId, face, edge);
    if (consumeSnap) this.snapMode = null;
  }
}
