const { h } = UI;
const root = document.getElementById('root');
const queue = document.getElementById('queue');
const title = document.getElementById('title');

document.getElementById('hide').addEventListener('click', () => mj.hideGate());
document.getElementById('journal').addEventListener('click', () => mj.openJournal());

// The view currently on screen. Re-renders arrive on every journal change, so a view is
// only rebuilt when the thing it is about changes — never while someone is typing in it.
let viewKey = null;
let review = { selected: null, query: '' };

function lockBanner(text) {
  return h('div', { class: 'lock-banner' }, h('span', { icon: 'lock' }), text);
}

// ---- post-game notes ----------------------------------------------------------------------

function hero(game, run) {
  const facts = [
    `Game ${game.gameNumber}${game.bestOf > 1 ? ` of Bo${game.bestOf}` : ''}`,
    game.turns ? `${game.turns} turns` : null,
    game.onPlay == null ? null : game.onPlay ? 'on the play' : 'on the draw',
    UI.formatDuration(game.endedAt - game.startedAt),
    UI.endLine(game) || null,
  ].filter(Boolean);

  return h(
    'section',
    { class: 'hero' },
    h(
      'div',
      { class: 'hero-top' },
      h('span', { class: `result ${game.result}` }, game.result.toUpperCase()),
      h('span', { class: 'event' }, UI.eventTitle(run)),
      h('span', { class: 'faint when' }, UI.formatTime(game.endedAt)),
    ),
    h(
      'h1',
      { class: 'matchup' },
      h('span', { class: 'faint vs' }, 'vs '),
      game.opponent?.name || 'Unknown opponent',
      game.opponent?.rank ? h('span', { class: 'rank' }, game.opponent.rank) : null,
    ),
    h('div', { class: 'facts muted' }, facts.join(' · ')),
    h(
      'div',
      { class: 'hero-colors' },
      h('span', { class: 'side' }, h('span', { class: 'faint' }, 'You'), UI.deckPips(game)),
      h('span', { class: 'side' }, h('span', { class: 'faint' }, 'Them'), UI.pips(game.opponent?.colors)),
    ),
  );
}

function seenCards(game) {
  const cards = (game.opponent?.cardsSeen || []).filter((c) => c.name);
  if (!cards.length) return null;
  return h(
    'details',
    { class: 'fold', open: cards.length <= 8 },
    h('summary', {}, h('span', { class: 'label' }, `Opponent showed · ${cards.length}`)),
    h('div', { class: 'chips' }, cards.map((c) => h('span', { class: 'chip static' }, c.name))),
  );
}

function renderPostgame(state) {
  const game = state.pending.find((g) => g.required) || state.pending[0];
  const required = state.pending.filter((g) => g.required);
  const index = Math.max(0, required.findIndex((g) => g.id === game.id));
  queue.textContent = required.length > 1 ? `${index + 1} of ${required.length}` : '';
  title.textContent = 'Post-game notes';
  const key = `postgame:${game.id}`;
  if (viewKey === key) return;
  viewKey = key;

  const run = state.runs.find((r) => r.id === game.runId) || { format: 'Game' };
  const editor = UI.gameEditor(game, {
    tags: state.settings.tags,
    minChars: Number(state.settings.minNoteChars) || 1,
    saveLabel: required.length > 1 ? 'Save & next game' : 'Save & unlock Play',
    onSave: async (patch) => {
      await mj.saveGame(game.id, patch);
      viewKey = null;
      await load();
    },
  });

  UI.fill(root, 
    game.required ? lockBanner('Play is locked until you save notes for this game.') : null,
    hero(game, run),
    UI.liveNotes(game.liveNotes, { title: 'What you wrote during the game' }),
    seenCards(game),
    editor.el,
  );
  root.scrollTop = 0;
}

// ---- deck prep before game 1 ----------------------------------------------------------------

