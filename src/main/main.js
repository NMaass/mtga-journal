const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { LogLineParser, LogWatcher, parseLogFile } = require('./logReader');
const { MtgaTracker } = require('./tracker');
const { Journal } = require('./journal');
const { Settings } = require('./settings');
const { CardDb } = require('./cardDb');
const { MtgaWindowTracker } = require('./mtgaWindow');
const { eventInfo } = require('./eventNames');
const { makeIcon } = require('./icon');

const argv = process.argv.slice(1);
const arg = (name) => {
  const found = argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};
// Development flags: --demo, --log=<Player.log>, --data-dir=<dir>, --capture=<dir>
const CAPTURE_DIR = arg('capture');
const LOG_OVERRIDE = arg('log');
const DATA_DIR = arg('data-dir');
const DEMO = argv.includes('--demo') || Boolean(CAPTURE_DIR);
const SIMULATE = DEMO && !LOG_OVERRIDE;

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload.js');
// A game that ended this recently when the app starts still gets the full post-game lock.
const RECENT_GAME_MS = 5 * 60 * 1000;
// Lobby scenes whose bottom-right corner is not the Play button.
const NON_PLAY_SCENES = new Set(['DeckBuilder', 'Draft', 'SealedBoosterOpen', 'TableDraftQueue', 'BoosterChamber']);
const NOTEPAD_PILL = { width: 210, height: 44 };

app.setName('MTGA Journal');
// Matches build.appId in package.json, which the installer puts on the Start-menu shortcut.
if (process.platform === 'win32') app.setAppUserModelId('com.mtgajournal.app');
// Screenshots of windows hidden behind others would otherwise show their last painted frame.
if (CAPTURE_DIR) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let settings;
let journal;
let cardDb;
let tracker;
let watcher;
let windowTracker;
let tray;
let blockerWin;
let gateWin;
let journalWin;
let notepadWin;
let calibrateWin;
let quitting = false;
let trayHintShown = false;

const ui = {
  paused: false,
  calibrating: false,
  mtga: { supported: false, found: false },
  gateKeys: new Set(),
  demoLive: null,
  notepadAdjusting: false,
};

if (!CAPTURE_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showJournal());
  app.whenReady().then(start);
}

app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  // stay alive in the tray
});

// ---- startup ------------------------------------------------------------------------

function dataDir() {
  if (DATA_DIR) return DATA_DIR;
  return DEMO ? path.join(app.getPath('userData'), 'demo-journal') : path.join(app.getPath('documents'), 'MTGA Journal');
}

function logPath() {
  return LOG_OVERRIDE || settings.get('logPath');
}

function start() {
  const dir = dataDir();
  settings = new Settings(dir);
  journal = new Journal(dir);
  cardDb = new CardDb(logPath());
  journal.on('changed', () => {
    refreshOverlay();
    broadcast();
  });

  createBlockerWindow();
  createGateWindow();
  createNotepadWindow();
  createJournalWindow();
  createTray();

  importPreviousLog();
  startLogWatcher();

  windowTracker = new MtgaWindowTracker();
  windowTracker.on('change', (state) => {
    ui.mtga = state;
    refreshOverlay();
  });
  windowTracker.start();
  ui.mtga = windowTracker.state;

  if (settings.get('openJournalOnStart') || DEMO) showJournal();
  refreshOverlay();

  if (SIMULATE) setTimeout(simulateGame, 600);
  if (CAPTURE_DIR && !LOG_OVERRIDE) setTimeout(capture, 2500);
}

function makeTracker() {
  return new MtgaTracker({ cardLookup: (id) => cardDb.lookup(id) });
}

function importPreviousLog() {
  const prev = path.join(path.dirname(logPath()), 'Player-prev.log');
  if (!fs.existsSync(prev)) return;
  const t = makeTracker();
  t.on('gameEnd', (rec) => recordGame(rec, { live: false }));
  t.on('matchEnd', (m) => journal.applyMatchResult(m));
  t.on('course', (c) => journal.applyCourse(c));
  try {
    parseLogFile(prev, (e) => t.handleEntry(e), (l) => t.handleRawLine(l));
  } catch (err) {
    console.warn('[mtga-journal] could not import Player-prev.log:', err.message);
  }
}

