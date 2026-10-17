const { h } = UI;
const els = {
  banner: document.getElementById('banner'),
  status: document.getElementById('status'),
  summary: document.getElementById('summary'),
  runs: document.getElementById('runs'),
  search: document.getElementById('search'),
  filter: document.getElementById('filter'),
  drawer: document.getElementById('settings'),
  scrim: document.getElementById('scrim'),
};

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable: preferences just won't persist
    }
  },
};

let state = null;
let query = '';
let kindFilter = store.get('kindFilter', 'all');
// Every event starts collapsed; expanding one only lasts until the app restarts.
const openRuns = new Set();
const editing = new Set();
let deferred = false;

// ---- data helpers -----------------------------------------------------------------------

function groupMatches(games) {
  const map = new Map();
  for (const g of games) {
    if (!map.has(g.matchId)) map.set(g.matchId, { matchId: g.matchId, games: [], result: null });
    const m = map.get(g.matchId);
    m.games.push(g);
    if (g.matchResult) m.result = g.matchResult;
  }
  return [...map.values()].map((m) => ({
    ...m,
    result: m.result || (m.games.length === 1 && m.games[0].bestOf === 1 ? m.games[0].result : null),
  }));
}

function gameText(g) {
  return [
    g.notes,
    g.opponent?.name,
    g.result,
    ...(g.tags || []),
    ...(g.opponent?.cardsSeen || []).map((c) => c.name),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function visibleRuns() {
  const q = query.trim().toLowerCase();
  return state.runs
    .filter((r) => kindFilter === 'all' || r.kind === kindFilter)
    .map((run) => {
      if (!q) return run;
      const runHit = [run.title, run.format, run.setCode, run.eventName, run.notes].filter(Boolean).join(' ').toLowerCase().includes(q);
      const games = runHit ? run.games : run.games.filter((g) => gameText(g).includes(q));
      return games.length || runHit ? { ...run, games } : null;
    })
    .filter(Boolean);
}

function totals(runs) {
  let wins = 0;
  let losses = 0;
  let games = 0;
  let noted = 0;
  for (const run of runs) {
    for (const m of groupMatches(run.games)) {
      if (m.result === 'win') wins += 1;
      else if (m.result === 'loss') losses += 1;
    }
    games += run.games.length;
    noted += run.games.filter((g) => g.notes).length;
  }
  return { wins, losses, games, noted };
}

// ---- rendering ----------------------------------------------------------------------------

function busy() {
  const a = document.activeElement;
  return editing.size > 0 || Boolean(a && els.runs.contains(a) && /^(TEXTAREA|INPUT)$/.test(a.tagName));
}

function scheduleRender() {
  renderChrome();
  if (busy()) deferred = true;
  else renderRuns();
}

function flushDeferred() {
  if (deferred && !busy()) {
    deferred = false;
    renderRuns();
  }
}

const GATE_COPY = {
  postgame: (g) => [`${g.count} game${g.count > 1 ? 's' : ''} waiting for notes`, 'Write notes'],
  prep: () => ['Your new deck needs prep before game 1', 'Write prep'],
  review: () => ['Review a past note before this draft', 'Review now'],
};

function renderChrome() {
  const st = state.status;
  const gate = state.gates[0];
  const [headline, action] = gate ? GATE_COPY[gate.kind](gate) : [];

  UI.fill(els.banner, 
    gate
      ? h(
          'div',
          { class: 'banner' },
          h('span', { class: 'banner-icon', icon: 'lock' }),
          h('div', {},
            h('strong', {}, headline),
            h('span', { class: 'muted' }, st.paused ? ' · lock paused until your next game' : ' · Play stays locked until it is done')),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn primary', onclick: () => mj.openGate() }, action),
        )
      : null,
  );

  const chips = [];
  const chip = (tone, text, title) => chips.push(h('span', { class: `status-chip ${tone}`, title: title || null }, h('span', { class: 'dot' }), text));
  if (st.demo) chip('info', 'Demo mode — separate demo journal');
  if (!st.logFound) chip('warn', 'Player.log not found', st.logPath);
  else chip('ok', 'Watching Player.log', st.logPath);
  if (st.detailedLogs === false) {
    chip('warn', 'Detailed logs are OFF', 'In MTGA: Settings → Account → enable “Detailed Logs (Plugin Support)”, then restart MTGA.');
  }
  chip(st.mtgaRunning ? 'ok' : 'idle', st.mtgaRunning ? (st.inMatch ? 'MTGA · in a match' : 'MTGA running') : 'MTGA not running');
  if (!st.cardNames) chip('idle', 'Card names unavailable', 'MTGA card database not found');
  if (st.user) chip('idle', st.user);
  els.status.replaceChildren(...chips);

  const runs = visibleRuns();
  const t = totals(runs);
  const decided = t.wins + t.losses;
  const tile = (label, value, sub) => h('div', { class: 'tile' }, h('span', { class: 'label' }, label), h('div', { class: 'tile-value' }, value), sub ? h('div', { class: 'tile-sub faint' }, sub) : null);
  els.summary.replaceChildren(
    tile('Match record', h('span', {}, h('span', { class: 'w' }, t.wins), h('span', { class: 'faint' }, '–'), h('span', { class: 'l' }, t.losses)), `${runs.length} event${runs.length === 1 ? '' : 's'}`),
    tile('Match win rate', decided ? `${Math.round((t.wins / decided) * 100)}%` : '—', decided ? `${decided} decided` : 'no matches yet'),
    tile('Games logged', t.games, `${state.pending.length} awaiting notes`),
    tile('Notes written', t.games ? `${Math.round((t.noted / t.games) * 100)}%` : '—', `${t.noted} of ${t.games} games`),
  );
}

function renderRuns() {
  if (!state.runs.length) {
    els.runs.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-mark', icon: 'pen' }),
        h('h2', {}, 'Your journal is empty'),
        h('p', { class: 'muted' }, 'Play a game in MTGA. When it ends, the journal asks for your notes and keeps Play locked until you save them.'),
        h('button', { class: 'btn', onclick: () => mj.simulateGame() }, 'Try it with a simulated game'),
      ),
    );
    return;
  }
  const runs = visibleRuns();
  if (!runs.length) {
    els.runs.replaceChildren(h('div', { class: 'empty small' }, h('p', { class: 'muted' }, 'Nothing matches that search.')));
    return;
  }
  els.runs.replaceChildren(...runs.map(runView));
}

