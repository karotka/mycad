/**
 * Renders the solids in a .mycad file to a PNG, so a model can be looked at
 * without opening the app.
 *
 * Run: npx vite-node scripts/preview.ts [input.mycad] [output.png]
 *
 * Three orthographic views with a z-buffer and flat shading. Not pretty, and
 * not meant to be — it exists so that whoever is building a shape can see what
 * they built, which beats describing it and hoping.
 */
import { deflateSync } from 'zlib';
import { readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface View {
  label: string;
  /** Which world axes go right and up, and which way is into the screen. */
  right: (p: number[]) => number;
  up: (p: number[]) => number;
  depth: (p: number[]) => number;
}

const VIEWS: View[] = [
  { label: 'side', right: (p) => p[0], up: (p) => p[2], depth: (p) => p[1] },
  { label: 'top', right: (p) => p[0], up: (p) => p[1], depth: (p) => -p[2] },
  { label: 'front', right: (p) => p[1], up: (p) => p[2], depth: (p) => -p[0] },
];

const PANEL = 460;
const HEIGHT = 340;

function render(positions: number[], indices: number[]): { pixels: Uint8Array; width: number; height: number } {
  const width = PANEL * VIEWS.length;
  const pixels = new Uint8Array(width * HEIGHT).fill(22);

  VIEWS.forEach((view, panel) => {
    const vertex = (index: number): number[] => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]];

    let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
    for (let i = 0; i < positions.length / 3; i++) {
      const p = vertex(i);
      minR = Math.min(minR, view.right(p)); maxR = Math.max(maxR, view.right(p));
      minU = Math.min(minU, view.up(p)); maxU = Math.max(maxU, view.up(p));
    }
    const scale = Math.min((PANEL - 24) / (maxR - minR), (HEIGHT - 24) / (maxU - minU));
    const offsetR = panel * PANEL + (PANEL - (maxR - minR) * scale) / 2;
    const offsetU = (HEIGHT - (maxU - minU) * scale) / 2;
    const toScreen = (p: number[]): [number, number, number] => [
      offsetR + (view.right(p) - minR) * scale,
      HEIGHT - offsetU - (view.up(p) - minU) * scale, // screen y grows downwards
      view.depth(p),
    ];

    const zBuffer = new Float32Array(width * HEIGHT).fill(Infinity);
    for (let i = 0; i < indices.length; i += 3) {
      const world = [vertex(indices[i]), vertex(indices[i + 1]), vertex(indices[i + 2])];
      const a = toScreen(world[0]), b = toScreen(world[1]), c = toScreen(world[2]);

      // Flat shading from the true normal, lit from above and to the left.
      const u = [world[1][0] - world[0][0], world[1][1] - world[0][1], world[1][2] - world[0][2]];
      const v = [world[2][0] - world[0][0], world[2][1] - world[0][1], world[2][2] - world[0][2]];
      const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(...normal) || 1;
      const light = [-0.35, -0.5, 0.79];
      const lambert = (normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2]) / length;
      const shade = Math.max(38, Math.min(255, Math.round(150 + lambert * 105)));

      const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(area) < 1e-9) continue;
      const left = Math.max(panel * PANEL, Math.floor(Math.min(a[0], b[0], c[0])));
      const right = Math.min((panel + 1) * PANEL - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const top = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const bottom = Math.min(HEIGHT - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1])) / area;
          const w1 = ((px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1])) / area;
          if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
          const depth = a[2] * (1 - w0 - w1) + b[2] * w1 + c[2] * w0;
          const at = y * width + x;
          if (depth >= zBuffer[at]) continue;
          zBuffer[at] = depth;
          pixels[at] = shade;
        }
      }
    }
  });

  return { pixels, width, height: HEIGHT };
}

function png(pixels: Uint8Array, width: number, height: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bit depth
  header[9] = 0;  // greyscale
  // Each scanline is prefixed with its filter type; 0 means none.
  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    Buffer.from(pixels.subarray(y * width, (y + 1) * width)).copy(raw, y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const input = process.argv[2] ?? join(homedir(), 'Downloads', 'elephant.mycad');
const output = process.argv[3] ?? input.replace(/\.mycad$/, '.png');
const project = JSON.parse(readFileSync(input, 'utf8')) as {
  solids: Array<{ mesh: { positions: number[]; indices: number[] } }>;
};
if (project.solids.length === 0) throw new Error('No solids to look at.');

// Every solid at once, so the views show the whole model.
const positions: number[] = [];
const indices: number[] = [];
for (const solid of project.solids) {
  const base = positions.length / 3;
  positions.push(...solid.mesh.positions);
  indices.push(...solid.mesh.indices.map((index) => index + base));
}

const { pixels, width, height } = render(positions, indices);
writeFileSync(output, png(pixels, width, height));
console.log(`${VIEWS.map((view) => view.label).join(', ')} → ${output}`);