function startLogWatcher() {
  tracker = makeTracker();
  let parser = new LogLineParser((e) => tracker.handleEntry(e), (l) => tracker.handleRawLine(l));

  tracker.on('gameEnd', (rec) => {
    if (tracker.live) ui.paused = false;
    recordGame(rec, { live: tracker.live });
  });
  tracker.on('matchEnd', (m) => journal.applyMatchResult(m));
  tracker.on('gameStart', () => {
    // Never cover the board: tuck the gate window away while a game is being played.
    if (tracker.live && gateWin.isVisible()) gateWin.hide();
  });
  tracker.on('course', onCourse);
  tracker.on('eventJoin', ({ eventName }) => {
    if (tracker.live && eventInfo(eventName).isLimited) journal.consumeReview();
  });
  for (const evt of ['state', 'scene', 'status', 'turn']) {
    tracker.on(evt, () => {
      refreshOverlay();
      broadcast();
    });
  }

  watcher = new LogWatcher(logPath());
  watcher.on('line', (line) => parser.push(line));
  if (CAPTURE_DIR && LOG_OVERRIDE) {
    // scripts/e2e.js writes these markers into its synthetic log to request screenshots.
    watcher.on('line', (line) => {
      const marker = /^MTGA-JOURNAL-CAPTURE (\S+)/.exec(line);
      if (marker) captureQueue = captureQueue.then(() => captureVisible(marker[1]));
      const act = /^MTGA-JOURNAL-ACT (\S+)/.exec(line);
      if (act) captureQueue = captureQueue.then(() => devAction(act[1]));
    });
  }
  watcher.on('caughtUp', () => {
    tracker.live = true;
  });
  watcher.on('rotated', () => {
    parser = new LogLineParser((e) => tracker.handleEntry(e), (l) => tracker.handleRawLine(l));
    tracker.resetSession();
    broadcast();
  });
  watcher.on('missing', broadcast);
  watcher.on('error', (err) => console.warn('[mtga-journal] log read error:', err.message));
  watcher.start();
}

function onCourse(course) {
  journal.applyCourse(course);
  const active = !course.gone && course.module !== 'Complete' && eventInfo(course.eventName).isLimited;
  // A built deck (CreateMatch) is where prep starts; earlier modules are still drafting.
  if (active && course.module === 'CreateMatch') {
    journal.ensureRunForCourse(course, { deckColors: course.deck ? cardDb.deckColors(course.deck.main) : null });
  }
}

// ---- games ----------------------------------------------------------------------------

function isLimited(game) {
  return game.superFormat === 'Limited' || eventInfo(game.eventName).isLimited;
}

function requiresNotes(game) {
  return settings.get('requireNotesFor') === 'limited' ? isLimited(game) : true;
}

function pendingRequired() {
  return journal.pending().filter(requiresNotes);
}

