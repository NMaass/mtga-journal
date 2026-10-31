const { EventEmitter } = require('events');
const { pickMacWindow } = require('./macWindowPick');

// Finds MTGA's window so overlays can follow it, and hands focus back to it.
// Each backend reads { found, minimized, foreground, ourAppForeground, bounds } where bounds
// is MTGA's client area in screen coordinates:
//   Windows: physical pixels (Electron's main process is per-monitor DPI aware; main.js
//            converts them to DIPs).
//   macOS:   points, origin at the top-left of the main display, which is what Electron
//            uses too.

function loadWindowsBackend() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
  koffi.struct('POINT', { x: 'long', y: 'long' });
  const api = {
    FindWindowW: user32.func('void * __stdcall FindWindowW(const char16_t *cls, const char16_t *name)'),
    GetForegroundWindow: user32.func('void * __stdcall GetForegroundWindow()'),
    GetClientRect: user32.func('bool __stdcall GetClientRect(void *hwnd, _Out_ RECT *rect)'),
    ClientToScreen: user32.func('bool __stdcall ClientToScreen(void *hwnd, _Inout_ POINT *pt)'),
    IsIconic: user32.func('bool __stdcall IsIconic(void *hwnd)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(void *hwnd)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(void *hwnd)'),
  };
  let hwnd = null;

  return {
    read() {
      hwnd = api.FindWindowW('UnityWndClass', 'MTGA') || api.FindWindowW(null, 'MTGA') || null;
      const fg = api.GetForegroundWindow();
      const pid = [0];
      if (fg) api.GetWindowThreadProcessId(fg, pid);
      const ourAppForeground = pid[0] === process.pid;
      if (!hwnd) return { found: false, ourAppForeground };

      const rect = {};
      const origin = { x: 0, y: 0 };
      api.GetClientRect(hwnd, rect);
      api.ClientToScreen(hwnd, origin);
      return {
        found: true,
        minimized: api.IsIconic(hwnd) || !api.IsWindowVisible(hwnd),
        foreground: Boolean(fg) && koffi.address(fg) === koffi.address(hwnd),
        ourAppForeground,
        bounds: { x: origin.x, y: origin.y, width: rect.right - rect.left, height: rect.bottom - rect.top },
      };
    },
    focus() {
      return Boolean(hwnd) && api.SetForegroundWindow(hwnd);
    },
  };
}

