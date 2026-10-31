// Picks MTGA's game window out of macOS's window list and works out its client area.
// Kept free of native calls so it can be tested anywhere.

// Height of a standard macOS title bar in points. CoreGraphics reports a window's frame
// including the title bar, so a windowed MTGA's content starts this far below the frame.
const TITLE_BAR = 28;

const sameRect = (a, b) =>
  Math.round(a.x) === Math.round(b.x) &&
  Math.round(a.y) === Math.round(b.y) &&
  Math.round(a.width) === Math.round(b.width) &&
  Math.round(a.height) === Math.round(b.height);

// windows: [{ owner, pid, layer, onscreen, bounds }] as read from CGWindowListCopyWindowInfo.
// displays: [{ x, y, width, height }] screen bounds, to spot full-screen windows (no title bar).
function pickMacWindow(windows, displays = []) {
  const candidates = windows.filter(
    (w) => /^MTGA\b/i.test(w.owner || '') && w.layer === 0 && w.bounds.width > 100 && w.bounds.height > 100,
  );
  if (!candidates.length) return null;
  // Unity can own small helper windows; the game is the biggest one.
  const win = candidates.reduce((a, b) => (b.bounds.width * b.bounds.height > a.bounds.width * a.bounds.height ? b : a));
  const b = win.bounds;
  const fullScreen = displays.some((d) => sameRect(d, b));
  const top = fullScreen ? 0 : TITLE_BAR;
  return { ...win, clientBounds: { x: b.x, y: b.y + top, width: b.width, height: b.height - top } };
}

module.exports = { pickMacWindow, TITLE_BAR };