function enrich(rec) {
  const cardsSeen = (rec.opponent?.cardsSeen || [])
    .map((c) => (typeof c === 'object' ? c : { grpId: c, name: cardDb.name(c) }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const deckColors = rec.deckColors || cardDb.deckColors(rec.deck);
  const { deck, ...rest } = rec;
  return { ...rest, opponent: { ...rec.opponent, cardsSeen }, deckColors };
}

function recordGame(rec, { live }) {
  if (journal.hasGame(rec.id)) return;
  const game = enrich(rec);
  const recent = !live && rec.endedAt && Date.now() - rec.endedAt < RECENT_GAME_MS;
  const pending = (live || recent) && requiresNotes(game);
  journal.addGame(game, { pending, deckColors: game.deckColors });
}

// ---- gates: things that must be written before the Play button unlocks ------------------

function activeLimitedCourses() {
  if (!tracker) return [];
  return [...tracker.courses.values()].filter(
    (c) => !c.gone && c.module !== 'Complete' && eventInfo(c.eventName).isLimited,
  );
}

function prepRunNeeded() {
  if (!settings.get('requirePrep') || !tracker) return null;
  const page = tracker.currentEventPage();
  const candidates = page ? (page.course ? [page.course] : []) : activeLimitedCourses();
  for (const c of candidates) {
    if (c.module !== 'CreateMatch' || c.wins + c.losses > 0 || !eventInfo(c.eventName).isLimited) continue;
    const run = journal.data.runs[c.courseId];
    if (!run || run.prep?.savedAt || journal.gamesInRun(c.courseId).length) continue;
    return run;
  }
  return null;
}

function reviewNeeded() {
  if (!settings.get('requireReview') || !tracker || journal.data.reviewCredit) return null;
  const page = tracker.currentEventPage();
  if (!page || page.course || !eventInfo(page.name).isLimited) return null;
  if (!journal.reviewables().length) return null;
  return page;
}

function gateList() {
  const gates = [];
  const pending = pendingRequired();
  if (pending.length) gates.push({ kind: 'postgame', key: `postgame:${pending.map((g) => g.id).join(',')}`, count: pending.length });
  const run = prepRunNeeded();
  if (run) gates.push({ kind: 'prep', key: `prep:${run.id}`, runId: run.id });
  const page = reviewNeeded();
  if (page) gates.push({ kind: 'review', key: `review:${page.name}`, event: page.name });
  return gates;
}

// ---- demo helpers -------------------------------------------------------------------------

function simulateGame() {
  const now = Date.now();
  const result = Math.random() < 0.5 ? 'win' : 'loss';
  const id = `demo-${now}:1`;
  if (ui.demoLive) {
    for (const n of journal.liveNotesFor(ui.demoLive.gameId)) journal.addLiveNote(id, n);
    ui.demoLive = null;
  }
  recordGame(
    {
      id,
      matchId: `demo-${now}`,
      gameNumber: 1,
      bestOf: 1,
      eventName: 'PremierDraft_DEMO_20261017',
      courseId: 'demo-course',
      superFormat: 'Limited',
      startedAt: now - 13 * 60 * 1000,
      endedAt: now,
      result,
      endReason: result === 'win' ? 'Concede' : 'Game',
      conceded: result === 'win' ? 'opponent' : null,
      turns: 15,
      onPlay: false,
      myMulligans: 0,
      oppMulligans: 1,
      myLife: result === 'win' ? 9 : 0,
      oppLife: result === 'win' ? 4 : 11,
      myName: 'You',
      opponent: {
        name: 'Demo Opponent',
        rank: 'Gold 2',
        colors: ['B', 'R'],
        cardsSeen: ['Lightning Strike', 'Murder', 'Goblin Guide', 'Gravecrawler'].map((name, i) => ({ grpId: -i - 1, name })),
      },
      myColors: ['U', 'R'],
      deckColors: { main: ['U', 'R'], splash: [] },
      demo: true,
      partial: false,
    },
    { live: true },
  );
  ui.paused = false;
  refreshOverlay();
}

function simulateTurn() {
  const l = ui.demoLive || { gameId: `demo-live-${Date.now()}:1`, gameNumber: 1, opponentName: 'Demo Opponent', turnNumber: 0, myTurn: false, myTurns: 0, oppTurns: 0, onPlay: true };
  const turnNumber = l.turnNumber + 1;
  const myTurn = l.onPlay ? turnNumber % 2 === 1 : turnNumber % 2 === 0;
  ui.demoLive = { ...l, turnNumber, myTurn, myTurns: l.myTurns + (myTurn ? 1 : 0), oppTurns: l.oppTurns + (myTurn ? 0 : 1), phase: 'Main1' };
  refreshOverlay();
  broadcast();
}

function currentLive() {
  return (tracker?.live && tracker.liveState()) || ui.demoLive;
}

// ---- overlay placement ------------------------------------------------------------------

function effectiveMtga() {
  if (ui.mtga.found || !DEMO) return { ...ui.mtga, dip: false };
  // Demo without MTGA: pretend it fills the primary display.
  const area = screen.getPrimaryDisplay().workArea;
  return { supported: true, found: true, minimized: false, foreground: true, bounds: area, dip: true };
}

function toDip(rect, isDip) {
  const r = isDip || process.platform !== 'win32' ? rect : screen.screenToDipRect(null, rect);
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) };
}