function recordView(record) {
  return h('span', { class: 'record' }, h('span', { class: 'w' }, record.wins), h('span', { class: 'faint' }, '–'), h('span', { class: 'l' }, record.losses));
}

function runView(run) {
  const isOpen = openRuns.has(run.id) || Boolean(query.trim());
  const pending = run.games.filter((g) => g.pending).length;
  const unnoted = run.games.filter((g) => !g.notes && !g.pending).length;
  const deckSource = run.deckColors ? { deckColors: run.deckColors } : run.games[run.games.length - 1] || {};

  const section = h('section', { class: `run${isOpen ? ' open' : ''}` });
  const head = h(
    'button',
    {
      class: 'run-head',
      'aria-expanded': String(isOpen),
      onclick: () => {
        if (openRuns.has(run.id)) openRuns.delete(run.id);
        else openRuns.add(run.id);
        for (const g of run.games) editing.delete(g.id);
        section.replaceWith(runView(run));
      },
    },
    h('span', { class: 'chev', icon: 'chevron' }),
    h('span', { class: `set-badge ${run.kind}` }, run.setCode || (run.kind === 'limited' ? 'LTD' : 'CON')),
    h('span', { class: 'run-title' }, h('strong', {}, run.title || run.format), h('span', { class: 'faint' }, UI.formatDate(run.createdAt))),
    h('span', { class: 'run-meta faint' }, `${run.record.matches} match${run.record.matches === 1 ? '' : 'es'} · ${run.games.length} game${run.games.length === 1 ? '' : 's'}`),
    h('span', { class: 'run-deck' }, UI.deckPips(deckSource)),
    recordView(run.record),
    pending
      ? h('span', { class: 'badge pending' }, `${pending} need${pending === 1 ? 's' : ''} notes`)
      : unnoted
        ? h('span', { class: 'badge' }, `${unnoted} unnoted`)
        : h('span', { class: 'badge done' }, 'all noted'),
  );
  section.append(head);
  if (isOpen) section.append(runBody(run));
  return section;
}

