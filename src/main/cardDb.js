const fs = require('fs');
const os = require('os');
const path = require('path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  // Card names are a nice-to-have; everything else works without them.
}

const COLOR_IDS = { 1: 'W', 2: 'U', 3: 'B', 4: 'R', 5: 'G' };
const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
const LAND_TYPE = '5';
const CREATURE_TYPE = '2';
const CLOSE_AFTER_MS = 3000;

// Folders holding MTGA's downloaded data (the one with Downloads/Raw inside).
const WINDOWS_DATA_DIRS = [
  'C:/Program Files/Wizards of the Coast/MTGA/MTGA_Data',
  'C:/Program Files (x86)/Wizards of the Coast/MTGA/MTGA_Data',
  'C:/Program Files (x86)/Steam/steamapps/common/MTGA/MTGA_Data',
  'C:/Program Files/Epic Games/MagicTheGathering/MTGA_Data',
];
// On macOS MTGA downloads its card data into Application Support; older installs kept it
// inside the app bundle.
const MAC_DATA_DIRS = [
  path.join(os.homedir(), 'Library/Application Support/com.wizards.mtga'),
  '/Applications/MTGA.app/Contents/Resources/Data',
  path.join(os.homedir(), 'Applications/MTGA.app/Contents/Resources/Data'),
  path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/MTGA/MTGA.app/Contents/Resources/Data'),
  '/Users/Shared/Epic Games/MagicTheGathering/MTGA.app/Contents/Resources/Data',
];
const DATA_DIR_CANDIDATES = process.platform === 'darwin' ? MAC_DATA_DIRS : WINDOWS_DATA_DIRS;

// The log names the managed-code folder, which sits inside the data folder:
//   Windows: C:/.../MTGA/MTGA_Data/Managed    macOS: /Applications/MTGA.app/Contents/Resources/Data/Managed
function dataDirFromLog(logPath) {
  try {
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = /Mono path\[0\] = '(.+?)[\\/]Managed'/.exec(buf.toString('utf8', 0, n));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function findCardDatabase(logPath) {
  const dirs = [dataDirFromLog(logPath), ...DATA_DIR_CANDIDATES].filter(Boolean);
  for (const dir of dirs) {
    const raw = path.join(dir, 'Downloads', 'Raw');
    let files;
    try {
      files = fs.readdirSync(raw).filter((f) => /^Raw_CardDatabase_.*\.mtga$/.test(f));
    } catch {
      continue;
    }
    const newest = files
      .map((f) => ({ f: path.join(raw, f), t: fs.statSync(path.join(raw, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (newest) return newest.f;
  }
  return null;
}

function parseColors(text) {
  if (!text) return [];
  const set = new Set(String(text).split(',').map((id) => COLOR_IDS[id.trim()]).filter(Boolean));
  return COLOR_ORDER.filter((c) => set.has(c));
}

// Read-only, on-demand access to MTGA's card SQLite database. The file is only held open
// for a few seconds at a time so it never blocks MTGA's own patcher from replacing it.
class CardDb {
  constructor(logPath) {
    this.file = DatabaseSync ? findCardDatabase(logPath) : null;
    this.cache = new Map();
    this.db = null;
    this.stmt = null;
    this.closeTimer = null;
    this.failed = false;
  }

  get available() {
    return Boolean(this.file) && !this.failed;
  }

  open() {
    if (this.db) return true;
    try {
      this.db = new DatabaseSync(this.file, { readOnly: true });
      this.stmt = this.db.prepare(`
        SELECT c.Colors AS colors, c.ColorIdentity AS colorIdentity, c.Types AS types,
          (SELECT l.Loc FROM Localizations_enUS l WHERE l.LocId = c.TitleId
            ORDER BY l.Formatted DESC LIMIT 1) AS name
        FROM Cards c WHERE c.GrpId = ?`);
      return true;
    } catch (err) {
      console.warn('[mtga-journal] card database unavailable:', err.message);
      this.failed = true;
      this.db = null;
      return false;
    }
  }

  scheduleClose() {
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.close(), CLOSE_AFTER_MS);
    this.closeTimer.unref?.();
  }

  close() {
    clearTimeout(this.closeTimer);
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // already closed
      }
    }
    this.db = null;
    this.stmt = null;
  }

  lookup(grpId) {
    if (!grpId) return null;
    if (this.cache.has(grpId)) return this.cache.get(grpId);
    if (!this.available || !this.open()) return null;
    let info = null;
    try {
      const row = this.stmt.get(grpId);
      if (row) {
        const types = String(row.types || '').split(',').map((t) => t.trim());
        info = {
          name: row.name ? String(row.name).replace(/<[^>]+>/g, '') : null,
          colors: parseColors(row.colors),
          colorIdentity: parseColors(row.colorIdentity),
          isLand: types.includes(LAND_TYPE),
          isCreature: types.includes(CREATURE_TYPE),
        };
      }
    } catch (err) {
      console.warn('[mtga-journal] card lookup failed:', err.message);
    }
    this.cache.set(grpId, info);
    this.scheduleClose();
    return info;
  }

  name(grpId) {
    return this.lookup(grpId)?.name || null;
  }

  // Collapses a list of grpIds into named, counted entries grouped for display.
  describeCards(grpIds) {
    const byId = new Map();
    for (const id of grpIds || []) byId.set(id, (byId.get(id) || 0) + 1);
    const groups = { creatures: [], spells: [], lands: [] };
    for (const [grpId, count] of byId) {
      const info = this.lookup(grpId);
      const entry = { grpId, count, name: info?.name || `Card #${grpId}`, colors: info?.colors || [] };
      if (info?.isLand) groups.lands.push(entry);
      else if (info?.isCreature) groups.creatures.push(entry);
      else groups.spells.push(entry);
    }
    for (const list of Object.values(groups)) list.sort((a, b) => a.name.localeCompare(b.name));
    return groups;
  }

  // Main colors of a deck list, with lightly played colors reported as splashes.
  deckColors(grpIds) {
    if (!Array.isArray(grpIds) || !grpIds.length || !this.available) return null;
    const counts = {};
    let spells = 0;
    for (const id of grpIds) {
      const info = this.lookup(id);
      if (!info || info.isLand) continue;
      spells += 1;
      for (const c of info.colors) counts[c] = (counts[c] || 0) + 1;
    }
    if (!spells) return null;
    const main = COLOR_ORDER.filter((c) => (counts[c] || 0) >= 3);
    const splash = COLOR_ORDER.filter((c) => counts[c] && counts[c] < 3);
    return { main, splash };
  }
}

module.exports = { CardDb, findCardDatabase };