function areaBounds(mtga, a) {
  const b = mtga.bounds;
  return toDip({ x: b.x + a.x * b.width, y: b.y + a.y * b.height, width: a.w * b.width, height: a.h * b.height }, mtga.dip);
}

function sameBounds(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function refreshOverlay() {
  if (!blockerWin || blockerWin.isDestroyed() || !journal) return;
  const mtga = effectiveMtga();
  const visible = mtga.found && !mtga.minimized && mtga.bounds.width > 100;
  const focusedOurs = [gateWin, notepadWin].some((w) => w && !w.isDestroyed() && w.isFocused());
  const active = Boolean(mtga.foreground || focusedOurs);
  const sceneOk = !NON_PLAY_SCENES.has(tracker?.scene);
  const gates = gateList();

  const lock = !ui.paused && !ui.calibrating && gates.length > 0 && !tracker?.inMatch && sceneOk && visible && active;
  if (lock) {
    const bounds = areaBounds(mtga, settings.get('lockArea'));
    if (!sameBounds(bounds, blockerWin.getBounds())) blockerWin.setBounds(bounds);
    if (!blockerWin.isVisible()) blockerWin.showInactive();
    blockerWin.setAlwaysOnTop(true, 'screen-saver');
    blockerWin.moveTop();
  } else if (blockerWin.isVisible()) {
    blockerWin.hide();
  }

  if (gateWin.isVisible()) gateWin.setAlwaysOnTop(visible && active, 'floating');

  // Open the gate window whenever a new gate appears (a game just ended, a deck was just
  // built, or a draft's event page was just opened).
  // Gates seen while replaying the log at startup still count as new once it is live.
  if (tracker?.live) {
    const keys = new Set(gates.map((g) => g.key));
    const fresh = gates.some((g) => !ui.gateKeys.has(g.key));
    const cleared = ui.gateKeys.size > 0 && keys.size === 0;
    ui.gateKeys = keys;
    if (fresh && settings.get('autoOpenNotes')) showGate();
    if (cleared && gateWin.isVisible()) gateWin.hide();
  }

  placeNotepad(mtga, visible, active);
  updateTray(gates);
}

function placeNotepad(mtga, visible, active) {
  if (!notepadWin || notepadWin.isDestroyed()) return;
  const live = currentLive();
  const show = settings.get('showNotepad') && Boolean(live) && visible && active && !ui.calibrating;
  if (!show) {
    if (notepadWin.isVisible()) notepadWin.hide();
    return;
  }
  if (!ui.notepadAdjusting) {
    const area = areaBounds(mtga, settings.get('notepadArea'));
    const bounds = settings.get('notepadCollapsed')
      ? { x: area.x + area.width - NOTEPAD_PILL.width, y: area.y, ...NOTEPAD_PILL }
      : { ...area, width: Math.max(260, area.width), height: Math.max(190, area.height) };
    if (!sameBounds(bounds, notepadWin.getBounds())) notepadWin.setBounds(bounds);
  }
  if (!notepadWin.isVisible()) notepadWin.showInactive();
  notepadWin.setAlwaysOnTop(true, 'screen-saver');
}

// ---- windows ----------------------------------------------------------------------------

const webPreferences = { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true };

function createBlockerWindow() {
  blockerWin = new BrowserWindow({
    width: 320,
    height: 120,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences,
  });
  blockerWin.setAlwaysOnTop(true, 'screen-saver');
  blockerWin.loadFile(path.join(RENDERER, 'blocker.html'));
}

function createGateWindow() {
  gateWin = new BrowserWindow({
    width: 500,
    height: 800,
    minWidth: 420,
    minHeight: 540,
    show: false,
    frame: false,
    backgroundColor: '#12141a',
    title: 'MTGA Journal',
    icon: makeIcon(64),
    webPreferences,
  });
  gateWin.loadFile(path.join(RENDERER, 'gate.html'));
  gateWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    gateWin.hide();
  });
  gateWin.on('focus', refreshOverlay);
  gateWin.on('blur', refreshOverlay);
}

