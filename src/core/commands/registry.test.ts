import { describe, expect, it } from 'vitest';
import { Document } from '../Document';
import { CommandHistory } from '../history/CommandHistory';
import type { CommandContext } from './types';
import {
  COMMAND_ALIASES,
  COMMAND_LIST,
  SUGGESTED_COMMANDS,
  commandDef,
  isStickyCommand,
  takesPointInput,
  transformsObjects,
} from './registry';

/** Just enough context for the data factories, which only read the document. */
function fakeContext(): CommandContext {
  return {
    doc: new Document(),
    log: () => {}, prompt: () => {}, redraw: () => {},
    getCursor: () => ({ x: 0, y: 0 }),
    history: new CommandHistory(new Document()),
    moveObjects: () => {},
    copyWorldDelta: () => undefined,
  };
}

describe('command registry', () => {
  it('gives every command a unique name', () => {
    const names = COMMAND_LIST.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Object.fromEntries silently lets a later command steal an earlier one's
  // alias, which would reroute a shortcut with no error anywhere.
  it('never lets two commands claim the same alias', () => {
    const owners = new Map<string, string>();
    const clashes: string[] = [];
    for (const command of COMMAND_LIST) {
      for (const alias of command.aliases) {
        const existing = owners.get(alias);
        if (existing) clashes.push(`${alias}: ${existing} vs ${command.name}`);
        owners.set(alias, command.name);
      }
    }
    expect(clashes).toEqual([]);
    expect(Object.keys(COMMAND_ALIASES)).toHaveLength(owners.size);
  });

  // The ARRAY_* commands are spelled without the underscore (ARRAYRECTANGULAR),
  // so the rule is that every command is reachable, not that its exact name is.
  it('leaves every command reachable from the command line', () => {
    for (const command of COMMAND_LIST) {
      expect(command.aliases.length, `${command.name} cannot be typed`).toBeGreaterThan(0);
    }
  });

  it('resolves each declared alias back to its command', () => {
    for (const command of COMMAND_LIST) {
      for (const alias of command.aliases) expect(COMMAND_ALIASES[alias]).toBe(command.name);
    }
  });

  it('suggests only registered commands and keeps the declared order', () => {
    const order = COMMAND_LIST.filter((command) => command.suggest).map((command) => command.name);
    expect(SUGGESTED_COMMANDS).toEqual(order);
    expect(SUGGESTED_COMMANDS).not.toContain('ERASE');
    expect(SUGGESTED_COMMANDS).toContain('TORUS');
  });

  it('treats every sticky tool as taking point input', () => {
    for (const command of COMMAND_LIST) {
      if (command.sticky) expect(takesPointInput(command.name), `${command.name}`).toBe(true);
    }
  });

  it('keeps transform tools out of the sticky set', () => {
    for (const command of COMMAND_LIST) {
      if (command.transformsObjects) {
        expect(takesPointInput(command.name)).toBe(true);
        expect(isStickyCommand(command.name), `${command.name} should not restart`).toBe(false);
      }
    }
    expect(transformsObjects('MOVE')).toBe(true);
    expect(transformsObjects('LINE')).toBe(false);
  });

  it('documents every command it gives a help line', () => {
    for (const command of COMMAND_LIST) {
      if (command.help) expect(command.help.trim()).not.toBe('');
    }
    expect(commandDef('TORUS').aliases[0]).toBe('TOR');
  });
});

describe('steps declared in the registry', () => {
  it('describes a wizard that ends in exactly one done step', () => {
    for (const command of COMMAND_LIST) {
      if (!command.steps) continue;
      const done = command.steps.filter((step) => step.kind === 'done');
      expect(done, `${command.name} must end on one done step`).toHaveLength(1);
      expect(command.steps.at(-1)?.kind, `${command.name} ends on done`).toBe('done');
      for (const step of command.steps.slice(0, -1)) {
        expect(step.kind, `${command.name} has a done step in the middle`).not.toBe('done');
        expect('label' in step && step.label, `${command.name} step needs a label`).toBeTruthy();
      }
    }
  });

  // data() must mint a fresh object: a shared literal would leak vertices from
  // one polyline into the next.
  it('hands each run its own data', () => {
    for (const command of COMMAND_LIST) {
      if (!command.data) continue;
      const first = command.data(fakeContext());
      const second = command.data(fakeContext());
      expect(first, `${command.name} reuses one data object`).not.toBe(second);
      expect(first).toEqual(second);
      for (const [key, value] of Object.entries(first)) {
        if (Array.isArray(value)) {
          expect(value, `${command.name}.${key} should start empty`).toHaveLength(0);
          expect(value, `${command.name}.${key} is shared between runs`).not.toBe(second[key]);
        }
      }
    }
  });
});

describe('a command is either a wizard or an immediate action', () => {
  it('never declares both, and always declares one', () => {
    for (const command of COMMAND_LIST) {
      const kinds = [command.steps ? 'steps' : null, command.run ? 'run' : null].filter(Boolean);
      expect(kinds, `${command.name} declares ${kinds.join(' and ') || 'nothing'}`).toHaveLength(1);
    }
  });

  it('keeps onStart and data for wizards only', () => {
    for (const command of COMMAND_LIST) {
      if (command.run) {
        expect(command.onStart, `${command.name} has run and onStart`).toBeUndefined();
        expect(command.data, `${command.name} has run and data`).toBeUndefined();
      }
    }
  });

  // onStart skips a step only because the selection already answered it, so
  // there must be a step there to skip.
  it('leaves onStart a step to skip into', () => {
    for (const command of COMMAND_LIST) {
      if (!command.onStart || !command.steps) continue;
      expect(command.steps.length, `${command.name} has nothing after its first step`).toBeGreaterThan(1);
      expect(command.steps[0].kind, `${command.name} preselects into a non-object step`).toBe('entity');
    }
  });
});

describe('corner steps', () => {
  // Ortho snaps a point onto an axis through the base. For an opposite corner
  // that means zero width or depth, so BOX/WEDGE/RECTANGLE could not be drawn
  // at all once Ortho started working properly.
  it('marks every opposite-corner step so Ortho leaves it alone', () => {
    for (const name of ['RECTANGLE', 'BOX', 'WEDGE'] as const) {
      const steps = commandDef(name).steps ?? [];
      const corners = steps.filter((step) => step.kind === 'point' && step.corner);
      expect(corners, `${name} has no corner step`).toHaveLength(1);
      const label = corners[0].kind === 'point' ? corners[0].label : '';
      expect(label.toLowerCase()).toContain('corner');
    }
  });

  it('leaves radius and direction steps constrainable', () => {
    for (const name of ['LINE', 'CIRCLE', 'SPHERE', 'CYLINDER', 'TORUS'] as const) {
      for (const step of commandDef(name).steps ?? []) {
        if (step.kind === 'point') expect(step.corner, `${name}: ${step.label}`).toBeFalsy();
      }
    }
  });

  // Only the second corner is free; the first point has no base anyway.
  it('never marks the first step as a corner', () => {
    for (const command of COMMAND_LIST) {
      const first = command.steps?.[0];
      if (first?.kind === 'point') expect(first.corner, `${command.name}`).toBeFalsy();
    }
  });
});