function cardList(groups) {
  const section = (label, list) =>
    list.length
      ? h(
          'div',
          { class: 'card-group' },
          h('div', { class: 'card-group-head faint' }, `${label} · ${list.reduce((n, c) => n + c.count, 0)}`),
          h('ul', { class: 'card-list' }, list.map((c) => h('li', {}, h('span', { class: 'count' }, c.count), c.name))),
        )
      : null;
  return h('div', { class: 'card-columns' }, section('Creatures', groups.creatures), section('Spells', groups.spells), section('Lands', groups.lands));
}

function renderPrep(state) {
  queue.textContent = '';
  title.textContent = 'Deck prep';
  const details = state.prep;
  if (!details) return;
  const { run } = details;
  const key = `prep:${run.id}`;
  if (viewKey === key) return;
  viewKey = key;

  const inputs = {};
  const save = h('button', { type: 'button', class: 'btn primary' }, 'Save prep & unlock Play');
  const error = h('div', { class: 'error-text', role: 'alert' });
  const ready = () => UI.PREP_FIELDS.every((f) => inputs[f.key].value.trim());
  const update = () => (save.disabled = !ready());

  const fields = UI.PREP_FIELDS.map((f) => {
    const ta = h('textarea', { class: 'field', rows: f.key === 'draft' ? 3 : 2, placeholder: f.placeholder, 'aria-label': f.label });
    ta.value = run.prep?.[f.key] || '';
    ta.addEventListener('input', () => {
      error.textContent = '';
      update();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    });
    inputs[f.key] = ta;
    const extra =
      f.key === 'sideboard' && details.side && Object.values(details.side).some((l) => l.length)
        ? h('details', { class: 'fold' }, h('summary', {}, h('span', { class: 'label' }, 'Your sideboard')),
            h('div', { class: 'chips' }, [...details.side.creatures, ...details.side.spells, ...details.side.lands].map((c) =>
              h('span', { class: 'chip static' }, c.count > 1 ? `${c.count}× ${c.name}` : c.name))))
        : null;
    return h('div', { class: 'prep-field' }, h('label', { class: 'prep-label' }, h('span', { class: 'prep-num' }, f.n), f.label), h('div', { class: 'faint prep-hint' }, f.hint), ta, extra);
  });

  async function submit() {
    if (!ready()) {
      error.textContent = 'Fill in all four sections first.';
      return;
    }
    save.disabled = true;
    try {
      await mj.savePrep(run.id, Object.fromEntries(UI.PREP_FIELDS.map((f) => [f.key, inputs[f.key].value])));
      viewKey = null;
      await load();
    } catch (err) {
      error.textContent = UI.errorText(err);
      save.disabled = false;
    }
  }
  save.addEventListener('click', submit);

  UI.fill(root, 
    lockBanner('Play is locked until you prep this deck for game 1.'),
    h(
      'section',
      { class: 'hero' },
      h('div', { class: 'hero-top' }, h('span', { class: 'set-pill' }, run.setCode || 'LTD'), h('span', { class: 'event' }, UI.eventTitle(run)), h('span', { class: 'faint when' }, 'before game 1')),
      h('h1', { class: 'matchup' }, 'How does this deck win?'),
      h('div', { class: 'facts muted' }, 'Write it down now, while the draft is fresh. You will see it again in your journal.'),
      run.deckColors ? h('div', { class: 'hero-colors' }, h('span', { class: 'side' }, h('span', { class: 'faint' }, 'Deck'), UI.deckPips(run))) : null,
    ),
    details.takeaway ? h('div', { class: 'callout' }, h('span', { class: 'label' }, 'Your takeaway from review'), h('div', {}, details.takeaway)) : null,
    details.main ? h('details', { class: 'fold deck', open: true }, h('summary', {}, h('span', { class: 'label' }, 'Your deck')), cardList(details.main)) : null,
    h('div', { class: 'prep-fields' }, fields),
    h('div', { class: 'editor-foot' }, h('span', { class: 'faint hint' }, UI.SAVE_HINT), error, h('span', { class: 'spacer' }), save),
  );
  update();
  root.scrollTop = 0;
  requestAnimationFrame(() => (UI.PREP_FIELDS.map((f) => inputs[f.key]).find((t) => !t.value.trim()) || inputs.draft).focus({ preventScroll: true }));
}

