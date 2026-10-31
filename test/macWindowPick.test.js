const test = require('node:test');
const assert = require('node:assert');
const { pickMacWindow, TITLE_BAR } = require('../src/main/macWindowPick');

const win = (over) => ({ owner: 'MTGA', pid: 42, layer: 0, onscreen: true, bounds: { x: 100, y: 50, width: 1280, height: 748 }, ...over });

test('ignores other apps, menu-bar layers and tiny helper windows', () => {
  assert.strictEqual(pickMacWindow([win({ owner: 'Finder' }), win({ layer: 25 }), win({ bounds: { x: 0, y: 0, width: 50, height: 50 } })]), null);
});

test('windowed MTGA: client area starts below the title bar', () => {
  const picked = pickMacWindow([win()], [{ x: 0, y: 0, width: 1728, height: 1117 }]);
  assert.strictEqual(picked.pid, 42);
  assert.deepStrictEqual(picked.clientBounds, { x: 100, y: 50 + TITLE_BAR, width: 1280, height: 748 - TITLE_BAR });
});

test('full-screen MTGA: no title bar to skip', () => {
  const display = { x: 0, y: 0, width: 1728, height: 1117 };
  const picked = pickMacWindow([win({ bounds: { ...display } })], [display]);
  assert.deepStrictEqual(picked.clientBounds, display);
});

test('picks the largest MTGA window', () => {
  const big = win({ pid: 7, bounds: { x: 0, y: 0, width: 1600, height: 900 } });
  assert.strictEqual(pickMacWindow([win({ bounds: { x: 0, y: 0, width: 300, height: 200 } }), big]).pid, 7);
});
