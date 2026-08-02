import type { Document } from '../core/Document';
import type { Entity } from '../core/entities/types';
import { ACI_BYLAYER } from './DxfAci';

export interface ExcellonImportResult {
  entities: Entity[];
  /** One layer per tool, in first-seen order, each named after its drill size. */
  layers: string[];
  /** Colour index per layer, so different drill sizes are visually distinct. */
  layerAci: Record<string, number>;
  /** Drilled holes emitted (circles). */
  holes: number;
  /** Milled slots emitted (G85 canned slots and routed paths, as polylines). */
  slots: number;
  /** Tool diameters in millimetres, keyed by their normalised number, for the report. */
  tools: Record<string, number>;
  /** Hits per tool number, so the report can name the drill sizes actually used. */
  hitsByTool: Record<string, number>;
  unit: 'inch' | 'metric';
  /** The coordinate format assumed, e.g. "2.4 LZ" — surfaced so a wrong guess is visible. */
  format: string;
  /** Body commands that carried no geometry we could place, counted by their code. */
  skipped: number;
  skippedCommands: Record<string, number>;
}

/** Holes with no tool selected land here; a real tool gets its own named layer. */
const FALLBACK_LAYER = 'drills';

// Standard AutoCAD Color Index values that read as distinct hues, cycled so each
// drill size gets its own colour without inventing an RGB palette of our own.
const TOOL_COLOURS = [1, 2, 3, 4, 6, 5, 30, 40, 8, 250];

interface Format {
  unit: 'inch' | 'metric';
  intDigits: number;
  fracDigits: number;
  /** True when trailing zeros are present in the file (leading suppressed) → pad left. */
  keepTrailing: boolean;
}

/** A tool with no diameter still needs to draw *something*, so holes stay visible and reported. */
const UNKNOWN_DIAMETER_MM = 0.3;

function scaleToMm(format: Format): number {
  return format.unit === 'inch' ? 25.4 : 1;
}

/**
 * Decode one Excellon coordinate field. Modern EDA tools write an explicit
 * decimal point, which is unambiguous; legacy integer fields rely on the header
 * format and zero-suppression mode, so we pad the missing zeros back on.
 */
function decodeCoord(raw: string, format: Format): number {
  if (raw.includes('.')) return Number.parseFloat(raw);
  let sign = 1;
  let digits = raw;
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('-')) { sign = -1; digits = digits.slice(1); }
  if (digits === '') return 0;
  const width = format.intDigits + format.fracDigits;
  // Trailing zeros present → the value is right-justified, pad the dropped leading
  // zeros on the left. Leading zeros present → pad the dropped trailing zeros right.
  const padded = format.keepTrailing ? digits.padStart(width, '0') : digits.padEnd(width, '0');
  return sign * Number.parseInt(padded, 10) / 10 ** format.fracDigits;
}

/** Pull the coordinate-format digit counts out of a token like "000.000" or "2:4". */
function parseFormatDigits(token: string): { intDigits: number; fracDigits: number } | undefined {
  // A zero run around a dot ("00.0000") states the field widths by length.
  const zeros = /^(0+)\.(0+)$/.exec(token);
  if (zeros) return { intDigits: zeros[1].length, fracDigits: zeros[2].length };
  // The "int:frac" form (KiCad comments) states the widths as counts.
  const counts = /^(\d+):(\d+)$/.exec(token);
  if (counts) return { intDigits: Number(counts[1]), fracDigits: Number(counts[2]) };
  return undefined;
}

type Token = { letter: string; value: string };

/** Split "X0025Y0025G85" into ordered letter/number tokens. */
function tokenise(line: string): Token[] {
  const tokens: Token[] = [];
  const matcher = /([A-Za-z])([+-]?[0-9]*\.?[0-9]*)/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(line)) !== null) {
    if (match[1]) tokens.push({ letter: match[1].toUpperCase(), value: match[2] });
  }
  return tokens;
}