// The mid-game notepad never takes focus on its own and sits over the opponent's pet.
function createNotepadWindow() {
  notepadWin = new BrowserWindow({
    width: 360,
    height: 260,
    show: false,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#12141a',
    opacity: 0.94,
    title: 'Mid-game notes',
    webPreferences,
  });
  notepadWin.setAlwaysOnTop(true, 'screen-saver');
  notepadWin.loadFile(path.join(RENDERER, 'notepad.html'));
  notepadWin.on('focus', refreshOverlay);
  notepadWin.on('blur', refreshOverlay);
  // Dragging or resizing the notepad by hand becomes its new home relative to MTGA.
  notepadWin.on('will-move', () => (ui.notepadAdjusting = true));
  notepadWin.on('will-resize', () => (ui.notepadAdjusting = true));
  const remember = () => {
    if (!ui.notepadAdjusting) return;
    ui.notepadAdjusting = false;
    const mtga = effectiveMtga();
    if (!mtga.found) return;
    const m = toDip(mtga.bounds, mtga.dip);
    const b = notepadWin.getBounds();
    if (settings.get('notepadCollapsed')) {
      const a = settings.get('notepadArea');
      settings.update({ notepadArea: { ...a, x: (b.x + b.width - m.x) / m.width - a.w, y: (b.y - m.y) / m.height } });
    } else {
      settings.update({ notepadArea: { x: (b.x - m.x) / m.width, y: (b.y - m.y) / m.height, w: b.width / m.width, h: b.height / m.height } });
    }
  };
  notepadWin.on('moved', remember);
  notepadWin.on('resized', remember);
  notepadWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    notepadWin.hide();
  });
}

function createJournalWindow() {
  journalWin = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 760,
    minHeight: 520,
    show: false,
    backgroundColor: '#0e1015',
    title: 'MTGA Journal',
    icon: makeIcon(64),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e1015', symbolColor: '#aab1c2', height: 44 },
    webPreferences,
  });
  journalWin.loadFile(path.join(RENDERER, 'journal.html'));
  journalWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    journalWin.hide();
    if (!trayHintShown && tray && process.platform === 'win32') {
      trayHintShown = true;
      tray.displayBalloon({
        iconType: 'info',
        title: 'MTGA Journal is still running',
        content: 'It keeps watching your games from the tray. Right-click the tray icon to quit.',
      });
    }
  });
}

function showJournal() {
  if (journalWin.isMinimized()) journalWin.restore();
  journalWin.show();
  journalWin.focus();
}

function showGate() {
  if (!gateWin.isVisible()) {
    const mtga = effectiveMtga();
    const area = mtga.found && !mtga.minimized ? toDip(mtga.bounds, mtga.dip) : screen.getPrimaryDisplay().workArea;
    const height = Math.min(820, Math.max(540, area.height - 60));
    const width = 500;
    gateWin.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + Math.max(20, (area.height - height) / 2)),
      width,
      height,
    });
    gateWin.webContents.send('state:changed');
  }
  gateWin.setAlwaysOnTop(true, 'floating');
  gateWin.show();
  gateWin.focus();
}

function startCalibration() {
  if (calibrateWin) return calibrateWin.focus();
  const mtga = effectiveMtga();
  const area = mtga.found && !mtga.minimized ? toDip(mtga.bounds, mtga.dip) : screen.getPrimaryDisplay().bounds;
  ui.calibrating = true;
  refreshOverlay();
  calibrateWin = new BrowserWindow({
    ...area,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences,
  });
  calibrateWin.setAlwaysOnTop(true, 'screen-saver');
  calibrateWin.loadFile(path.join(RENDERER, 'calibrate.html'));
  calibrateWin.once('ready-to-show', () => {
    calibrateWin.show();
    calibrateWin.focus();
  });
  calibrateWin.on('closed', () => {
    calibrateWin = null;
    ui.calibrating = false;
    refreshOverlay();
  });
}

