import type { Document } from '../core/Document';
import type { Entity } from '../core/entities/types';

type Pair = { code: number; value: string };

export interface DxfImportResult {
  entities: Entity[];
  layers: string[];
  ignored: number;
  unitScale: number;
}

function pairsFromText(text: string): Pair[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const pairs: Pair[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10);
    if (Number.isFinite(code)) pairs.push({ code, value: lines[index + 1].trim() });
  }
  return pairs;
}

function millimetreScale(pairs: Pair[]): number {
  const units: Record<number, number> = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 7: 1_000_000 };
  const marker = pairs.findIndex((pair) => pair.code === 9 && pair.value === '$INSUNITS');
  if (marker < 0) return 1;
  const unitPair = pairs.slice(marker + 1, marker + 6).find((pair) => pair.code === 70);
  return units[Number(unitPair?.value)] ?? 1;
}

export function importAsciiDxf(doc: Document, text: string): DxfImportResult {
  const pairs = pairsFromText(text);
  if (pairs.length === 0) throw new Error('The DXF file is empty or not an ASCII DXF file.');
  const scale = millimetreScale(pairs);
  const section = pairs.findIndex((pair, index) => pair.code === 2 && pair.value === 'ENTITIES' && pairs[index - 1]?.code === 0 && pairs[index - 1]?.value === 'SECTION');
  if (section < 0) throw new Error('DXF ENTITIES section was not found. Binary DXF is not supported.');
  const entities: Entity[] = [];
  const layers = new Set<string>();
  let ignored = 0;
  const number = (fields: Pair[], code: number, fallback = 0): number => {
    const value = Number(fields.find((pair) => pair.code === code)?.value);
    return Number.isFinite(value) ? value : fallback;
  };
  const layerOf = (fields: Pair[]): string => fields.find((pair) => pair.code === 8)?.value || '0';
  const finish = (entity: Entity, layer: string): void => {
    entity.layer = layer;
    entity.color = doc.layerColors[layer] ?? 0xffffff;
    entities.push(entity);
    layers.add(layer);
  };

  for (let index = section + 1; index < pairs.length;) {
    if (pairs[index].code !== 0) { index++; continue; }
    const type = pairs[index].value.toUpperCase();
    if (type === 'ENDSEC') break;
    let end = index + 1;
    while (end < pairs.length && pairs[end].code !== 0) end++;
    const fields = pairs.slice(index + 1, end);
    const layer = layerOf(fields);
    if (type === 'LINE') {
      finish(doc.createLine(
        { x: number(fields, 10) * scale, y: number(fields, 20) * scale },
        { x: number(fields, 11) * scale, y: number(fields, 21) * scale },
      ), layer);
    } else if (type === 'CIRCLE') {
      finish(doc.createCircle({ x: number(fields, 10) * scale, y: number(fields, 20) * scale }, number(fields, 40) * scale), layer);
    } else if (type === 'ARC') {
      const start = number(fields, 50) * Math.PI / 180;
      const endAngle = number(fields, 51) * Math.PI / 180;
      let sweep = endAngle - start;
      while (sweep <= 0) sweep += Math.PI * 2;
      finish(doc.createArc({ x: number(fields, 10) * scale, y: number(fields, 20) * scale }, number(fields, 40) * scale, start, sweep), layer);
    } else if (type === 'LWPOLYLINE') {
      const vertices: Array<{ x: number; y: number }> = [];
      let current: { x: number; y: number } | null = null;
      fields.forEach((pair) => {
        if (pair.code === 10) {
          current = { x: Number(pair.value) * scale, y: 0 };
          vertices.push(current);
        } else if (pair.code === 20 && current) current.y = Number(pair.value) * scale;
      });
      if (vertices.length >= 2) finish(doc.createPolyline(vertices, (number(fields, 70) & 1) === 1), layer);
      else ignored++;
    } else if (type === 'POLYLINE') {
      const vertices: Array<{ x: number; y: number }> = [];
      let cursor = end;
      while (cursor < pairs.length && pairs[cursor].code === 0 && pairs[cursor].value.toUpperCase() === 'VERTEX') {
        let vertexEnd = cursor + 1;
        while (vertexEnd < pairs.length && pairs[vertexEnd].code !== 0) vertexEnd++;
        const vertex = pairs.slice(cursor + 1, vertexEnd);
        vertices.push({ x: number(vertex, 10) * scale, y: number(vertex, 20) * scale });
        cursor = vertexEnd;
      }
      if (vertices.length >= 2) finish(doc.createPolyline(vertices, (number(fields, 70) & 1) === 1), layer);
      else ignored++;
      while (cursor < pairs.length && !(pairs[cursor].code === 0 && pairs[cursor].value.toUpperCase() === 'SEQEND')) cursor++;
      end = Math.min(pairs.length, cursor + 1);
    } else if (!['VERTEX', 'SEQEND'].includes(type)) ignored++;
    index = end;
  }
  return { entities, layers: [...layers], ignored, unitScale: scale };
}
