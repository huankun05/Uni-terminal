/**
 * 生成 PWA 图标（192 / 512 / maskable 512），零依赖手写 PNG 编码。
 *
 * 设计：深色圆角底 + 终端光标块（accent 蓝），呼应产品是"终端控制台"。
 * maskable 版本图形缩进安全区（每边 10%），避免 Android 裁切。
 * 只在构建环境手动跑：node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'web', 'public');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA 像素 → PNG。 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 在 [x,y] 画实心矩形。 */
function rect(rgba, size, x, y, w, h, [r, g, b, a = 255]) {
  for (let yy = Math.max(0, y); yy < Math.min(size, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(size, x + w); xx++) {
      const i = (yy * size + xx) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
}

/** 圆角矩形模板。 */
function roundedMask(size, radius) {
  const inside = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      inside[y * size + x] = dx * dx + dy * dy <= radius * radius ? 1 : 0;
    }
  }
  return inside;
}

function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const bg = [18, 24, 38, 255];        // --bg-surface
  const accent = [79, 140, 255, 255];  // --accent
  const inside = roundedMask(size, Math.round(size * 0.22));

  // 深色圆角底
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inside[y * size + x]) continue;
      const i = (y * size + x) * 4;
      rgba[i] = bg[0]; rgba[i + 1] = bg[1]; rgba[i + 2] = bg[2]; rgba[i + 3] = 255;
    }
  }

  // 图形：终端提示符 ">" + 光标块。maskable 缩进 10% 安全区。
  const pad = maskable ? size * 0.1 : size * 0.26;
  const u = (size - pad * 2) / 8; // 一个单位
  const top = pad + u * 1.5;

  // ">" 折线（两段粗线）
  const t = Math.max(2, Math.round(u * 0.8));
  rect(rgba, size, Math.round(pad + u * 1.0), Math.round(top), t, Math.round(u * 2.6), accent);
  rect(rgba, size, Math.round(pad + u * 1.0), Math.round(top + u * 1.3), Math.round(u * 2.2), t, accent);
  rect(rgba, size, Math.round(pad + u * 1.0), Math.round(top + u * 2.6 - t), Math.round(u * 2.2), t, accent);
  // 光标块
  rect(rgba, size, Math.round(pad + u * 4.2), Math.round(top + u * 1.8), Math.round(u * 2.4), Math.round(u * 2.4), accent);

  return encodePng(size, size, rgba);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'icon-192.png'), drawIcon(192));
writeFileSync(join(outDir, 'icon-512.png'), drawIcon(512));
writeFileSync(join(outDir, 'icon-maskable-512.png'), drawIcon(512, { maskable: true }));
console.log('icons written to', outDir);
