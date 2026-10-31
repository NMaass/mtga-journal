// Shared DOM helpers and the game notes editor used by both the notes popup and the journal.
(function () {
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'icon') el.innerHTML = ICONS[v] || '';
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // replaceChildren() would print "null" for skipped optional sections.
  function fill(el, ...children) {
    el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false));
    return el;
  }

  const svg = (body, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

  const ICONS = {
    lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    chevron: svg('<path d="m9 6 6 6-6 6"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    minus: svg('<path d="M5 12h14"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
    download: svg('<path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14"/>'),
    crosshair: svg('<circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
    pen: svg('<path d="M15 5l4 4L8 20H4v-4Z"/><path d="m13 7 4 4"/>'),
    shuffle: svg('<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>'),
    spark: svg('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>'),
  };

  const COLORS = ['W', 'U', 'B', 'R', 'G'];
  const COLOR_NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

  function pip(c, extra = '') {
    return h('span', { class: `pip ${c} ${extra}`, title: COLOR_NAMES[c] || c }, c);
  }

  function pips(colors, { splash = [], empty = '—' } = {}) {
    const list = (colors || []).filter((c) => COLORS.includes(c));
    const extra = (splash || []).filter((c) => COLORS.includes(c));
    if (!list.length && !extra.length) return h('span', { class: 'faint' }, empty);
    return h('span', { class: 'pips' }, list.map((c) => pip(c)), extra.map((c) => pip(c, 'splash')));
  }

  function deckPips(game) {
    const d = game.deckColors;
    if (d && (d.main?.length || d.splash?.length)) return pips(d.main, { splash: d.splash });
    return pips(game.myColors);
  }

  function formatDuration(ms) {
    if (!ms || ms < 0) return null;
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  const formatTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const formatDate = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

  function relative(ms) {
    const diff = Date.now() - ms;
    if (diff < 60e3) return 'just now';
    if (diff < 3600e3) return `${Math.round(diff / 60e3)} min ago`;
    const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 86400e3);
    if (days === 0) return `today ${formatTime(ms)}`;
    if (days === 1) return `yesterday ${formatTime(ms)}`;
    if (days < 7) return `${days} days ago`;
    return formatDate(ms);
  }

  function eventTitle(run) {
    return run.title || `${run.format}${run.setCode ? ` · ${run.setCode}` : ''}`;
  }

  function endLine(game) {
    const bits = [];
    if (game.conceded === 'opponent') bits.push('opponent conceded');
    else if (game.conceded === 'me') bits.push('you conceded');
    else if (game.endReason === 'Timeout') bits.push('timed out');
    else if (game.endReason && game.endReason !== 'Game') bits.push(game.endReason.toLowerCase());
    return bits.join(' · ');
  }

  function segmented(options, value, onChange) {
    const wrap = h('div', { class: 'segmented', role: 'group' });
    const render = (current) => {
      wrap.replaceChildren(
        ...options.map(([v, label]) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(v === current),
              onclick: () => {
                render(v);
                onChange(v);
              },
            },
            label,
          ),
        ),
      );
    };
    render(value);
    return wrap;
  }

  function stepper(value, { min = 0, max = 99, onChange }) {
    let v = value;
    const out = h('output', {}, v ?? '–');
    const set = (n) => {
      v = Math.max(min, Math.min(max, n));
      out.textContent = v;
      onChange(v);
    };
    return h(
      'div',
      { class: 'stepper' },
      h('button', { type: 'button', 'aria-label': 'Decrease', onclick: () => set((v ?? min + 1) - 1) }, '−'),
      out,
      h('button', { type: 'button', 'aria-label': 'Increase', onclick: () => set((v ?? min - 1) + 1) }, '+'),
    );
  }

  const PROMPTS = ['Key turn: ', 'Misplay: ', 'Their deck: ', 'Next time: '];

  const PREP_FIELDS = [
    { key: 'draft', n: 1, label: 'Draft notes', hint: 'How the draft went: signals, key picks, what you would take differently.', placeholder: 'Blue was open from P1P4…' },
    { key: 'deck', n: 2, label: 'Deck notes', hint: 'Archetype, curve, removal, worries.', placeholder: 'UR spells, light on two-drops, 4 removal…' },
    { key: 'plan', n: 3, label: 'How this deck wins', hint: 'The win condition, and the turns it comes together.', placeholder: 'Chip in with fliers, hold up tricks, burn them out…' },
    { key: 'sideboard', n: 4, label: 'Sideboard options', hint: 'What comes in, against what, and what goes out.', placeholder: 'vs fliers: bring in Plummet for a 2-drop…' },
  ];

  const IS_MAC = window.mj?.platform === 'darwin';
  const SAVE_HINT = IS_MAC ? '⌘ Return to save' : 'Ctrl+Enter to save';
  const errorText = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  function liveNotes(list, { title = 'Mid-game notes' } = {}) {
    if (!list?.length) return null;
    return h(
      'div',
      { class: 'live-notes' },
      h('span', { class: 'label' }, title),
      h(
        'ol',
        {},
        list.map((n) =>
          h(
            'li',
            {},
            h('span', { class: 'live-turn' }, n.turn != null ? `T${n.turn}` : '·'),
            h('div', {}, n.prompt ? h('div', { class: 'faint live-prompt' }, n.prompt) : null, h('div', { class: 'live-text' }, n.text)),
          ),
        ),
      ),
    );
  }

  function prepReadonly(prep, notes) {
    const rows = PREP_FIELDS.filter((f) => prep?.[f.key]).map((f) =>
      h('div', { class: 'prep-read' }, h('span', { class: 'label' }, f.label), h('div', { class: 'review-notes' }, prep[f.key])),
    );
    if (notes) rows.push(h('div', { class: 'prep-read' }, h('span', { class: 'label' }, 'Notes'), h('div', { class: 'review-notes' }, notes)));
    return h('div', { class: 'prep-readonly' }, rows);
  }

  // Editable form for one game. Calls onSave(patch) and shows any error it throws.
  function gameEditor(game, { tags = [], minChars = 1, saveLabel = 'Save notes', onSave, onCancel, autofocus = true }) {
    const state = {
      result: game.result,
      turns: game.turns ?? null,
      onPlay: game.onPlay,
      myMulligans: game.myMulligans ?? 0,
      opponentColors: new Set(game.opponent?.colors || []),
      tags: new Set(game.tags || []),
    };

    const textarea = h('textarea', {
      class: 'field notes-input',
      rows: 6,
      placeholder: 'What decided this game? What would you do differently next time?',
      'aria-label': 'Game notes',
    });
    textarea.value = game.notes || '';
    const counter = h('span', { class: 'faint counter' });
    const error = h('div', { class: 'error-text', role: 'alert' });
    const save = h('button', { type: 'button', class: 'btn primary' }, saveLabel);

    const ready = () => textarea.value.trim().length >= Math.max(1, minChars);
    const update = () => {
      save.disabled = !ready();
      const n = textarea.value.trim().length;
      counter.textContent = minChars > 1 && n < minChars ? `${n}/${minChars}` : '';
    };
    textarea.addEventListener('input', () => {
      error.textContent = '';
      update();
    });

    async function submit() {
      if (!ready()) {
        error.textContent = minChars > 1 ? `Write at least ${minChars} characters.` : 'Write a note first.';
        textarea.focus();
        return;
      }
      save.disabled = true;
      try {
        await onSave({
          notes: textarea.value,
          tags: [...state.tags],
          result: state.result,
          turns: state.turns,
          onPlay: state.onPlay,
          myMulligans: state.myMulligans,
          opponentColors: [...state.opponentColors],
        });
      } catch (err) {
        error.textContent = errorText(err);
        save.disabled = false;
      }
    }
    save.addEventListener('click', submit);
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    });

    const insertPrompt = (p) => {
      const before = textarea.value.slice(0, textarea.selectionStart);
      const after = textarea.value.slice(textarea.selectionEnd);
      const lead = before && !before.endsWith('\n') ? '\n' : '';
      textarea.value = `${before}${lead}${p}${after}`;
      const pos = (before + lead + p).length;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
      update();
    };

    const colorButtons = COLORS.map((c) => {
      const b = h('button', {
        type: 'button',
        class: `pip ${c}`,
        title: COLOR_NAMES[c],
        'aria-label': `Opponent played ${COLOR_NAMES[c]}`,
        'aria-pressed': String(state.opponentColors.has(c)),
      }, c);
      b.addEventListener('click', () => {
        if (state.opponentColors.has(c)) state.opponentColors.delete(c);
        else state.opponentColors.add(c);
        b.setAttribute('aria-pressed', String(state.opponentColors.has(c)));
      });
      return b;
    });

    const allTags = [...new Set([...tags, ...state.tags])];
    const tagChips = allTags.map((t) => {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.tags.has(t)) }, t);
      b.addEventListener('click', () => {
        if (state.tags.has(t)) state.tags.delete(t);
        else state.tags.add(t);
        b.setAttribute('aria-pressed', String(state.tags.has(t)));
      });
      return b;
    });

    const el = h(
      'div',
      { class: 'editor' },
      h(
        'div',
        { class: 'stat-grid' },
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Result'),
          segmented([['win', 'Win'], ['loss', 'Loss'], ['draw', 'Draw']], state.result, (v) => (state.result = v))),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Turns'),
          stepper(state.turns, { min: 0, max: 199, onChange: (v) => (state.turns = v) })),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'Started'),
          segmented([[true, 'Play'], [false, 'Draw']], state.onPlay, (v) => (state.onPlay = v))),
        h('div', { class: 'stat' }, h('span', { class: 'label' }, 'My mulligans'),
          stepper(state.myMulligans, { min: 0, max: 7, onChange: (v) => (state.myMulligans = v) })),
      ),
      h('div', { class: 'editor-row' }, h('span', { class: 'label' }, 'Opponent colors'), h('div', { class: 'pip-toggles' }, colorButtons)),
      allTags.length ? h('div', { class: 'editor-row' }, h('span', { class: 'label' }, 'Tags'), h('div', { class: 'chips' }, tagChips)) : null,
      h(
        'div',
        { class: 'editor-row grow' },
        h('div', { class: 'notes-head' }, h('label', { class: 'label' }, 'Notes'),
          h('div', { class: 'prompts' }, PROMPTS.map((p) => h('button', { type: 'button', class: 'prompt', onclick: () => insertPrompt(p) }, p.replace(': ', ''))))),
        textarea,
      ),
      h(
        'div',
        { class: 'editor-foot' },
        h('span', { class: 'faint hint' }, SAVE_HINT),
        counter,
        error,
        h('span', { class: 'spacer' }),
        onCancel ? h('button', { type: 'button', class: 'btn ghost', onclick: onCancel }, 'Cancel') : null,
        save,
      ),
    );
    update();
    if (autofocus) requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
    return { el, focus: () => textarea.focus() };
  }

  window.UI = {
    IS_MAC,
    SAVE_HINT,
    h,
    fill,
    ICONS,
    COLORS,
    pip,
    pips,
    deckPips,
    formatDuration,
    formatTime,
    formatDate,
    relative,
    eventTitle,
    endLine,
    segmented,
    gameEditor,
    PREP_FIELDS,
    errorText,
    liveNotes,
    prepReadonly,
  };
})();