/** Parse the header: units, zero-suppression mode, coordinate format and the tool table. */
function readHeader(lines: string[], tools: Record<string, number>): Format {
  const format: Format = { unit: 'inch', intDigits: 2, fracDigits: 4, keepTrailing: true };
  let unitSeen = false;

  const applyUnit = (unit: 'inch' | 'metric'): void => {
    format.unit = unit;
    if (!unitSeen) { format.intDigits = unit === 'inch' ? 2 : 3; format.fracDigits = unit === 'inch' ? 4 : 3; }
    unitSeen = true;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // KiCad states the format explicitly in a comment: ";FILE_FORMAT=2:4".
    const formatComment = /FILE_FORMAT\s*=\s*(\d+):(\d+)/i.exec(trimmed);
    if (formatComment) { format.intDigits = Number(formatComment[1]); format.fracDigits = Number(formatComment[2]); }
    if (trimmed.startsWith(';')) continue;

    const upper = trimmed.toUpperCase();
    const parts = upper.split(',').map((part) => part.trim());
    if (parts.includes('METRIC') || upper === 'M71') applyUnit('metric');
    if (parts.includes('INCH') || upper === 'M72') applyUnit('inch');
    if (parts.includes('LZ')) format.keepTrailing = false; // leading zeros present
    if (parts.includes('TZ')) format.keepTrailing = true; // trailing zeros present
    for (const part of parts) {
      const digits = parseFormatDigits(part);
      if (digits) { format.intDigits = digits.intDigits; format.fracDigits = digits.fracDigits; }
    }

    // Tool definition: T<number>C<diameter>, plus optional feed/speed we ignore.
    const def = /^T(\d+).*?C([0-9]*\.?[0-9]+)/.exec(upper);
    if (def) tools[String(Number(def[1]))] = Number(def[2]);
  }
  return format;
}