// A textarea that saves itself shortly after typing stops.
function autosaveField({ value, placeholder, label, rows = 2, save, status }) {
  const ta = h('textarea', { class: 'field run-notes', rows, placeholder, 'aria-label': label });
  ta.value = value || '';
  let saved = ta.value;
  let timer = null;
  const flush = async () => {
    clearTimeout(timer);
    timer = null;
    if (ta.value === saved) return;
    try {
      await save(ta.value);
      saved = ta.value;
      status.textContent = 'Saved';
    } catch (err) {
      status.textContent = UI.errorText(err);
    }
  };
  ta.addEventListener('input', () => {
    status.textContent = 'Saving…';
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  });
  ta.addEventListener('blur', async () => {
    await flush();
    flushDeferred();
  });
  return ta;
}

function prepSection(run) {
  const needed = state.gates.some((g) => g.kind === 'prep' && g.runId === run.id);
  const status = h('span', { class: 'faint saved' });
  if (needed && !run.prep) {
    return h(
      'div',
      { class: 'prep-callout' },
      h('span', { icon: 'lock' }),
      h('div', {}, h('strong', {}, 'Deck prep before game 1'), h('div', { class: 'muted' }, 'Draft notes, deck notes, how the deck wins, sideboard options.')),
      h('button', { class: 'btn primary small', onclick: () => mj.openGate() }, 'Write prep'),
    );
  }
  const values = { ...(run.prep || {}) };
  const fields = UI.PREP_FIELDS.map((f) =>
    h(
      'label',
      { class: 'prep-cell' },
      h('span', { class: 'label' }, f.label),
      autosaveField({
        value: values[f.key],
        placeholder: f.hint,
        label: f.label,
        status,
        save: (v) => {
          values[f.key] = v;
          return mj.savePrep(run.id, values);
        },
      }),
    ),
  );
  return h('div', { class: 'run-notes-wrap' }, h('div', { class: 'run-notes-head' }, h('span', { class: 'label' }, 'Deck prep'), status, courseLine(run)), h('div', { class: 'prep-grid' }, fields));
}

function sessionNotes(run) {
  const status = h('span', { class: 'faint saved' });
  return h(
    'div',
    { class: 'run-notes-wrap' },
    h('div', { class: 'run-notes-head' }, h('span', { class: 'label' }, 'Session notes'), status),
    autosaveField({
      value: run.notes,
      placeholder: 'Deck, matchups, what to change…',
      label: 'Session notes',
      status,
      save: (v) => mj.saveRun(run.id, { notes: v }),
    }),
  );
}

function courseLine(run) {
  // Only worth showing when MTGA knows about matches the journal never saw.
  const course = run.course;
  if (!course || course.wins + course.losses <= run.record.wins + run.record.losses) return null;
  return h('span', { class: 'faint course' }, `Event record ${course.wins}–${course.losses}`);
}