// ---- pre-draft review -------------------------------------------------------------------------

function entryTitle(entry) {
  return entry.run ? UI.eventTitle(entry.run) : 'Game';
}

function entrySubtitle(entry) {
  if (entry.type === 'run') return 'Deck prep & draft notes';
  const g = entry.game;
  return `Game ${g.gameNumber} vs ${g.opponent?.name || 'Unknown'}`;
}

function entrySnippet(entry) {
  const text = entry.type === 'game' ? entry.game.notes || entry.game.liveNotes?.[0]?.text : entry.prep?.plan || entry.prep?.draft || entry.notes;
  return (text || '').replace(/\s+/g, ' ').slice(0, 120);
}

function entryText(entry) {
  return [entryTitle(entry), entrySubtitle(entry), entrySnippet(entry), entry.game?.notes, ...(entry.game?.tags || []), ...Object.values(entry.prep || {})]
    .filter((v) => typeof v === 'string')
    .join(' ')
    .toLowerCase();
}

function reviewDetail(entry, state) {
  const takeaway = h('textarea', { class: 'field', rows: 2, placeholder: 'One thing to carry into this draft (optional)', 'aria-label': 'Takeaway' });
  const done = h('button', { type: 'button', class: 'btn primary' }, 'Done reviewing — unlock');
  done.addEventListener('click', async () => {
    done.disabled = true;
    await mj.completeReview({ type: entry.type, id: entry.id, takeaway: takeaway.value });
    review = { selected: null, query: '' };
    viewKey = null;
    await load();
  });

  let body;
  if (entry.type === 'game') {
    const g = entry.game;
    body = [
      h('div', { class: 'hero-top' }, h('span', { class: `result ${g.result}` }, g.result.toUpperCase()), h('span', { class: 'event' }, entryTitle(entry)), h('span', { class: 'faint when' }, UI.formatDate(g.endedAt))),
      h('h1', { class: 'matchup' }, h('span', { class: 'faint vs' }, 'vs '), g.opponent?.name || 'Unknown opponent'),
      h('div', { class: 'facts muted' }, [`Game ${g.gameNumber}`, g.turns ? `${g.turns} turns` : null, g.onPlay == null ? null : g.onPlay ? 'on the play' : 'on the draw'].filter(Boolean).join(' · ')),
      g.notes ? h('div', { class: 'review-notes' }, g.notes) : null,
      g.tags?.length ? h('div', { class: 'chips' }, g.tags.map((t) => h('span', { class: 'chip static' }, t))) : null,
    ];
  } else {
    body = [
      h('div', { class: 'hero-top' }, h('span', { class: 'set-pill' }, entry.run?.setCode || 'LTD'), h('span', { class: 'event' }, entryTitle(entry)), h('span', { class: 'faint when' }, UI.formatDate(entry.at))),
      h('h1', { class: 'matchup' }, 'Deck prep'),
      UI.prepReadonly(entry.prep, entry.notes),
    ];
  }

  return [
    h('button', { class: 'btn ghost small back', onclick: () => { review.selected = null; viewKey = null; renderReview(state); } }, '← All notes'),
    h('section', { class: 'hero review-card' }, body),
    entry.type === 'game' ? UI.liveNotes(entry.game.liveNotes, { title: 'Mid-game notes' }) : null,
    h('div', { class: 'prep-field' }, h('label', { class: 'prep-label' }, 'Takeaway'), takeaway),
    h('div', { class: 'editor-foot' }, h('span', { class: 'spacer' }), done),
  ];
}