// macOS: CoreGraphics' window list gives every window's owner, layer and frame. Owner names
// and frames need no Screen Recording permission (only window titles would). The frontmost
// app and activation go through AppKit via the Objective-C runtime.
function loadMacBackend() {
  const koffi = require('koffi');
  const fw = (name) => koffi.load(`/System/Library/Frameworks/${name}.framework/${name}`);
  const CF = fw('CoreFoundation');
  const CG = fw('CoreGraphics');
  fw('AppKit'); // makes NSWorkspace and NSRunningApplication available to objc_getClass
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');

  koffi.struct('MJ_CGRect', { x: 'double', y: 'double', width: 'double', height: 'double' });
  const cf = {
    CGWindowListCopyWindowInfo: CG.func('void *CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)'),
    CGRectMakeWithDictionaryRepresentation: CG.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ MJ_CGRect *rect)'),
    CFArrayGetCount: CF.func('long CFArrayGetCount(void *array)'),
    CFArrayGetValueAtIndex: CF.func('void *CFArrayGetValueAtIndex(void *array, long index)'),
    CFDictionaryGetValue: CF.func('void *CFDictionaryGetValue(void *dict, void *key)'),
    CFStringCreateWithCString: CF.func('void *CFStringCreateWithCString(void *alloc, const char *str, uint32_t encoding)'),
    CFStringGetCString: CF.func('bool CFStringGetCString(void *str, _Out_ uint8_t *buf, long size, uint32_t encoding)'),
    CFNumberGetValue: CF.func('bool CFNumberGetValue(void *number, int type, _Out_ int32_t *value)'),
    CFBooleanGetValue: CF.func('bool CFBooleanGetValue(void *boolean)'),
    CFRelease: CF.func('void CFRelease(void *ref)'),
  };
  const UTF8 = 0x08000100;
  const SINT32 = 3;
  const ON_SCREEN_ONLY = 1 | 16; // kCGWindowListOptionOnScreenOnly | ExcludeDesktopElements
  const ALL = 0;
  const key = (name) => cf.CFStringCreateWithCString(null, name, UTF8);
  const K = {
    owner: key('kCGWindowOwnerName'),
    pid: key('kCGWindowOwnerPID'),
    layer: key('kCGWindowLayer'),
    bounds: key('kCGWindowBounds'),
    onscreen: key('kCGWindowIsOnscreen'),
  };

  const rt = {
    getClass: objc.func('void *objc_getClass(const char *name)'),
    sel: objc.func('void *sel_registerName(const char *name)'),
    poolPush: objc.func('void *objc_autoreleasePoolPush()'),
    poolPop: objc.func('void objc_autoreleasePoolPop(void *pool)'),
    sendPtr: objc.func('objc_msgSend', 'void *', ['void *', 'void *']),
    sendInt: objc.func('objc_msgSend', 'int', ['void *', 'void *']),
    sendPtrInt: objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'int']),
    sendBoolPtr: objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'void *']),
    sendVoidPtr: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'void *']),
    sendBoolUlong: objc.func('objc_msgSend', 'bool', ['void *', 'void *', 'unsigned long']),
  };
  const S = {};
  const sel = (name) => (S[name] ||= rt.sel(name));
  const withPool = (fn) => {
    const pool = rt.poolPush();
    try {
      return fn();
    } finally {
      rt.poolPop(pool);
    }
  };

  const str = (ref) => {
    if (!ref) return null;
    const buf = Buffer.alloc(256);
    return cf.CFStringGetCString(ref, buf, buf.length, UTF8) ? buf.toString('utf8', 0, buf.indexOf(0)) : null;
  };
  const int = (ref) => {
    if (!ref) return null;
    const out = [0];
    return cf.CFNumberGetValue(ref, SINT32, out) ? out[0] : null;
  };

  function windowList(option) {
    const list = cf.CGWindowListCopyWindowInfo(option, 0);
    if (!list) return [];
    try {
      const out = [];
      const n = cf.CFArrayGetCount(list);
      for (let i = 0; i < n; i += 1) {
        const d = cf.CFArrayGetValueAtIndex(list, i);
        const owner = str(cf.CFDictionaryGetValue(d, K.owner));
        if (!owner || !/^MTGA\b/i.test(owner)) continue; // only MTGA's windows need details
        const rect = {};
        const boundsDict = cf.CFDictionaryGetValue(d, K.bounds);
        if (!boundsDict || !cf.CGRectMakeWithDictionaryRepresentation(boundsDict, rect)) continue;
        const onscreen = cf.CFDictionaryGetValue(d, K.onscreen);
        out.push({
          owner,
          pid: int(cf.CFDictionaryGetValue(d, K.pid)),
          layer: int(cf.CFDictionaryGetValue(d, K.layer)) ?? 0,
          onscreen: onscreen ? cf.CFBooleanGetValue(onscreen) : false,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      }
      return out;
    } finally {
      cf.CFRelease(list);
    }
  }

  function frontmostPid() {
    return withPool(() => {
      const ws = rt.sendPtr(rt.getClass('NSWorkspace'), sel('sharedWorkspace'));
      const front = ws && rt.sendPtr(ws, sel('frontmostApplication'));
      return front ? rt.sendInt(front, sel('processIdentifier')) : null;
    });
  }

  function displays() {
    try {
      return require('electron').screen.getAllDisplays().map((d) => d.bounds);
    } catch {
      return [];
    }
  }

  let mtgaPid = null;

  return {
    read() {
      const front = frontmostPid();
      const ourAppForeground = front === process.pid;
      // On-screen windows first; a minimized or hidden MTGA only shows up in the full list.
      let win = pickMacWindow(windowList(ON_SCREEN_ONLY), displays());
      let minimized = false;
      if (!win) {
        win = pickMacWindow(windowList(ALL), displays());
        minimized = Boolean(win);
      }
      mtgaPid = win ? win.pid : null;
      if (!win) return { found: false, ourAppForeground };
      return {
        found: true,
        minimized: minimized || !win.onscreen,
        foreground: front != null && front === win.pid,
        ourAppForeground,
        bounds: win.clientBounds,
      };
    },
    focus() {
      if (!mtgaPid) return false;
      return withPool(() => {
        const target = rt.sendPtrInt(rt.getClass('NSRunningApplication'), sel('runningApplicationWithProcessIdentifier:'), mtgaPid);
        if (!target) return false;
        // macOS 14+ only lets an app take activation that the active app yields to it.
        const nsApp = rt.sendPtr(rt.getClass('NSApplication'), sel('sharedApplication'));
        if (nsApp && rt.sendBoolPtr(nsApp, sel('respondsToSelector:'), sel('yieldActivationToApplication:'))) {
          rt.sendVoidPtr(nsApp, sel('yieldActivationToApplication:'), target);
        }
        return rt.sendBoolUlong(target, sel('activateWithOptions:'), 2); // NSApplicationActivateIgnoringOtherApps
      });
    },
  };
}

let backend = null;
try {
  if (process.platform === 'win32') backend = loadWindowsBackend();
  else if (process.platform === 'darwin') backend = loadMacBackend();
} catch (err) {
  console.warn('[mtga-journal] window tracking unavailable:', err.message);
}

class MtgaWindowTracker extends EventEmitter {
  constructor({ intervalMs = 250 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.state = { supported: Boolean(backend), found: false };
    this.key = '';
  }

  start() {
    if (!backend) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  tick() {
    let next;
    try {
      next = { supported: true, ...backend.read() };
    } catch (err) {
      if (!this.warned) console.warn('[mtga-journal] window tracking failed:', err.message);
      this.warned = true;
      next = { supported: true, found: false };
    }
    const key = JSON.stringify(next);
    if (key === this.key) return;
    this.key = key;
    this.state = next;
    this.emit('change', next);
  }

  // Hands keyboard focus back to the game (e.g. after jotting a mid-game note).
  focusMtga() {
    if (!backend) return false;
    try {
      return backend.focus();
    } catch {
      return false;
    }
  }
}

module.exports = { MtgaWindowTracker };
