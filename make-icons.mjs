// Draws the Hark app icon (book spines that double as sound bars) and writes PNGs.
// No dependencies: node make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('./www/icons/', import.meta.url));
mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}
function png(size, px) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = px(x / size, y / size);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const PAPER = [251, 241, 222], INK = [28, 26, 23], ORANGE = [239, 111, 46], YELLOW = [245, 214, 90];
// Spines: [left, right, top] in 0..1; all stand on a shelf line. Kept inside the maskable safe zone.
const spines = [
  [0.24, 0.345, 0.42, PAPER],
  [0.365, 0.47, 0.27, ORANGE],
  [0.49, 0.595, 0.36, YELLOW],
  [0.615, 0.72, 0.22, PAPER],
];
const BASE = 0.74, B = 0.022;
function px(x, y) {
  if (y >= BASE && y <= BASE + B * 1.4 && x >= 0.2 && x <= 0.8) return INK;
  for (const [l, r, t, fill] of spines) {
    if (x >= l && x <= r && y >= t && y <= BASE) {
      const edge = x - l < B || r - x < B || y - t < B;
      const band = y > t + 0.07 && y < t + 0.07 + B; // a title band on each spine
      return edge || band ? INK : fill;
    }
  }
  return [247, 228, 196]; // warm paper, a touch deeper than the app background so the icon reads on white
}

for (const size of [180, 192, 512]) {
  // 3x3 supersampling keeps the edges clean.
  const ss = (u, v) => {
    const acc = [0, 0, 0], d = 1 / (size * 3);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { const c = px(u + (i - 1) * d, v + (j - 1) * d); acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; }
    return acc.map(n => Math.round(n / 9));
  };
  writeFileSync(`${out}icon-${size}.png`, png(size, ss));
  console.log('wrote', `icon-${size}.png`);
}