function broadcast() {
  for (const w of [journalWin, gateWin, blockerWin, notepadWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('state:changed');
  }
}

// ---- tray -------------------------------------------------------------------------------

const GATE_LABELS = { postgame: 'Write game notes', prep: 'Write deck prep', review: 'Review a past note' };

function createTray() {
  tray = new Tray(makeIcon(32));
  tray.on('click', () => (gateList().length ? showGate() : showJournal()));
  updateTray([]);
}

function updateTray(gates) {
  if (!tray) return;
  const key = `${gates.map((g) => g.key).join('|')}:${ui.paused}:${Boolean(ui.demoLive)}`;
  if (tray.key === key) return;
  tray.key = key;
  const first = gates[0];
  tray.setImage(makeIcon(32, { badge: gates.length > 0 }));
  tray.setToolTip(first ? `MTGA Journal — ${GATE_LABELS[first.kind].toLowerCase()} to unlock Play` : 'MTGA Journal');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open journal', click: showJournal },
      { label: first ? `${GATE_LABELS[first.kind]}…` : 'Nothing to write right now', enabled: Boolean(first), click: showGate },
      { type: 'separator' },
      { label: 'Adjust Play-button lock area…', click: startCalibration },
      {
        label: 'Pause lock until next game',
        type: 'checkbox',
        checked: ui.paused,
        click: (item) => {
          ui.paused = item.checked;
          refreshOverlay();
          broadcast();
        },
      },
      { type: 'separator' },
      { label: 'Test: simulate a finished game', click: simulateGame },
      { label: ui.demoLive ? 'Test: advance notepad turn' : 'Test: show mid-game notepad', click: simulateTurn },
      ...(ui.demoLive
        ? [{ label: 'Test: end notepad test', click: () => { ui.demoLive = null; refreshOverlay(); broadcast(); } }]
        : []),
      { type: 'separator' },
      { label: 'Quit MTGA Journal', click: () => app.quit() },
    ]),
  );
}

// ---- IPC --------------------------------------------------------------------------------

function status() {
  return {
    demo: DEMO,
    logPath: logPath(),
    logFound: Boolean(watcher?.exists),
    detailedLogs: tracker?.detailedLogs ?? null,
    user: tracker?.screenName || null,
    scene: tracker?.scene || null,
    inMatch: Boolean(tracker?.inMatch),
    mtgaRunning: Boolean(ui.mtga.found),
    windowTracking: Boolean(ui.mtga.supported),
    cardNames: cardDb.available,
    paused: ui.paused,
    journalFile: journal.file,
    launchAtLogin: process.platform === 'win32' ? app.getLoginItemSettings().openAtLogin : false,
  };
}

function runSummary(run) {
  return run ? { id: run.id, title: run.title || null, format: run.format, setCode: run.setCode, kind: run.kind } : null;
}

