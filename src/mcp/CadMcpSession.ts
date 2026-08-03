import { readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { Document } from '../core/Document';
import { CommandHistory } from '../core/history/CommandHistory';
import { loadProject, serializeProject } from '../io/ProjectIO';
import { CadModelApi, type DocumentSummary } from './CadModelApi';

function checkedPath(input: string, extension: '.mycad' | '.stl'): string {
  const value = input.trim();
  if (!value) throw new Error(`A ${extension} file path is required.`);
  const path = resolve(value);
  if (extname(path).toLowerCase() !== extension) throw new Error(`Expected a ${extension} file path.`);
  return path;
}

/** A file-backed, headless alternative to the live desktop MCP bridge. */
export class CadMcpSession extends CadModelApi {
  private pathValue: string | null = null;

  constructor() {
    const document = new Document();
    super(document, new CommandHistory(document));
  }

  get projectFilePath(): string | null { return this.pathValue; }
  protected override projectPath(): string | null { return this.pathValue; }

  newDocument(): DocumentSummary {
    this.replaceDocument(new Document());
    this.pathValue = null;
    return this.summary();
  }

  async openProject(filePath: string): Promise<DocumentSummary> {
    const path = checkedPath(filePath, '.mycad');
    const next = new Document();
    loadProject(next, await readFile(path, 'utf8'));
    this.replaceDocument(next);
    this.pathValue = path;
    return this.summary();
  }

  async saveProject(filePath?: string): Promise<{ path: string; summary: DocumentSummary }> {
    const path = checkedPath(filePath ?? this.pathValue ?? '', '.mycad');
    await writeFile(path, serializeProject(this.documentValue), 'utf8');
    this.pathValue = path;
    return { path, summary: this.summary() };
  }

  async exportStl(filePath: string, solidIds?: readonly string[]): Promise<{ path: string; solidIds: string[] }> {
    const path = checkedPath(filePath, '.stl');
    const output = this.exportStlContent(solidIds);
    await writeFile(path, output.content, 'utf8');
    return { path, solidIds: output.solidIds };
  }
}

export type { DocumentSummary, McpPrimitive, PrimitiveInput, SelectionMode } from './CadModelApi';