function renderReview(state) {
  queue.textContent = '';
  title.textContent = 'Before you draft';
  const entries = state.reviewables || [];
  const gate = state.gates.find((g) => g.kind === 'review');
  const key = `review:${gate?.event}:${review.selected?.id || 'list'}`;
  if (viewKey === key) return;
  viewKey = key;

  if (review.selected) {
    const fresh = entries.find((e) => e.id === review.selected.id) || review.selected;
    UI.fill(root, lockBanner('Review one past note before starting this draft.'), ...reviewDetail(fresh, state));
    root.scrollTop = 0;
    return;
  }

  const open = (entry) => {
    review.selected = entry;
    viewKey = null;
    renderReview(state);
  };
  const random = () => {
    const last = state.lastReviewedId;
    const pool = entries.length > 1 ? entries.filter((e) => e.id !== last) : entries;
    open(pool[Math.floor(Math.random() * pool.length)]);
  };

  const list = h('div', { class: 'review-list' });
  const renderList = () => {
    const q = review.query.trim().toLowerCase();
    const shown = entries.filter((e) => !q || entryText(e).includes(q)).slice(0, 80);
    UI.fill(list, 
      ...shown.map((e) =>
        h(
          'button',
          { type: 'button', class: 'review-item', onclick: () => open(e) },
          h('div', { class: 'review-item-top' },
            e.type === 'game' ? h('span', { class: `result ${e.game.result}` }, e.game.result.toUpperCase()) : h('span', { class: 'set-pill' }, 'PREP'),
            h('strong', {}, entryTitle(e)),
            h('span', { class: 'faint' }, UI.formatDate(e.at))),
          h('div', { class: 'muted review-item-sub' }, entrySubtitle(e)),
          entrySnippet(e) ? h('div', { class: 'faint review-item-snippet' }, entrySnippet(e)) : null,
        ),
      ),
      shown.length ? null : h('p', { class: 'faint' }, 'Nothing matches.'),
    );
  };
  const search = h('input', { type: 'search', class: 'field', placeholder: 'Search your notes…', 'aria-label': 'Search your notes' });
  search.value = review.query;
  search.addEventListener('input', () => {
    review.query = search.value;
    renderList();
  });
  renderList();

  UI.fill(root, 
    lockBanner('Review one past note before starting this draft.'),
    h(
      'section',
      { class: 'hero' },
      h('div', { class: 'hero-top' }, h('span', { class: 'set-pill' }, 'DRAFT'), h('span', { class: 'event' }, (gate?.event || '').replace(/_/g, ' '))),
      h('h1', { class: 'matchup' }, 'What did your last drafts teach you?'),
      h('div', { class: 'facts muted' }, 'Pick a note to reread, or let the journal choose one for you.'),
      h('div', { class: 'hero-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: random }, h('span', { icon: 'shuffle' }), 'Review a random note')),
    ),
    h('div', { class: 'prep-field' }, h('span', { class: 'label' }, `Or pick one · ${entries.length}`), search),
    list,
  );
}

// ---- dispatch -------------------------------------------------------------------------------

function renderEmpty() {
  queue.textContent = '';
  title.textContent = 'MTGA Journal';
  if (viewKey === 'empty') return;
  viewKey = 'empty';
  UI.fill(root, 
    h(
      'div',
      { class: 'empty' },
      h('div', { class: 'empty-mark', icon: 'spark' }),
      h('h2', {}, 'All caught up'),
      h('p', { class: 'muted' }, 'Nothing to write right now. Play is unlocked — good luck out there.'),
      h('button', { class: 'btn', onclick: () => mj.openJournal() }, 'Open journal'),
    ),
  );
}

async function load() {
  const state = await mj.getState();
  const gate = state.gates[0];
  if (!gate) return renderEmpty();
  if (gate.kind === 'postgame') return renderPostgame(state);
  if (gate.kind === 'prep') return renderPrep(state);
  return renderReview(state);
}

mj.onChange(load);
window.addEventListener('focus', () => {
  const target = root.querySelector('textarea:not([readonly])');
  if (target && !root.contains(document.activeElement)) target.focus();
});
load();