function runBody(run) {
  const matches = groupMatches(run.games);
  const anyBo3 = matches.some((m) => m.games[0].bestOf > 1);

  const list = anyBo3
    ? matches.map((m, i) => {
        const gw = m.games.filter((g) => g.result === 'win').length;
        const gl = m.games.filter((g) => g.result === 'loss').length;
        return h(
          'div',
          { class: 'match' },
          h(
            'div',
            { class: 'match-head' },
            h('strong', {}, `Match ${i + 1}`),
            h('span', { class: 'muted' }, ` vs ${m.games[0].opponent?.name || 'Unknown'}`),
            m.result ? h('span', { class: `result ${m.result}` }, m.result.toUpperCase()) : h('span', { class: 'faint' }, 'in progress'),
            h('span', { class: 'faint' }, `games ${gw}–${gl}`),
          ),
          m.games.map((g) => gameView(g, `Game ${g.gameNumber}`)),
        );
      })
    : matches.map((m, i) => gameView(m.games[0], `Match ${i + 1}`));

  return h(
    'div',
    { class: 'run-body' },
    run.kind === 'limited' ? prepSection(run) : sessionNotes(run),
    list.length ? h('div', { class: 'games' }, list) : h('p', { class: 'faint' }, 'No games yet.'),
  );
}

function gameView(g, title) {
  const facts = [
    g.turns ? `T${g.turns}` : null,
    g.onPlay == null ? null : g.onPlay ? 'on the play' : 'on the draw',
    UI.formatDuration(g.endedAt - g.startedAt),
    g.myMulligans ? `mulled ${g.myMulligans}` : null,
    UI.endLine(g) || null,
  ].filter(Boolean);

  const del = h('button', { class: 'icon-btn', title: 'Delete game', 'aria-label': 'Delete game', icon: 'trash' });
  let armed = null;
  del.addEventListener('click', async () => {
    if (!armed) {
      del.classList.add('armed');
      del.title = 'Click again to delete';
      armed = setTimeout(() => {
        armed = null;
        del.classList.remove('armed');
        del.title = 'Delete game';
      }, 3000);
      return;
    }
    clearTimeout(armed);
    await mj.deleteGame(g.id);
  });

  const isEditing = editing.has(g.id);
  const head = h(
    'div',
    { class: 'game-head' },
    h('span', { class: `result ${g.result}` }, g.result.toUpperCase()),
    h('div', { class: 'game-id' }, h('strong', {}, title), h('span', { class: 'faint' }, UI.relative(g.endedAt))),
    h('div', { class: 'game-opp' }, h('span', { class: 'faint' }, 'vs'), h('strong', {}, g.opponent?.name || 'Unknown'), UI.pips(g.opponent?.colors)),
    h('div', { class: 'game-facts faint' }, facts.join(' · ')),
    h(
      'div',
      { class: 'game-actions' },
      isEditing ? null : h('button', { class: 'icon-btn', title: 'Edit notes', 'aria-label': 'Edit notes', icon: 'edit', onclick: () => startEdit(g.id) }),
      del,
    ),
  );

  if (isEditing) {
    const editor = UI.gameEditor(g, {
      tags: state.settings.tags,
      minChars: g.pending ? Number(state.settings.minNoteChars) || 1 : 1,
      saveLabel: 'Save',
      onSave: async (patch) => {
        await mj.saveGame(g.id, patch);
        editing.delete(g.id);
        state = await mj.getState();
        renderChrome();
        renderRuns();
      },
      onCancel: () => {
        editing.delete(g.id);
        renderRuns();
      },
    });
    return h('article', { class: 'game editing' }, head, editor.el);
  }

  const cards = (g.opponent?.cardsSeen || []).filter((c) => c.name);
  return h(
    'article',
    { class: `game${g.pending ? ' pending' : ''}` },
    head,
    g.notes
      ? h('div', { class: 'game-notes' }, g.notes)
      : h(
          'div',
          { class: 'no-notes' },
          h('span', { class: g.pending ? 'pending-text' : 'faint' }, g.pending ? 'Needs notes before your next game.' : 'No notes yet.'),
          h('button', { class: 'btn small', onclick: () => startEdit(g.id) }, 'Add notes'),
        ),
    g.tags?.length ? h('div', { class: 'chips game-tags' }, g.tags.map((t) => h('span', { class: 'chip static' }, t))) : null,
    g.liveNotes?.length
      ? h('details', { class: 'seen' }, h('summary', {}, `Mid-game notes · ${g.liveNotes.length}`), UI.liveNotes(g.liveNotes, { title: '' }))
      : null,
    cards.length
      ? h(
          'details',
          { class: 'seen' },
          h('summary', {}, `Opponent showed ${cards.length} card${cards.length === 1 ? '' : 's'}`),
          h('div', { class: 'chips' }, cards.map((c) => h('span', { class: 'chip static' }, c.name))),
        )
      : null,
  );
}

