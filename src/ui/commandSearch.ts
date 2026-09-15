/**
 * Finding a command by typing a bit of it.
 *
 * The command line already completes a name you are part-way through; this is
 * the other half of the problem — knowing what a thing is called well enough to
 * start typing it. Searching the short name, every alias and the one-line help
 * means "round" finds FILLET and "parallel" finds OFFSET, which is what someone
 * who does not yet know the name has to go on.
 *
 * Ranking, best first: a name typed in full, then a name that starts with what
 * was typed, then an alias, then a name that merely contains it, then a match
 * in the help text. Within a rank, alphabetical — so the list does not shuffle
 * as a letter is added.
 */
import { COMMAND_LIST, type CommandDef, type CommandName } from '../core/commands/registry';

export interface CommandMatch {
  name: CommandName;
  /** What to show: the shortest alias, when it is shorter than the name. */
  shortcut: string | null;
  help: string;
}

/** Where the query was found, smaller is better; see the file comment. */
function rank(command: CommandDef, query: string): number {
  const name = command.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (command.aliases.some((alias) => alias.toLowerCase().startsWith(query))) return 2;
  if (name.includes(query)) return 3;
  if (command.help?.toLowerCase().includes(query)) return 4;
  return Number.POSITIVE_INFINITY;
}

/** The shortest alias that is actually shorter than the name — what the
 *  command line would accept as a shortcut, or nothing when there is none. */
export function commandShortcut(command: CommandDef): string | null {
  const shortest = command.aliases
    .filter((alias) => alias.length < command.name.length)
    .sort((a, b) => a.length - b.length)[0];
  return shortest ?? null;
}

/**
 * Commands matching `query`, best first. An empty query lists everything a
 * user is meant to reach this way, so the box opens as a menu of what there is
 * rather than as a blank.
 */
export function searchCommands(query: string, limit = 12): CommandMatch[] {
  const needle = query.trim().toLowerCase();
  // Everything the command line itself offers, so nothing is reachable by
  // typing its name and unreachable by searching for it.
  const offered = COMMAND_LIST.filter((command) => command.suggest);
  const ranked = needle
    ? offered
      .map((command) => ({ command, rank: rank(command, needle) }))
      .filter((entry) => Number.isFinite(entry.rank))
    : offered.map((command) => ({ command, rank: 0 }));
  ranked.sort((a, b) => a.rank - b.rank || a.command.name.localeCompare(b.command.name));
  return ranked.slice(0, limit).map(({ command }) => ({
    name: command.name,
    shortcut: commandShortcut(command),
    help: command.help ?? '',
  }));
}
