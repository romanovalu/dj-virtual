// Genera los íconos de la app (PNG) sin dependencias: un vinilo con la etiqueta en los colores de
// la app. Uso: node scripts/make-icons.mjs  → public/icons/*.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const SS = 3; // supermuestreo para bordes suaves
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0;
      raw[o + 1] = a ? g / a : 0;
      raw[o + 2] = a ? b / a : 0;
      raw[o + 3] = (a / (SS * SS)) * 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [14, 16, 20];
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** scale: radio del vinilo respecto del ícono (más chico en los "maskable" por la zona segura). */
function vinyl(scale, roundBg) {
  return (u, v) => {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const r = Math.hypot(dx, dy);
    // Fondo: cuadrado redondeado (o lleno para maskable)
    if (roundBg) {
      const k = 0.18, e = 0.5 - k;
      const qx = Math.max(Math.abs(dx) - e, 0), qy = Math.max(Math.abs(dy) - e, 0);
      if (Math.hypot(qx, qy) > k) return [0, 0, 0, 0];
    }
    const R = 0.42 * scale;
    if (r > R) return [...BG, 1];
    if (r < 0.022 * scale) return [...BG, 1]; // agujero
    if (r < 0.16 * scale) {
      // Etiqueta: degradé violeta → celeste
      const t = Math.max(0, Math.min(1, (u - v + 0.3) / 0.6 + 0.2));
      return [...lerp([184, 140, 255], [63, 182, 255], t), 1];
    }
    // Surcos y brillo
    const groove = 0.5 + 0.5 * Math.sin((r / R) * 140);
    const ang = Math.atan2(dy, dx);
    const shine = Math.max(0, Math.cos(2 * (ang + 0.8))) ** 6 * 0.35;
    const base = 26 + groove * 8 + shine * 120;
    const rim = r > R - 0.012 * scale ? 18 : 0;
    return [base + rim, base + rim, base + 10 + rim, 1];
  };
}

mkdirSync('public/icons', { recursive: true });
writeFileSync('public/icons/icon-192.png', png(192, vinyl(1, true)));
writeFileSync('public/icons/icon-512.png', png(512, vinyl(1, true)));
writeFileSync('public/icons/maskable-512.png', png(512, vinyl(0.78, false)));
writeFileSync('public/icons/apple-touch-icon.png', png(180, vinyl(0.9, false)));
writeFileSync('public/icons/favicon-32.png', png(32, vinyl(1.15, true)));
console.log('íconos generados en public/icons');
