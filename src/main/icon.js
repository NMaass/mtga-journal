// Draws the app icon (gold disc with a keyhole) so no binary assets are needed at runtime.
// scripts/make-icons.js draws the same design into build/ for the installer and exe icon.
const GOLD = [212, 168, 75];
const DARK = [20, 22, 28];
const RED = [224, 86, 91];

const clamp = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Calls put(x, y, [r, g, b], alpha) for every pixel; alpha is 0..1 and the color is not
// premultiplied.
function paintIcon(size, { badge = false } = {}, put) {
  const c = (size - 1) / 2;
  const outer = size * 0.48;
  const inner = size * 0.36;
  const holeR = size * 0.11;
  const holeY = c - size * 0.07;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - c, y - c);
      let alpha = clamp(outer - d + 0.5);
      let color = mix(GOLD, DARK, clamp(inner - d + 0.5));

      // keyhole: circle plus a tapering stem
      const hole = clamp(holeR - Math.hypot(x - c, y - holeY) + 0.5);
      const t = (y - holeY) / (size * 0.27);
      const halfWidth = size * (0.045 + 0.05 * t);
      const stem = t >= 0 && t <= 1 ? clamp(halfWidth - Math.abs(x - c) + 0.5) : 0;
      color = mix(color, GOLD, Math.max(hole, stem));

      if (badge) {
        const bx = size * 0.8;
        const by = size * 0.2;
        const br = size * 0.2;
        const ring = clamp(br + size * 0.06 - Math.hypot(x - bx, y - by) + 0.5);
        const dot = clamp(br - Math.hypot(x - bx, y - by) + 0.5);
        color = mix(mix(color, DARK, ring), RED, dot);
        alpha = Math.max(alpha, ring);
      }

      put(x, y, color, alpha);
    }
  }
}

// scaleFactor 2 makes a size-px bitmap draw at size/2 points (macOS Retina menu bar).
function makeIcon(size = 32, opts = {}, scaleFactor = 1) {
  // Required here so scripts/make-icons.js can load this file under plain Node.
  const { nativeImage } = require('electron');
  const buf = Buffer.alloc(size * size * 4);
  paintIcon(size, opts, (x, y, color, alpha) => {
    const i = (y * size + x) * 4;
    buf[i] = Math.round(color[2] * alpha);
    buf[i + 1] = Math.round(color[1] * alpha);
    buf[i + 2] = Math.round(color[0] * alpha);
    buf[i + 3] = Math.round(alpha * 255);
  });
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor });
}

module.exports = { paintIcon, makeIcon };
