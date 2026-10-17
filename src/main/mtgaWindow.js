const { EventEmitter } = require('events');

// Polls the Win32 API for MTGA's window so overlays can follow it. Coordinates are
// physical pixels; Electron's main process is per-monitor DPI aware so they line up.
let win32 = null;
try {
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    koffi.struct('POINT', { x: 'long', y: 'long' });
    win32 = {
      koffi,
      FindWindowW: user32.func('void * __stdcall FindWindowW(const char16_t *cls, const char16_t *name)'),
      GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
      GetClientRect: user32.func('bool __stdcall GetClientRect(void *hwnd, _Out_ RECT *rect)'),
      ClientToScreen: user32.func('bool __stdcall ClientToScreen(void *hwnd, _Inout_ POINT *pt)'),
      IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
      GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
      SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hwnd)'),
    };
  }
} catch (err) {
  console.warn('[mtga-journal] window tracking unavailable:', err.message);
}

class MtgaWindowTracker extends EventEmitter {
  constructor({ intervalMs = 250 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.state = { supported: Boolean(win32), found: false };
    this.key = '';
  }

  start() {
    if (!win32) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    const next = this.read();
    const key = JSON.stringify(next);
    if (key === this.key) return;
    this.key = key;
    this.state = next;
    this.emit('change', next);
  }

  // Hands keyboard focus back to the game (e.g. after jotting a mid-game note).
  focusMtga() {
    if (!win32 || !this.hwnd) return false;
    return win32.SetForegroundWindow(this.hwnd);
  }

  read() {
    const { koffi } = win32;
    const hwnd = win32.FindWindowW('UnityWndClass', 'MTGA') || win32.FindWindowW(null, 'MTGA');
    this.hwnd = hwnd || null;
    const fg = win32.GetForegroundWindow();
    const pid = [0];
    if (fg) win32.GetWindowThreadProcessId(fg, pid);
    const ourAppForeground = pid[0] === process.pid;
    if (!hwnd) return { supported: true, found: false, ourAppForeground };

    const rect = {};
    const origin = { x: 0, y: 0 };
    win32.GetClientRect(hwnd, rect);
    win32.ClientToScreen(hwnd, origin);
    return {
      supported: true,
      found: true,
      minimized: win32.IsIconic(hwnd) || !win32.IsWindowVisible(hwnd),
      foreground: Boolean(fg) && koffi.address(fg) === koffi.address(hwnd),
      ourAppForeground,
      bounds: { x: origin.x, y: origin.y, width: rect.right - rect.left, height: rect.bottom - rect.top },
    };
  }
}

module.exports = { MtgaWindowTracker };
