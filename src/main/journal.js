const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { eventInfo } = require('./eventNames');

const VERSION = 1;
const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];

function dayKey(ms) {
  const d = new Date(ms || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function normalizeColors(list) {
  const set = new Set((list || []).map((c) => String(c).toUpperCase()));
  return COLOR_ORDER.filter((c) => set.has(c));
}

class Journal extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'journal.json');
    this.backedUp = false;
    this.saveTimer = null;
    fs.mkdirSync(dir, { recursive: true });
    this.data = this.load();
  }

  load() {
    const empty = { version: VERSION, runs: {}, games: {}, deleted: [], liveNotes: {}, reviews: [], reviewCredit: false };
    if (!fs.existsSync(this.file)) return empty;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...empty,
        ...data,
        runs: data.runs || {},
        games: data.games || {},
        deleted: data.deleted || [],
        liveNotes: data.liveNotes || {},
        reviews: data.reviews || [],
      };
    } catch (err) {
      // Never silently overwrite a journal we failed to read.
      const aside = path.join(this.dir, `journal.unreadable-${Date.now()}.json`);
      fs.copyFileSync(this.file, aside);
      console.error(`[mtga-journal] could not read journal (${err.message}); kept a copy at ${aside}`);
      return empty;
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.backedUp && fs.existsSync(this.file)) {
      fs.copyFileSync(this.file, `${this.file}.bak`);
      this.backedUp = true;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  changed({ immediate = true } = {}) {
    if (immediate) this.save();
    else if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 1000);
    this.emit('changed');
  }

  runIdFor(record) {
    const info = eventInfo(record.eventName);
    const limited = record.superFormat === 'Limited' || info.isLimited;
    if (limited && record.courseId) return record.courseId;
    return `${record.eventName || 'Unknown'}@${dayKey(record.endedAt)}`;
  }

  ensureRun(runId, record) {
    let run = this.data.runs[runId];
    if (!run) {
      const info = eventInfo(record.eventName);
      run = {
        id: runId,
        kind: record.superFormat === 'Limited' || info.isLimited ? 'limited' : 'constructed',
        eventName: record.eventName || 'Unknown',
        format: info.format,
        setCode: info.setCode,
        courseId: record.courseId || null,
        createdAt: record.startedAt || record.endedAt || Date.now(),
        lastPlayedAt: record.endedAt || Date.now(),
        notes: '',
        prep: null,
        course: null,
        deckColors: null,
      };
      this.data.runs[runId] = run;
    }
    return run;
  }

  // Limited runs exist from the moment the deck is built, before any game is played.
  ensureRunForCourse(course, { deckColors = null } = {}) {
    const run = this.ensureRun(course.courseId, {
      eventName: course.eventName,
      superFormat: 'Limited',
      courseId: course.courseId,
      endedAt: Date.now(),
    });
    let touched = false;
    if (course.deck && JSON.stringify(course.deck) !== JSON.stringify(run.deck)) {
      run.deck = course.deck;
      touched = true;
    }
    if (deckColors && JSON.stringify(deckColors) !== JSON.stringify(run.deckColors)) {
      run.deckColors = deckColors;
      touched = true;
    }
    const next = { wins: course.wins, losses: course.losses, module: course.module, deckName: course.deckName };
    if (JSON.stringify(next) !== JSON.stringify(run.course)) {
      run.course = next;
      touched = true;
    }
    if (touched) this.changed({ immediate: false });
    return run;
  }

  gamesInRun(runId) {
    return Object.values(this.data.games).filter((g) => g.runId === runId);
  }

  saveRunPrep(id, prep) {
    const run = this.data.runs[id];
    if (!run) throw new Error(`Unknown run ${id}`);
    const clean = (v) => (typeof v === 'string' ? v.trim() : '');
    run.prep = {
      draft: clean(prep.draft),
      deck: clean(prep.deck),
      plan: clean(prep.plan),
      sideboard: clean(prep.sideboard),
      takeaway: run.prep?.takeaway || null,
      savedAt: run.prep?.savedAt || Date.now(),
      updatedAt: Date.now(),
    };
    this.changed();
    return run;
  }

  // ---- mid-game notes (kept by game id until the game is recorded) ----

  addLiveNote(gameId, entry) {
    if (!gameId || !entry?.text?.trim()) return null;
    const note = {
      text: entry.text.trim(),
      prompt: entry.prompt || null,
      promptKey: entry.promptKey || null,
      turn: entry.turn ?? null,
      myTurn: entry.myTurn ?? null,
      myTurns: entry.myTurns ?? null,
      at: Date.now(),
    };
    const game = this.data.games[gameId];
    if (game) {
      game.liveNotes = [...(game.liveNotes || []), note];
    } else {
      this.data.liveNotes[gameId] = [...(this.data.liveNotes[gameId] || []), note];
    }
    this.changed();
    return note;
  }

  liveNotesFor(gameId) {
    return this.data.games[gameId]?.liveNotes || this.data.liveNotes[gameId] || [];
  }

  // ---- pre-draft review ----

  reviewables() {
    const items = [];
    for (const g of Object.values(this.data.games)) {
      if (g.notes || g.liveNotes?.length) items.push({ type: 'game', id: g.id, at: g.endedAt });
    }
    for (const r of Object.values(this.data.runs)) {
      if (r.prep?.savedAt || r.notes) items.push({ type: 'run', id: r.id, at: r.createdAt });
    }
    return items.sort((a, b) => b.at - a.at);
  }

  completeReview({ type, id, takeaway }) {
    this.data.reviews.push({ type, id, takeaway: takeaway?.trim() || null, at: Date.now() });
    this.data.reviewCredit = true;
    this.changed();
  }

  // Starting a new draft spends the review, so the next draft asks for a fresh one.
  consumeReview() {
    if (!this.data.reviewCredit) return;
    this.data.reviewCredit = false;
    this.changed();
  }

  lastTakeaway() {
    const last = this.data.reviews[this.data.reviews.length - 1];
    return last?.takeaway ? last : null;
  }

  hasGame(id) {
    return Boolean(this.data.games[id]) || this.data.deleted.includes(id);
  }

  addGame(record, { pending = false, deckColors = null } = {}) {
    if (this.hasGame(record.id)) return this.data.games[record.id] || null;
    const runId = this.runIdFor(record);
    const run = this.ensureRun(runId, record);
    run.lastPlayedAt = Math.max(run.lastPlayedAt || 0, record.endedAt || 0);
    run.createdAt = Math.min(run.createdAt || Infinity, record.startedAt || record.endedAt || Infinity);
    if (deckColors) run.deckColors = deckColors;
    const game = {
      ...record,
      runId,
      notes: '',
      tags: [],
      liveNotes: this.data.liveNotes[record.id] || [],
      pending: Boolean(pending),
      notedAt: null,
      createdAt: Date.now(),
    };
    delete this.data.liveNotes[record.id];
    this.data.games[record.id] = game;
    this.changed();
    return game;
  }

  applyCourse(course) {
    const run = this.data.runs[course.courseId];
    if (!run) return;
    const next = { wins: course.wins, losses: course.losses, module: course.module, deckName: course.deckName };
    if (JSON.stringify(next) === JSON.stringify(run.course)) return;
    run.course = next;
    this.changed({ immediate: false });
  }

  applyMatchResult({ matchId, result }) {
    let touched = false;
    for (const g of Object.values(this.data.games)) {
      if (g.matchId === matchId && g.matchResult !== result) {
        g.matchResult = result;
        touched = true;
      }
    }
    if (touched) this.changed();
  }

  saveGame(id, patch) {
    const g = this.data.games[id];
    if (!g) throw new Error(`Unknown game ${id}`);
    if (typeof patch.notes === 'string') g.notes = patch.notes.trim();
    if (Array.isArray(patch.tags)) g.tags = patch.tags.map(String).slice(0, 30);
    if (['win', 'loss', 'draw'].includes(patch.result)) g.result = patch.result;
    if (patch.turns === null || Number.isFinite(patch.turns)) g.turns = patch.turns;
    if (patch.onPlay === null || typeof patch.onPlay === 'boolean') g.onPlay = patch.onPlay;
    if (Number.isFinite(patch.myMulligans)) g.myMulligans = patch.myMulligans;
    if (Array.isArray(patch.opponentColors)) g.opponent = { ...g.opponent, colors: normalizeColors(patch.opponentColors) };
    if (g.notes) {
      g.pending = false;
      g.notedAt = g.notedAt || Date.now();
      g.updatedAt = Date.now();
    }
    this.changed();
    return g;
  }

  saveRun(id, patch) {
    const run = this.data.runs[id];
    if (!run) throw new Error(`Unknown run ${id}`);
    if (typeof patch.notes === 'string') run.notes = patch.notes;
    if (typeof patch.title === 'string') run.title = patch.title.trim() || undefined;
    this.changed();
    return run;
  }

  deleteGame(id) {
    const g = this.data.games[id];
    if (!g) return;
    delete this.data.games[id];
    this.data.deleted.push(id);
    const runStillUsed = Object.values(this.data.games).some((x) => x.runId === g.runId);
    if (!runStillUsed && !this.data.runs[g.runId]?.notes) delete this.data.runs[g.runId];
    this.changed();
  }

  pending() {
    return Object.values(this.data.games)
      .filter((g) => g.pending)
      .sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  }

  runRecord(games) {
    const matches = new Map();
    for (const g of games) {
      const m = matches.get(g.matchId) || { games: [], result: g.matchResult || null };
      m.games.push(g);
      if (g.matchResult) m.result = g.matchResult;
      matches.set(g.matchId, m);
    }
    let wins = 0;
    let losses = 0;
    for (const m of matches.values()) {
      const result = m.result || (m.games.length === 1 && m.games[0].bestOf === 1 ? m.games[0].result : null);
      if (result === 'win') wins += 1;
      else if (result === 'loss') losses += 1;
    }
    return { wins, losses, matches: matches.size };
  }

  snapshot() {
    const gamesByRun = new Map();
    for (const g of Object.values(this.data.games)) {
      if (!gamesByRun.has(g.runId)) gamesByRun.set(g.runId, []);
      gamesByRun.get(g.runId).push(g);
    }
    const runs = Object.values(this.data.runs)
      .map((run) => {
        const games = (gamesByRun.get(run.id) || []).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
        return { ...run, games, record: this.runRecord(games) };
      })
      .filter((run) => run.games.length || run.notes || run.prep || run.kind === 'limited')
      .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    return { runs, file: this.file };
  }

  toMarkdown() {
    const lines = ['# MTGA Journal', ''];
    for (const run of this.snapshot().runs) {
      const title = run.title || `${run.format}${run.setCode ? ` · ${run.setCode}` : ''}`;
      lines.push(`## ${title} — ${dayKey(run.createdAt)} (${run.record.wins}–${run.record.losses})`, '');
      if (run.notes) lines.push(run.notes.trim(), '');
      if (run.prep) {
        const p = run.prep;
        for (const [label, text] of [['Draft', p.draft], ['Deck', p.deck], ['How it wins', p.plan], ['Sideboard', p.sideboard]]) {
          if (text) lines.push(`**${label}:** ${text}`, '');
        }
      }
      for (const g of run.games) {
        const bits = [
          `**${g.result.toUpperCase()}**`,
          `Game ${g.gameNumber}`,
          g.opponent?.name ? `vs ${g.opponent.name}` : null,
          g.opponent?.colors?.length ? `(${g.opponent.colors.join('')})` : null,
          g.turns ? `${g.turns} turns` : null,
          g.onPlay == null ? null : g.onPlay ? 'on the play' : 'on the draw',
        ].filter(Boolean);
        lines.push(`### ${new Date(g.endedAt).toLocaleString()} — ${bits.join(' · ')}`, '');
        if (g.tags?.length) lines.push(`Tags: ${g.tags.join(', ')}`, '');
        const seen = (g.opponent?.cardsSeen || []).map((c) => c.name).filter(Boolean);
        if (seen.length) lines.push(`Opponent showed: ${seen.join(', ')}`, '');
        for (const n of g.liveNotes || []) {
          lines.push(`> Turn ${n.turn ?? '?'}${n.prompt ? ` — ${n.prompt}` : ''}: ${n.text}`, '');
        }
        lines.push(g.notes ? g.notes : '_No notes._', '');
      }
    }
    return lines.join('\n');
  }
}

module.exports = { Journal, dayKey };
