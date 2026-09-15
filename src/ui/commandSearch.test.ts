import { describe, expect, it } from 'vitest';
import { commandShortcut, searchCommands } from './commandSearch';
import { commandDef, COMMAND_LIST } from '../core/commands/registry';

const names = (query: string) => searchCommands(query).map((match) => match.name);

describe('searchCommands', () => {
  it('puts a name typed in full first', () => {
    expect(names('line')[0]).toBe('LINE');
    expect(names('circle')[0]).toBe('CIRCLE');
  });

  it('finds a command from the first letters of its name', () => {
    expect(names('rect')).toContain('RECTANGLE');
    expect(names('extr')).toContain('EXTRUDE');
  });

  it('finds one by its alias, the way the command line takes it', () => {
    expect(names('bo')).toContain('BOUNDARY');
    expect(names('tr')).toContain('TRIM');
  });

  it('finds one by what it does, for someone who does not know the name', () => {
    // The point of searching the help text at all.
    expect(names('parallel')).toContain('OFFSET');
    expect(names('hatch')).toContain('HATCH');
    expect(names('round')).toContain('FILLET');
  });

  it('ranks an exact name above one that merely contains the word', () => {
    const matches = names('arc');
    expect(matches[0]).toBe('ARC');
  });

  it('lists what there is when nothing has been typed yet', () => {
    const empty = searchCommands('');
    expect(empty.length).toBeGreaterThan(0);
    // Alphabetical, so the list does not jump around as letters are added.
    expect(empty.map((match) => match.name)).toEqual([...empty.map((match) => match.name)].sort());
  });

  it('finds nothing for a query no command answers to', () => {
    expect(searchCommands('zzzznotacommand')).toEqual([]);
  });

  it('keeps the list short enough to read', () => {
    expect(searchCommands('e', 5)).toHaveLength(5);
  });

  it('offers exactly what the command line offers, so nothing is unreachable', () => {
    for (const match of searchCommands('', 200)) {
      expect(commandDef(match.name).suggest, match.name).toBe(true);
      // Every one of them can say what it is; the search reads that too.
      expect(commandDef(match.name).help, match.name).toBeTruthy();
    }
  });
});

describe('commandShortcut', () => {
  it('is the shortest alias that is actually shorter than the name', () => {
    expect(commandShortcut(commandDef('RECTANGLE'))).toBe('R');
    expect(commandShortcut(commandDef('BOUNDARY'))).toBe('BO');
  });

  it('is nothing when every alias is the name itself', () => {
    const selfNamed = COMMAND_LIST.find((command) => command.aliases.every((alias) => alias.length >= command.name.length));
    if (!selfNamed) return;
    expect(commandShortcut(selfNamed)).toBeNull();
  });
});
