// Generates the PWA icons in public/icons/ without any image tooling: shapes are drawn as
// signed-distance functions with 4×4 supersampling and written as PNG via zlib.
// Run: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const BG_TOP = [18, 72, 130];
const BG_BOTTOM = [8, 34, 66];
const RING = [120, 180, 255];
const DROP = [255, 255, 255];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Shapes in unit coordinates (0..1), centred on 0.5.
function sample(u, v, { rounded, scale }) {
  // Scale artwork about the centre (maskable icons need a safe zone).
  const x = (u - 0.5) / scale;
  const y = (v - 0.5) / scale;

  if (rounded) {
    const r = 0.22, h = 0.5 - r;
    const qx = Math.max(Math.abs(u - 0.5) - h, 0), qy = Math.max(Math.abs(v - 0.5) - h, 0);
    if (Math.hypot(qx, qy) > r) return null;
  }
  let c = mix(BG_TOP, BG_BOTTOM, v);

  // Radar rings centred low-left.
  const d = Math.hypot(x + 0.14, y - 0.16);
  for (const rr of [0.18, 0.3, 0.42]) if (Math.abs(d - rr) < 0.018 && x + 0.14 > -0.02 && y - 0.16 < 0.02) c = mix(c, RING, 0.55);

  // Raindrop: circle bottom + tapered top, upper-right.
  const dx = x - 0.1, dy = y + 0.02;
  const R = 0.17;
  const inCircle = Math.hypot(dx, dy) < R;
  const ty = -dy; // up positive
  const inTip = ty > 0 && ty < R * 2.1 && Math.abs(dx) < R * (1 - ty / (R * 2.1)) * 0.95;
  if (inCircle || inTip) c = DROP;
  return c;
}

function render(size, opts) {
  const px = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++) {
        const c = sample((x + (sx + 0.5) / N) / size, (y + (sy + 0.5) / N) / size, opts);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
      }
      const i = (y * size + x) * 4;
      px[i] = a ? r / a : 0; px[i + 1] = a ? g / a : 0; px[i + 2] = a ? b / a : 0; px[i + 3] = (a / (N * N)) * 255;
    }
  }
  return png(size, size, px);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const files = {
  'icon-192.png': render(192, { rounded: true, scale: 1 }),
  'icon-512.png': render(512, { rounded: true, scale: 1 }),
  'maskable-512.png': render(512, { rounded: false, scale: 0.78 }),
  'apple-touch-icon.png': render(180, { rounded: false, scale: 0.9 }),
};
for (const [name, buf] of Object.entries(files)) writeFileSync(new URL(name, OUT), buf);

writeFileSync(
  new URL('favicon.svg', OUT),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(${BG_TOP})"/><stop offset="1" stop-color="rgb(${BG_BOTTOM})"/></linearGradient></defs>
  <rect width="100" height="100" rx="22" fill="url(#g)"/>
  <g fill="none" stroke="rgb(${RING})" stroke-opacity="0.6" stroke-width="3.6"><path d="M36 48 A18 18 0 0 1 54 66"/><path d="M36 36 A30 30 0 0 1 66 66"/><path d="M36 24 A42 42 0 0 1 78 66"/></g>
  <path d="M60 16 C60 16 77 39 77 48 A17 17 0 0 1 43 48 C43 39 60 16 60 16Z" fill="#fff"/>
</svg>
`,
);
console.log('icons written to', OUT.pathname);