export function importExcellon(doc: Document, text: string): ExcellonImportResult {
  const rawLines = text.replace(/\r/g, '').split('\n');

  // Header runs from M48 (or file start) to the "%" / M95 rewind marker; the body
  // follows. Files without an M48 header are treated as body-only, with tool
  // definitions still recognised wherever they appear.
  const hasHeader = rawLines.some((line) => line.trim().toUpperCase() === 'M48');
  let bodyStart = 0;
  if (hasHeader) {
    const marker = rawLines.findIndex((line) => {
      const t = line.trim().toUpperCase();
      return t === '%' || t === 'M95';
    });
    bodyStart = marker >= 0 ? marker + 1 : rawLines.length;
  }

  const tools: Record<string, number> = {};
  const format = readHeader(rawLines.slice(0, bodyStart || rawLines.length), tools);
  const scale = scaleToMm(format);

  const entities: Entity[] = [];
  const hitsByTool: Record<string, number> = {};
  const skippedCommands: Record<string, number> = {};
  const layers: string[] = [];
  const layerAci: Record<string, number> = {};
  const layerForTool: Record<string, string> = {};
  let holes = 0;
  let slots = 0;
  let skipped = 0;

  let currentTool = '';
  let incremental = false;
  let routeMode = false; // G00/G01 milling instead of drilling
  let toolDown = false;
  let last = { x: 0, y: 0 };
  let routePath: Array<{ x: number; y: number }> = [];

  const skip = (code: string): void => { skipped++; skippedCommands[code] = (skippedCommands[code] ?? 0) + 1; };

  const diameterOf = (tool: string): number =>
    (tools[tool] !== undefined ? tools[tool] * scale : UNKNOWN_DIAMETER_MM);

  // Each tool gets its own layer, named after its drill size and registered with
  // a distinct colour the first time it is used. Holes with no tool selected
  // share one fallback layer rather than inventing a name from nothing.
  const layerFor = (tool: string): string => {
    if (layerForTool[tool] !== undefined) return layerForTool[tool];
    let name = FALLBACK_LAYER;
    if (tool) {
      name = tools[tool] !== undefined
        ? `drill T${tool} ${(tools[tool] * scale).toFixed(2)}mm`
        : `drill T${tool}`;
    }
    layerForTool[tool] = name;
    if (!layers.includes(name)) {
      layerAci[name] = TOOL_COLOURS[layers.length % TOOL_COLOURS.length];
      layers.push(name);
    }
    return name;
  };

  const place = (entity: Entity, layer: string): void => {
    entity.layer = layer;
    entity.aci = ACI_BYLAYER;
    entities.push(entity);
  };

  const emitHole = (point: { x: number; y: number }): void => {
    place(doc.createCircle(point, diameterOf(currentTool) / 2), layerFor(currentTool));
    holes++;
    if (currentTool) hitsByTool[currentTool] = (hitsByTool[currentTool] ?? 0) + 1;
  };

  const flushRoute = (): void => {
    if (routePath.length >= 2) { place(doc.createPolyline(routePath, false), layerFor(currentTool)); slots++; }
    routePath = [];
  };

  for (let index = bodyStart; index < rawLines.length; index++) {
    const line = rawLines[index].trim();
    if (line === '' || line.startsWith(';') || line === '%') continue;

    const tokens = tokenise(line);
    if (tokens.length === 0) continue;

    // Standalone codes with no coordinates: tool change, mode and program flow.
    const has = (letter: string, value?: string): boolean =>
      tokens.some((t) => t.letter === letter && (value === undefined || t.value === value));
    const gCodes = tokens.filter((t) => t.letter === 'G').map((t) => t.value.padStart(2, '0'));
    const mCodes = tokens.filter((t) => t.letter === 'M').map((t) => t.value.padStart(2, '0'));

    for (const g of gCodes) {
      if (g === '90') incremental = false;
      else if (g === '91') incremental = true;
      else if (g === '00' || g === '01') routeMode = true;
      else if (g === '05' || g === '81') routeMode = false; // drill mode
    }
    for (const m of mCodes) {
      if (m === '71') { /* handled in header, ignore mid-body unit noise */ }
      else if (m === '15') { toolDown = true; routePath = [last]; }
      else if (m === '16') { toolDown = false; flushRoute(); }
      else if (m === '30' || m === '00') { flushRoute(); }
    }

    // A tool token selects (or, with a C diameter, also defines) the tool.
    const toolToken = tokens.find((t) => t.letter === 'T');
    if (toolToken) {
      flushRoute();
      const def = /C([0-9]*\.?[0-9]+)/.exec(line.toUpperCase());
      const num = String(Number(toolToken.value || '0'));
      if (def) tools[num] = Number(def[1]);
      currentTool = num === '0' ? '' : num; // T00 deselects
    }

    // Coordinate handling. A G85 splits the line into a start point and an end
    // point, cut as a slot; otherwise the X/Y (with modal fill-in) is one action.
    const g85 = tokens.findIndex((t) => t.letter === 'G' && t.value.padStart(2, '0') === '85');
    const pointFrom = (slice: Token[]): { x: number; y: number } | undefined => {
      const xt = slice.find((t) => t.letter === 'X');
      const yt = slice.find((t) => t.letter === 'Y');
      if (!xt && !yt) return undefined;
      const x = xt ? decodeCoord(xt.value, format) * scale : (incremental ? 0 : last.x);
      const y = yt ? decodeCoord(yt.value, format) * scale : (incremental ? 0 : last.y);
      return incremental ? { x: last.x + x, y: last.y + y } : { x, y };
    };

    if (g85 >= 0) {
      const start = pointFrom(tokens.slice(0, g85)) ?? last;
      const end = pointFrom(tokens.slice(g85 + 1)) ?? start;
      place(doc.createLine(start, end), layerFor(currentTool));
      slots++;
      last = end;
      continue;
    }

    const point = pointFrom(tokens);
    if (point) {
      last = point;
      if (routeMode) {
        // In milling mode a move only cuts while the tool is down (between M15/M16).
        if (toolDown) routePath.push(point);
      } else if (currentTool || Object.keys(tools).length === 0) {
        emitHole(point);
      } else {
        skip('X/Y with no tool selected');
      }
      continue;
    }

    // Lines that were only mode/flow codes are expected; anything else is noted.
    if (gCodes.length === 0 && mCodes.length === 0 && !toolToken) skip(tokens[0].letter + tokens[0].value);
  }

  flushRoute();

  return {
    entities,
    layers,
    layerAci,
    holes,
    slots,
    tools,
    hitsByTool,
    unit: format.unit,
    format: `${format.intDigits}.${format.fracDigits} ${format.keepTrailing ? 'TZ' : 'LZ'}`,
    skipped,
    skippedCommands,
  };
}
