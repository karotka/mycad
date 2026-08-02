import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { importExcellon } from './ExcellonImport';
import type { CircleEntity, LineEntity } from '../core/entities/types';

const circles = (entities: { type: string }[]) => entities.filter((e) => e.type === 'circle') as CircleEntity[];

describe('Excellon import', () => {
  it('places a circle per drill hit, sized to its tool diameter', () => {
    const doc = new Document();
    const result = importExcellon(doc, [
      'M48',
      'METRIC,TZ',
      'T1C0.800',
      'T2C1.200',
      '%',
      'G90',
      'G05',
      'T1',
      'X1.0Y1.0',
      'X2.0Y1.0',
      'T2',
      'X3.0Y3.0',
      'M30',
    ].join('\n'));

    expect(result.holes).toBe(3);
    expect(result.unit).toBe('metric');
    expect(result.tools).toEqual({ 1: 0.8, 2: 1.2 });
    expect(result.hitsByTool).toEqual({ 1: 2, 2: 1 });
    const c = circles(result.entities);
    expect(c.map((e) => e.radius)).toEqual([0.4, 0.4, 0.6]);
    expect(c[0].center).toEqual({ x: 1, y: 1 });
    expect(c[2].center).toEqual({ x: 3, y: 3 });
    // Each tool gets its own named layer, and each of its holes lands there.
    expect(result.layers).toEqual(['drill T1 0.80mm', 'drill T2 1.20mm']);
    expect(c[0].layer).toBe('drill T1 0.80mm');
    expect(c[2].layer).toBe('drill T2 1.20mm');
    expect(result.layerAci['drill T1 0.80mm']).not.toBe(result.layerAci['drill T2 1.20mm']);
  });

  it('converts inch coordinates and diameters to millimetres', () => {
    const doc = new Document();
    const result = importExcellon(doc, [
      'M48', 'INCH,TZ', 'T1C0.040', '%', 'T1', 'X1.0Y0.0', 'M30',
    ].join('\n'));
    expect(result.unit).toBe('inch');
    const [hole] = circles(result.entities);
    expect(hole.center.x).toBeCloseTo(25.4, 6);
    expect(hole.radius).toBeCloseTo(0.04 * 25.4 / 2, 6);
  });

  it('decodes integer coordinates with trailing-zero (TZ) suppression', () => {
    // 2.4 inch format, TZ → leading zeros dropped: "015000" written as "15000" = 1.5 in.
    const doc = new Document();
    const result = importExcellon(doc, [
      'M48', 'INCH,TZ', '00.0000', 'T1C0.1', '%', 'T1', 'X15000Y10000', 'M30',
    ].join('\n'));
    const [hole] = circles(result.entities);
    expect(hole.center.x).toBeCloseTo(1.5 * 25.4, 6);
    expect(hole.center.y).toBeCloseTo(1.0 * 25.4, 6);
    expect(result.format).toContain('TZ');
  });

  it('decodes integer coordinates with leading-zero (LZ) suppression', () => {
    // LZ → trailing zeros dropped: "0150" pads right to "015000" = 1.5 in.
    const doc = new Document();
    const result = importExcellon(doc, [
      'M48', 'INCH,LZ', '00.0000', 'T1C0.1', '%', 'T1', 'X0150Y0100', 'M30',
    ].join('\n'));
    const [hole] = circles(result.entities);
    expect(hole.center.x).toBeCloseTo(1.5 * 25.4, 6);
    expect(hole.center.y).toBeCloseTo(1.0 * 25.4, 6);
  });

  it('fills omitted coordinates from the previous hit (modal X/Y)', () => {
    const doc = new Document();
    const result = importExcellon(doc, [
      'M48', 'METRIC,TZ', 'T1C0.5', '%', 'T1', 'X5.0Y5.0', 'X8.0', 'Y9.0', 'M30',
    ].join('\n'));
    expect(circles(result.entities).map((e) => e.center)).toEqual([
      { x: 5, y: 5 }, { x: 8, y: 5 }, { x: 8, y: 9 },
    ]);
  });

  it('reads the KiCad FILE_FORMAT comment for integer decoding', () => {
    const doc = new Document();
    const result = importExcellon(doc, [
      'M48', ';FILE_FORMAT=3:3', 'METRIC,TZ', 'T1C0.5', '%', 'T1', 'X001500Y002000', 'M30',
    ].join('\n'));
    const [hole] = circles(result.entities);
    expect(hole.center).toEqual({ x: 1.5, y: 2 });
  });

  it('imports a G85 canned slot as a line between its two points', () => {
    const doc = new Document();
    const result = importExcellon(doc, [
      'M48', 'METRIC,TZ', 'T1C0.5', '%', 'T1', 'X1.0Y1.0G85X4.0Y1.0', 'M30',
    ].join('\n'));
    expect(result.slots).toBe(1);
    expect(result.holes).toBe(0);
    const [line] = result.entities.filter((e) => e.type === 'line') as LineEntity[];
    expect(line.start).toEqual({ x: 1, y: 1 });
    expect(line.end).toEqual({ x: 4, y: 1 });
  });

  it('imports a routed path (M15/M16) as a polyline', () => {
    const doc = new Document();
    const result = importExcellon(doc, [
      'M48', 'METRIC,TZ', 'T1C0.5', '%', 'T1', 'G00X0.0Y0.0', 'M15',
      'G01X10.0Y0.0', 'G01X10.0Y10.0', 'M16', 'M30',
    ].join('\n'));
    expect(result.slots).toBe(1);
    const polyline = result.entities.find((e) => e.type === 'polyline');
    expect(polyline).toBeTruthy();
    expect((polyline as { vertices: unknown[] }).vertices).toHaveLength(3);
  });

  it('deselects the tool on T00 and stops drilling after M30', () => {
    const doc = new Document();
    const result = importExcellon(doc, [
      'M48', 'METRIC,TZ', 'T1C0.5', '%', 'T1', 'X1.0Y1.0', 'T00', 'X2.0Y2.0', 'M30',
    ].join('\n'));
    expect(result.holes).toBe(1);
    expect(result.skipped).toBeGreaterThan(0);
  });
});
