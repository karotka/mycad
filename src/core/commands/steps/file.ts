/**
 * The file operations, as commands.
 *
 * Opening, saving, importing and exporting were reachable only from the native
 * menu, so none of them could be typed — and once a right click started
 * offering a search over the commands, "export DXF" was a thing the
 * application could do and the user could not find. Every one of them is a
 * command in AutoCAD (OPEN, SAVE, SAVEAS, DXFOUT, DXFIN, PLOT), and the names
 * here are those where AutoCAD has one.
 *
 * Each is a thin call into what the application already does for the menu:
 * the dialogs, the shell and what counts as "the current file" belong to the
 * application, not to the drawing.
 */
import type { CommandContext } from '../types';

/** Runs one file action, saying so when the application did not wire it —
 *  which is the case in a headless document, and is worth a word rather than
 *  a command that silently does nothing. */
function runFileAction(
  ctx: CommandContext,
  name: keyof NonNullable<CommandContext['file']>,
  description: string,
): void {
  const action = ctx.file?.[name];
  if (!action) {
    ctx.log(`${description} is not available here.`);
    return;
  }
  void action();
}

export const newProjectCommand = (ctx: CommandContext): void => runFileAction(ctx, 'newProject', 'Starting a new drawing');
export const openProjectCommand = (ctx: CommandContext): void => runFileAction(ctx, 'open', 'Opening a drawing');
export const saveProjectCommand = (ctx: CommandContext): void => runFileAction(ctx, 'save', 'Saving');
export const saveProjectAsCommand = (ctx: CommandContext): void => runFileAction(ctx, 'saveAs', 'Saving as');
export const exportDxfCommand = (ctx: CommandContext): void => runFileAction(ctx, 'exportDxf', 'DXF export');
export const exportGcodeCommand = (ctx: CommandContext): void => runFileAction(ctx, 'exportGcode', 'G-code export');
export const importDxfCommand = (ctx: CommandContext): void => runFileAction(ctx, 'importDxf', 'DXF import');
export const importStepCommand = (ctx: CommandContext): void => runFileAction(ctx, 'importStep', 'STEP import');
export const importExcellonCommand = (ctx: CommandContext): void => runFileAction(ctx, 'importExcellon', 'Excellon import');
export const importPdfCommand = (ctx: CommandContext): void => runFileAction(ctx, 'importPdf', 'PDF import');
export const plotCommand = (ctx: CommandContext): void => runFileAction(ctx, 'print', 'Printing');