function prepDetails(runId) {
  const run = journal.data.runs[runId];
  if (!run) return null;
  const deck = run.deck || tracker?.courses.get(runId)?.deck || null;
  const side = deck ? cardDb.describeCards(deck.side) : null;
  if (side) side.lands = side.lands.filter((c) => !/^(Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(c.name));
  const last = journal.lastTakeaway();
  return {
    run,
    main: deck ? cardDb.describeCards(deck.main) : null,
    side,
    takeaway: last && last.at <= (run.createdAt || Date.now()) + 6 * 3600e3 ? last.takeaway : null,
  };
}

function reviewEntries() {
  const runs = journal.data.runs;
  return journal.reviewables().map((item) => {
    if (item.type === 'game') {
      const g = journal.data.games[item.id];
      return { ...item, run: runSummary(runs[g.runId]), game: g };
    }
    return { ...item, run: runSummary(runs[item.id]), prep: runs[item.id].prep, notes: runs[item.id].notes };
  });
}

ipcMain.handle('state:get', (e) => {
  const sender = BrowserWindow.fromWebContents(e.sender);
  const gates = gateList();
  const live = currentLive();
  const base = { gates, settings: settings.all(), status: status() };
  if (sender === blockerWin) return base;
  if (sender === notepadWin) return { ...base, live, liveNotes: live ? journal.liveNotesFor(live.gameId) : [] };
  const prepGate = gates.find((g) => g.kind === 'prep');
  return {
    ...base,
    ...journal.snapshot(),
    pending: journal.pending().map((g) => ({ ...g, required: requiresNotes(g) })),
    prep: prepGate ? prepDetails(prepGate.runId) : null,
    reviewables: sender === gateWin && gates.some((g) => g.kind === 'review') ? reviewEntries() : null,
    lastReviewedId: journal.data.reviews[journal.data.reviews.length - 1]?.id || null,
    live,
  };
});

ipcMain.handle('game:save', (_e, id, patch) => {
  const game = journal.data.games[id];
  if (!game) throw new Error('That game is no longer in the journal.');
  const notes = String(patch?.notes || '').trim();
  const min = Math.max(1, Number(settings.get('minNoteChars')) || 1);
  if (game.pending && notes.length < min) {
    throw new Error(min > 1 ? `Write at least ${min} characters first.` : 'Write a note first.');
  }
  return journal.saveGame(id, patch || {});
});

ipcMain.handle('run:prep', (_e, id, prep) => {
  // Partial prep is fine to keep, but it doesn't unlock Play for a deck that is waiting on it.
  const missing = ['draft', 'deck', 'plan', 'sideboard'].filter((k) => !String(prep?.[k] || '').trim());
  if (missing.length && prepRunNeeded()?.id === id) throw new Error('Fill in all four sections to unlock Play.');
  return journal.saveRunPrep(id, prep || {});
});

ipcMain.handle('review:complete', (_e, entry) => journal.completeReview(entry || {}));
ipcMain.handle('run:save', (_e, id, patch) => journal.saveRun(id, patch || {}));
ipcMain.handle('game:delete', (_e, id) => journal.deleteGame(id));

ipcMain.handle('live:add', (_e, entry) => {
  const live = currentLive();
  if (!live) throw new Error('No game in progress.');
  return journal.addLiveNote(live.gameId, { ...entry, turn: live.turnNumber, myTurn: live.myTurn, myTurns: live.myTurns });
});

ipcMain.on('mtga:focus', () => {
  if (!windowTracker.focusMtga()) notepadWin.blur();
});

ipcMain.on('notepad:collapse', (_e, collapsed) => {
  settings.update({ notepadCollapsed: Boolean(collapsed) });
  refreshOverlay();
  broadcast();
});

ipcMain.handle('settings:set', (_e, patch) => {
  const before = settings.get('logPath');
  if (patch && 'launchAtLogin' in patch) {
    app.setLoginItemSettings({ openAtLogin: Boolean(patch.launchAtLogin) });
    delete patch.launchAtLogin;
  }
  const next = settings.update(patch);
  if (next.logPath !== before) {
    app.relaunch();
    app.exit(0);
  }
  refreshOverlay();
  broadcast();
  return next;
});

ipcMain.handle('journal:export', () => {
  const file = path.join(path.dirname(journal.file), 'journal.md');
  fs.writeFileSync(file, journal.toMarkdown());
  shell.showItemInFolder(file);
  return file;
});

ipcMain.handle('calibrate:get', () => {
  const mtga = effectiveMtga();
  return { lockArea: settings.get('lockArea'), mtgaFound: Boolean(mtga.found), defaults: settings.all().defaults.lockArea };
});

ipcMain.on('calibrate:done', (_e, rect) => {
  const clean = ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(rect?.[k]) && rect[k] >= 0 && rect[k] <= 1);
  if (clean && rect.w > 0.005 && rect.h > 0.005) settings.update({ lockArea: rect });
  calibrateWin?.close();
});
ipcMain.on('calibrate:cancel', () => calibrateWin?.close());
ipcMain.on('calibrate:start', startCalibration);
ipcMain.on('gate:open', showGate);
ipcMain.on('gate:hide', () => gateWin.hide());
ipcMain.on('journal:open', showJournal);
ipcMain.on('journal:folder', () => shell.openPath(path.dirname(journal.file)));
ipcMain.on('dev:simulate', simulateGame);
ipcMain.on('dev:turn', simulateTurn);
ipcMain.on('lock:pause', (_e, paused) => {
  ui.paused = Boolean(paused);
  refreshOverlay();
  broadcast();
});

