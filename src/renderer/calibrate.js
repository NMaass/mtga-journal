// The overlay covers MTGA's client area exactly, so window-relative fractions map 1:1.
const box = document.getElementById('box');
const veil = document.getElementById('veil');
let rect = { x: 0.8, y: 0.86, w: 0.195, h: 0.13 };
let defaults = rect;

const W = () => window.innerWidth;
const H = () => window.innerHeight;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function draw() {
  box.style.left = `${rect.x * W()}px`;
  box.style.top = `${rect.y * H()}px`;
  box.style.width = `${rect.w * W()}px`;
  box.style.height = `${rect.h * H()}px`;
}

function drag(e, onMove) {
  e.preventDefault();
  const start = { x: e.clientX, y: e.clientY, rect: { ...rect } };
  const move = (ev) => {
    onMove((ev.clientX - start.x) / W(), (ev.clientY - start.y) / H(), start, ev);
    draw();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

veil.addEventListener('pointerdown', (e) =>
  drag(e, (_dx, _dy, start, ev) => {
    const x0 = start.x / W();
    const y0 = start.y / H();
    const x1 = clamp(ev.clientX / W(), 0, 1);
    const y1 = clamp(ev.clientY / H(), 0, 1);
    rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }),
);

box.addEventListener('pointerdown', (e) => {
  if (e.target.id === 'handle') return;
  drag(e, (dx, dy, start) => {
    rect.x = clamp(start.rect.x + dx, 0, 1 - rect.w);
    rect.y = clamp(start.rect.y + dy, 0, 1 - rect.h);
  });
});

document.getElementById('handle').addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  drag(e, (dx, dy, start) => {
    rect.w = clamp(start.rect.w + dx, 0.01, 1 - rect.x);
    rect.h = clamp(start.rect.h + dy, 0.01, 1 - rect.y);
  });
});

const save = () => mj.finishCalibration(rect);
document.getElementById('save').addEventListener('click', save);
document.getElementById('cancel').addEventListener('click', () => mj.cancelCalibration());
document.getElementById('reset').addEventListener('click', () => {
  rect = { ...defaults };
  draw();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') mj.cancelCalibration();
  if (e.key === 'Enter') save();
});
window.addEventListener('resize', draw);

mj.getCalibration().then((c) => {
  rect = { ...c.lockArea };
  defaults = c.defaults;
  if (!c.mtgaFound) {
    const help = document.getElementById('help');
    help.classList.add('warn');
    help.textContent = 'MTGA isn’t running, so this box is relative to your screen. Open MTGA to its Home or event page first for the best fit.';
  }
  draw();
});
