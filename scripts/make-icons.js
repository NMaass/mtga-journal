#!/usr/bin/env node
// Writes build/icon.png and build/icon.ico for electron-builder, drawn by the same code as
// the runtime tray and window icon (src/main/icon.js).
//   node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { paintIcon } = require('../src/main/icon');

const OUT = path.join(__dirname, '..', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// Windows stores the large icon as PNG and the small ones as bitmaps.
const ICO_PNG_MIN = 256;

// Straight (not premultiplied) RGBA, top row first.
function rgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  paintIcon(size, {}, (x, y, color, alpha) => {
    const i = (y * size + x) * 4;
    buf[i] = Math.round(color[0]);
    buf[i + 1] = Math.round(color[1]);
    buf[i + 2] = Math.round(color[2]);
    buf[i + 3] = Math.round(alpha * 255);
  });
  return buf;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size) {
  const pixels = rgba(size);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 32-bit DIB as stored in .ico files: BGRA rows bottom-up, then a 1-bit transparency mask.
function bmp(size) {
  const pixels = rgba(size);
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // color rows + mask rows
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const color = Buffer.alloc(size * size * 4);
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y += 1) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x += 1) {
      const s = (y * size + x) * 4;
      const d = (row * size + x) * 4;
      color[d] = pixels[s + 2];
      color[d + 1] = pixels[s + 1];
      color[d + 2] = pixels[s];
      color[d + 3] = pixels[s + 3];
      if (pixels[s + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, color, mask]);
}

function ico(sizes) {
  const images = sizes.map((size) => (size >= ICO_PNG_MIN ? png(size) : bmp(size)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const entries = Buffer.alloc(16 * sizes.length);
  let offset = header.length + entries.length;
  sizes.forEach((size, i) => {
    const e = i * 16;
    entries[e] = size >= 256 ? 0 : size;
    entries[e + 1] = size >= 256 ? 0 : size;
    entries.writeUInt16LE(1, e + 4); // planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(images[i].length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, entries, ...images]);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.png'), png(512));
fs.writeFileSync(path.join(OUT, 'icon.ico'), ico(ICO_SIZES));
console.log(`wrote ${path.relative(process.cwd(), OUT)}${path.sep}icon.png and icon.ico`);