// ---- screenshot capture for development ---------------------------------------------------

let captureQueue = Promise.resolve();

async function captureVisible(name) {
  await new Promise((r) => setTimeout(r, 1500));
  if (name === 'done') {
    quitting = true;
    app.exit(0);
    return;
  }
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  const shots = { journal: journalWin, gate: gateWin, blocker: blockerWin, notepad: notepadWin };
  for (const [win, w] of Object.entries(shots)) {
    if (!w.isVisible()) continue;
    const image = await w.webContents.capturePage();
    fs.writeFileSync(path.join(CAPTURE_DIR, `${name}-${win}.png`), image.toPNG());
  }
}

// Scripted user input for scripts/e2e.js. Only these fixed actions exist; the log can name
// one but cannot supply code.
const DEV_ACTIONS = {
  'review-random': [
    () => gateWin,
    `document.querySelector('.hero-actions .btn').click();
     await new Promise((r) => setTimeout(r, 300));
     const t = document.querySelector('textarea');
     t.value = 'Mulligan two-landers on the draw.';
     t.dispatchEvent(new Event('input'));
     [...document.querySelectorAll('.btn.primary')].pop().click();`,
  ],
  'prep-fill': [
    () => gateWin,
    `const answers = ['Blue flowed in pack 2.', 'UR fliers, light on removal.', 'Fliers early, burn to finish.', 'Bring in the Lyra splash against slow decks.'];
     document.querySelectorAll('.prep-field textarea').forEach((t, i) => { t.value = answers[i]; t.dispatchEvent(new Event('input')); });
     [...document.querySelectorAll('.btn.primary')].pop().click();`,
  ],
  'notepad-note': [
    () => notepadWin,
    `const t = document.getElementById('input');
     t.value = 'They kept two Plains open — expect a trick.';
     t.dispatchEvent(new Event('input'));
     t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`,
  ],
  'postgame-note': [
    () => gateWin,
    `const t = document.querySelector('.notes-input');
     t.value = 'Won the race in the air. Should have held removal for Lyra instead of firing it on turn 3.';
     t.dispatchEvent(new Event('input'));
     document.querySelector('.editor button.chip').click();
     [...document.querySelectorAll('.btn.primary')].pop().click();`,
  ],
};

async function devAction(name) {
  await new Promise((r) => setTimeout(r, 1200));
  const action = DEV_ACTIONS[name];
  if (!action) return console.warn(`[e2e] unknown action ${name}`);
  const [win, code] = action;
  try {
    await win().webContents.executeJavaScript(`(async () => { ${code} })()`);
  } catch (err) {
    console.warn(`[e2e] action ${name} failed:`, err.message);
  }
}

async function capture() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  simulateTurn();
  simulateTurn();
  simulateTurn();
  await new Promise((r) => setTimeout(r, 800));
  const shots = { journal: journalWin, gate: gateWin, blocker: blockerWin, notepad: notepadWin };
  for (const [name, win] of Object.entries(shots)) {
    if (!win.isVisible()) win.showInactive();
    await new Promise((r) => setTimeout(r, 500));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(CAPTURE_DIR, `${name}.png`), image.toPNG());
  }
  quitting = true;
  app.exit(0);
}