function startEdit(id) {
  editing.clear();
  editing.add(id);
  renderRuns();
}

// ---- settings drawer ------------------------------------------------------------------

function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3200);
}

async function setSetting(patch) {
  await mj.setSettings(patch);
  state = await mj.getState();
  renderChrome();
}

function settingRow(title, desc, control) {
  return h('div', { class: 'setting' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-title' }, title), desc ? h('div', { class: 'setting-desc faint' }, desc) : null), control);
}

function switchInput(checked, onChange, label) {
  return h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label, checked: checked || null, onchange: (e) => onChange(e.target.checked) });
}

function openSettings() {
  const s = state.settings;
  const st = state.status;

  const minInput = h('input', { type: 'number', class: 'field num', min: 1, max: 500, value: s.minNoteChars, 'aria-label': 'Minimum note length' });
  minInput.addEventListener('change', () => setSetting({ minNoteChars: Math.max(1, Math.min(500, Number(minInput.value) || 1)) }));

  const tagsInput = h('textarea', { class: 'field', rows: 3, 'aria-label': 'Quick tags' });
  tagsInput.value = (s.tags || []).join(', ');
  tagsInput.addEventListener('change', () =>
    setSetting({ tags: [...new Set(tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 24) }),
  );

  const logInput = h('input', { class: 'field mono', value: s.logPath, 'aria-label': 'MTGA log file' });

  els.drawer.replaceChildren(
    h('div', { class: 'drawer-head' }, h('h2', {}, 'Settings'), h('button', { class: 'icon-btn', 'aria-label': 'Close settings', icon: 'close', onclick: closeSettings })),
    h(
      'div',
      { class: 'drawer-body' },
      h('h3', {}, 'The lock'),
      settingRow('Require notes after', 'Which games lock the Play button until you journal them.',
        UI.segmented([['all', 'Every game'], ['limited', 'Limited only']], s.requireNotesFor, (v) => setSetting({ requireNotesFor: v }))),
      settingRow('Minimum note length', 'Characters required before Save unlocks.', minInput),
      settingRow('Review before drafting', 'Reread one past note before you can start a new draft or sealed event.',
        switchInput(s.requireReview, (v) => setSetting({ requireReview: v }), 'Review before drafting')),
      settingRow('Deck prep before game 1', 'Draft notes, deck notes, how the deck wins and sideboard options.',
        switchInput(s.requirePrep, (v) => setSetting({ requirePrep: v }), 'Deck prep before game 1')),
      settingRow('Pause the lock', 'Turns itself back on when your next game ends.', switchInput(st.paused, (v) => mj.setPaused(v), 'Pause the lock')),
      settingRow('Play-button lock area', 'Line the lock up with MTGA’s Play button. Open MTGA to its Home or event screen first.',
        h('div', { class: 'row-buttons' },
          h('button', { class: 'btn small', onclick: () => mj.startCalibration() }, h('span', { icon: 'crosshair' }), 'Adjust…'),
          h('button', { class: 'btn small ghost', onclick: async () => { await setSetting({ lockArea: null }); toast('Lock area reset to default'); } }, 'Reset'))),
      h('h3', {}, 'Notes'),
      settingRow('Open the notes window automatically', 'When a game ends, a deck is built, or a draft page opens.',
        switchInput(s.autoOpenNotes, (v) => setSetting({ autoOpenNotes: v }), 'Open the notes window automatically')),
      settingRow('Mid-game notepad', 'Turn-by-turn questions over the opponent’s pet. Never blocks the game. Drag or resize it in a game to move it.',
        switchInput(s.showNotepad, (v) => setSetting({ showNotepad: v }), 'Mid-game notepad')),
      settingRow('Notepad position', 'Put it back over the opponent’s pet.',
        h('button', { class: 'btn small ghost', onclick: async () => { await setSetting({ notepadArea: null, notepadCollapsed: null }); toast('Notepad position reset'); } }, 'Reset')),
      h('div', { class: 'setting stack' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-title' }, 'Quick tags'), h('div', { class: 'setting-desc faint' }, 'Comma separated. Shown as toggles on every game.')), tagsInput),
      h('h3', {}, 'App'),
      settingRow('Open the journal on startup', null, switchInput(s.openJournalOnStart, (v) => setSetting({ openJournalOnStart: v }), 'Open the journal on startup')),
      settingRow('Start with Windows', null, switchInput(st.launchAtLogin, (v) => setSetting({ launchAtLogin: v }), 'Start with Windows')),
      h('div', { class: 'setting stack' },
        h('div', { class: 'setting-text' }, h('div', { class: 'setting-title' }, 'MTGA log file'), h('div', { class: 'setting-desc faint' }, 'Changing this restarts the app.')),
        logInput,
        h('div', { class: 'row-buttons' },
          h('button', { class: 'btn small', onclick: () => logInput.value.trim() !== s.logPath && setSetting({ logPath: logInput.value.trim() }) }, 'Apply'),
          h('button', { class: 'btn small ghost', onclick: () => setSetting({ logPath: null }) }, 'Use default'))),
      h('div', { class: 'setting stack' },
        h('div', { class: 'setting-text' }, h('div', { class: 'setting-title' }, 'Journal file'), h('div', { class: 'setting-desc faint mono' }, st.journalFile)),
        h('div', { class: 'row-buttons' },
          h('button', { class: 'btn small', onclick: () => mj.openJournalFolder() }, h('span', { icon: 'folder' }), 'Open folder'),
          h('button', { class: 'btn small', onclick: async () => toast(`Exported ${await mj.exportMarkdown()}`) }, h('span', { icon: 'download' }), 'Export Markdown'))),
      settingRow('Test the flow', 'A fake finished game shows the lock and notes window; a test turn shows the notepad.',
        h('div', { class: 'row-buttons' },
          h('button', { class: 'btn small', onclick: () => { mj.simulateGame(); closeSettings(); } }, 'Simulate game'),
          h('button', { class: 'btn small', onclick: () => mj.simulateTurn() }, 'Test notepad turn'))),
    ),
  );
  els.drawer.hidden = false;
  els.scrim.hidden = false;
  requestAnimationFrame(() => els.drawer.classList.add('show'));
}

function closeSettings() {
  els.drawer.classList.remove('show');
  els.scrim.hidden = true;
  setTimeout(() => (els.drawer.hidden = true), 180);
}

// ---- wiring -------------------------------------------------------------------------------

els.filter.append(
  UI.segmented([['all', 'All'], ['limited', 'Limited'], ['constructed', 'Constructed']], kindFilter, (v) => {
    kindFilter = v;
    store.set('kindFilter', v);
    renderChrome();
    renderRuns();
  }),
);
els.search.addEventListener('input', () => {
  query = els.search.value;
  renderChrome();
  renderRuns();
});
document.getElementById('open-settings').addEventListener('click', openSettings);
els.scrim.addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.drawer.hidden) closeSettings();
  if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    els.search.focus();
  }
});
document.addEventListener('focusout', () => setTimeout(flushDeferred, 0));

async function refresh() {
  state = await mj.getState();
  scheduleRender();
}

mj.onChange(refresh);
refresh();
