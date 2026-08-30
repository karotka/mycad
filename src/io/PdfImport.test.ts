import { describe, expect, it } from 'vitest';
import { Document } from '../core/Document';
import { importPdfEntities } from './PdfImport';

/** A minimal hand-written PDF — no real writer needed to exercise the
 *  importer, and pdf.js recovers a missing/wrong xref table by scanning the
 *  file for `N 0 obj` anyway, so the classic table is skipped here too. */
function minimalPdf(contentStream: string, resources = '<< >>'): Uint8Array {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources ${resources} >>
endobj
4 0 obj
<< /Length ${contentStream.length} >>
stream
${contentStream}endstream
endobj
trailer
<< /Size 5 /Root 1 0 R >>
%%EOF
`;
  return new TextEncoder().encode(pdf);
}

const PT_TO_MM = 25.4 / 72;

describe('importPdfEntities', () => {
  it('imports a straight two-point path as a line, in millimetres', async () => {
    const doc = new Document();
    const bytes = minimalPdf('100 100 m\n200 200 l\nS\n');
    const result = await importPdfEntities(doc, bytes);

    expect(result.entities).toHaveLength(1);
    const [line] = result.entities;
    expect(line).toMatchObject({ type: 'line', start: { x: 100 * PT_TO_MM, y: 100 * PT_TO_MM }, end: { x: 200 * PT_TO_MM, y: 200 * PT_TO_MM } });
    expect(result.pageCount).toBe(1);
    expect(result.skippedImages).toBe(0);
  });

  it('imports a closed rectangle path as a closed polyline', async () => {
    const doc = new Document();
    const bytes = minimalPdf('10 10 100 50 re\nS\n');
    const result = await importPdfEntities(doc, bytes);

    expect(result.entities).toHaveLength(1);
    const [polyline] = result.entities;
    expect(polyline.type).toBe('polyline');
    if (polyline.type === 'polyline') {
      expect(polyline.closed).toBe(true);
      // createPolyline keeps a closing duplicate of the first vertex for a
      // closed polyline — the corners are the first four.
      const corners = [{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 60 }, { x: 10, y: 60 }];
      polyline.vertices.slice(0, 4).forEach((vertex, index) => {
        expect(vertex.x).toBeCloseTo(corners[index].x * PT_TO_MM, 6);
        expect(vertex.y).toBeCloseTo(corners[index].y * PT_TO_MM, 6);
      });
    }
  });

  it('imports a curved path as an exact Bezier chain, not a sampled polyline', async () => {
    const doc = new Document();
    const bytes = minimalPdf('0 0 m\n50 0 25 50 50 50 c\nS\n');
    const result = await importPdfEntities(doc, bytes);

    expect(result.entities).toHaveLength(1);
    const [spline] = result.entities;
    expect(spline.type).toBe('bezier');
    if (spline.type === 'bezier') {
      expect(spline.segments).toHaveLength(1);
      const segment = spline.segments[0];
      expect(segment.control1).toMatchObject({ x: expect.closeTo(50 * PT_TO_MM, 6), y: expect.closeTo(0, 6) });
      expect(segment.control2).toMatchObject({ x: expect.closeTo(25 * PT_TO_MM, 6), y: expect.closeTo(50 * PT_TO_MM, 6) });
      expect(segment.end).toMatchObject({ x: expect.closeTo(50 * PT_TO_MM, 6), y: expect.closeTo(50 * PT_TO_MM, 6) });
    }
  });

  it('respects the current transform when placing a path', async () => {
    const doc = new Document();
    const bytes = minimalPdf('1 0 0 1 50 50 cm\n0 0 m\n10 0 l\nS\n');
    const result = await importPdfEntities(doc, bytes);

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      type: 'line',
      start: { x: expect.closeTo(50 * PT_TO_MM, 6), y: expect.closeTo(50 * PT_TO_MM, 6) },
      end: { x: expect.closeTo(60 * PT_TO_MM, 6), y: expect.closeTo(50 * PT_TO_MM, 6) },
    });
  });

  it('restores a transform pushed by q/Q, not leaving it applied to later paths', async () => {
    const doc = new Document();
    const bytes = minimalPdf('q\n1 0 0 1 100 100 cm\n0 0 m\n1 0 l\nS\nQ\n0 0 m\n5 0 l\nS\n');
    const result = await importPdfEntities(doc, bytes);

    expect(result.entities).toHaveLength(2);
    expect(result.entities[1]).toMatchObject({ type: 'line', start: { x: 0, y: 0 } });
  });

  it('defaults to black — PDF\'s own default color — rather than the document\'s BYLAYER color', async () => {
    const doc = new Document();
    const bytes = minimalPdf('100 100 m\n200 200 l\nS\n');
    const result = await importPdfEntities(doc, bytes);

    expect(result.entities[0]).toMatchObject({ color: 0x000000 });
  });

  it('reads a stroked path\'s color off the stroke color, not the fill color', async () => {
    const doc = new Document();
    const bytes = minimalPdf('1 0 0 RG\n0 1 0 rg\n100 100 m\n200 200 l\nS\n');
    const result = await importPdfEntities(doc, bytes);

    expect(result.entities[0]).toMatchObject({ color: 0xff0000 });
  });

  it('reads a filled-only path\'s color off the fill color', async () => {
    const doc = new Document();
    const bytes = minimalPdf('1 0 0 RG\n0 0 1 rg\n0 0 100 50 re\nf\n');
    const result = await importPdfEntities(doc, bytes);

    expect(result.entities[0]).toMatchObject({ color: 0x0000ff });
  });

  it('restores the color pushed by q/Q along with the transform, not leaking it to later paths', async () => {
    const doc = new Document();
    const bytes = minimalPdf('q\n1 0 0 RG\n0 0 m\n1 0 l\nS\nQ\n0 0 m\n2 0 l\nS\n');
    const result = await importPdfEntities(doc, bytes);

    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]).toMatchObject({ color: 0xff0000 });
    expect(result.entities[1]).toMatchObject({ color: 0x000000 });
  });

  it('imports text as a TEXT entity at its own position', async () => {
    const doc = new Document();
    const bytes = minimalPdf(
      'BT\n/F1 12 Tf\n1 0 0 1 100 200 Tm\n(Hello CAD) Tj\nET\n',
      '<< /Font << /F1 5 0 R >> >>',
    );
    // The font object referenced by the content stream — a minimal Type1 base font.
    const pdf = new TextDecoder().decode(bytes).replace(
      'trailer',
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\ntrailer',
    );
    const result = await importPdfEntities(doc, new TextEncoder().encode(pdf));

    const text = result.entities.find((entity) => entity.type === 'text');
    expect(text).toBeDefined();
    if (text?.type === 'text') {
      expect(text.text).toBe('Hello CAD');
      expect(text.position.x).toBeCloseTo(100 * PT_TO_MM, 6);
      expect(text.position.y).toBeCloseTo(200 * PT_TO_MM, 6);
    }
  });

  it('counts skipped raster images instead of importing them', async () => {
    const doc = new Document();
    const bytes = minimalPdf(
      'q\n50 0 0 50 10 10 cm\n/Im1 Do\nQ\n',
      '<< /XObject << /Im1 6 0 R >> >>',
    );
    const pdf = new TextDecoder().decode(bytes).replace(
      'trailer',
      '6 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x00\nendstream\nendobj\ntrailer',
    );
    const result = await importPdfEntities(doc, new TextEncoder().encode(pdf));

    expect(result.entities).toHaveLength(0);
    expect(result.skippedImages).toBe(1);
  });
});
