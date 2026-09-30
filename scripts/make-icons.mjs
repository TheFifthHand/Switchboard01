// Generates the PWA icons (original artwork) as PNGs with no dependencies.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

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
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 4;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
        r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = SS * SS;
      raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0; raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function roundRect(u, v, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(u, x0 + r), x1 - r), cy = Math.min(Math.max(v, y0 + r), y1 - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r && u >= x0 && u <= x1 && v >= y0 && v <= y1;
}
const shell = [235, 231, 223], pad = [246, 247, 247], edge = [196, 200, 204], amber = [240, 166, 52], ink = [38, 41, 45];
function pixel(u, v) {
  // full-bleed background so the maskable variant works too
  let c = shell;
  const cells = [[0.22, 0.22], [0.53, 0.22], [0.22, 0.53], [0.53, 0.53]];
  cells.forEach(([x, y], i) => {
    const w = 0.25;
    if (roundRect(u, v, x - 0.006, y - 0.006, x + w + 0.006, y + w + 0.006, 0.05)) c = edge;
    if (roundRect(u, v, x, y, x + w, y + w, 0.045)) {
      c = pad;
      if (i === 1) {
        const d = Math.hypot(u - (x + w / 2), v - (y + w / 2)) / (w / 2);
        const t = Math.max(0, 1 - d);
        c = pad.map((p, k) => Math.round(p + (amber[k] - p) * Math.min(1, t * 1.4)));
      }
    }
  });
  if (roundRect(u, v, 0.22, 0.815, 0.78, 0.835, 0.01)) c = ink;
  return [...c, 1];
}
mkdirSync('public/icons', { recursive: true });
for (const s of [192, 512]) writeFileSync(`public/icons/icon-${s}.png`, png(s, pixel));
writeFileSync('public/icons/favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#ebe7df"/><rect x="14" y="14" width="16" height="16" rx="3" fill="#f6f7f7" stroke="#c4c8cc"/><rect x="34" y="14" width="16" height="16" rx="3" fill="#f0a634"/><rect x="14" y="34" width="16" height="16" rx="3" fill="#f6f7f7" stroke="#c4c8cc"/><rect x="34" y="34" width="16" height="16" rx="3" fill="#f6f7f7" stroke="#c4c8cc"/><rect x="14" y="53" width="36" height="2" rx="1" fill="#26292d"/></svg>`);
console.log('icons written');
