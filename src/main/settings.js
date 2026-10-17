const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_LOG = path.join(os.homedir(), 'AppData', 'LocalLow', 'Wizards Of The Coast', 'MTGA', 'Player.log');

// Areas are fractions of MTGA's client area so they survive window resizes.
const DEFAULT_LOCK_AREA = { x: 0.8, y: 0.86, w: 0.195, h: 0.13 };
// Where the opponent's pet sits, next to their avatar at the top of the battlefield.
const DEFAULT_NOTEPAD_AREA = { x: 0.77, y: 0.02, w: 0.21, h: 0.25 };

const DEFAULTS = {
  logPath: DEFAULT_LOG,
  requireNotesFor: 'all', // 'all' | 'limited'
  minNoteChars: 1,
  autoOpenNotes: true,
  requireReview: true,
  requirePrep: true,
  showNotepad: true,
  notepadCollapsed: false,
  openJournalOnStart: true,
  lockArea: DEFAULT_LOCK_AREA,
  notepadArea: DEFAULT_NOTEPAD_AREA,
  tags: ['Mana screw', 'Flood', 'Color screw', 'Misplay', 'Opp bomb', 'Curved out', 'Outvalued', 'Close game', 'Mulligan'],
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.values = { ...DEFAULTS };
    try {
      Object.assign(this.values, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // first run or unreadable: defaults
    }
  }

  get(key) {
    return this.values[key];
  }

  all() {
    return { ...this.values, defaults: DEFAULTS };
  }

  update(patch) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (!(key in DEFAULTS)) continue;
      this.values[key] = value === null ? DEFAULTS[key] : value;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const { defaults, ...persist } = this.all();
    fs.writeFileSync(this.file, JSON.stringify(persist, null, 2));
    return this.all();
  }
}

module.exports = { Settings, DEFAULTS, DEFAULT_LOG };
