const { EventEmitter } = require('events');

// Log parsing logic follows the 17lands client (rconroy293/mtga-log-client):
// games end on a GameStateMessage whose gameInfo.stage is GameStage_GameOver, matches end
// on matchGameRoomStateChangedEvent.finalMatchResult, and event runs come from Course payloads.

const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];
const CARD_COLORS = {
  CardColor_White: 'W',
  CardColor_Blue: 'U',
  CardColor_Black: 'B',
  CardColor_Red: 'R',
  CardColor_Green: 'G',
};
const BASIC_LAND_TYPES = {
  SubType_Plains: 'W',
  SubType_Island: 'U',
  SubType_Swamp: 'B',
  SubType_Mountain: 'R',
  SubType_Forest: 'G',
};
const CARD_OBJECT_TYPES = new Set([
  'GameObjectType_Card',
  'GameObjectType_SplitCard',
  'GameObjectType_RevealedCard',
  'GameObjectType_MDFCBack',
  'GameObjectType_Adventure',
]);
const FINISHED_MODULES = new Set(['Complete', 'ClaimPrize']);

function sortColors(set) {
  return COLOR_ORDER.filter((c) => set.has(c));
}

function toMillis(ts) {
  if (ts == null || ts === '') return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) {
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (n < 32503680000000) return n; // epoch milliseconds (before year 3000)
  return Math.round(n / 10000 - 62135596800000); // .NET ticks
}

function cleanName(playerName) {
  return playerName ? String(playerName).split('#')[0] : null;
}

function rankFromMetadata(metadata, userId) {
  if (!metadata || !userId) return null;
  const rankClass = metadata[`${userId}_RankClass`];
  if (!rankClass || rankClass === 'None' || rankClass === 'Unranked') return null;
  if (rankClass === 'Mythic') {
    const place = metadata[`${userId}_LeaderboardPlacement`];
    const pct = metadata[`${userId}_LeaderboardPercentile`];
    if (place && Number(place) > 0) return `Mythic #${place}`;
    if (pct && Number(pct) > 0) return `Mythic ${Math.round(Number(pct))}%`;
    return 'Mythic';
  }
  const tier = metadata[`${userId}_RankTier`];
  return tier ? `${rankClass} ${tier}` : rankClass;
}

function decodeRequest(request) {
  if (typeof request !== 'string') return request || null;
  try {
    return JSON.parse(request);
  } catch {
    return null;
  }
}

function deckList(entries) {
  if (!Array.isArray(entries)) return null;
  return entries.flatMap((e) => Array(Math.max(1, e.quantity || 1)).fill(e.cardId)).filter(Boolean);
}

// "FRA_Premier_Draft" (scene context) vs "PremierDraft_FRA_20260929" (internal name).
function eventWords(name) {
  return String(name || '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .split(/[_\s]+/)
    .filter((w) => w && !/^\d{6,}$/.test(w))
    .map((w) => w.toLowerCase());
}

function sameEvent(displayName, internalName) {
  const a = eventWords(displayName);
  const b = new Set(eventWords(internalName));
  return a.length > 0 && a.every((w) => b.has(w));
}

function outcomeFor(result, myTeam) {
  if (!result) return null;
  if (result.result === 'ResultType_Draw') return 'draw';
  if (result.winningTeamId == null) return null;
  return result.winningTeamId === myTeam ? 'win' : 'loss';
}

class MtgaTracker extends EventEmitter {
  constructor({ cardLookup } = {}) {
    super();
    this.cardLookup = cardLookup || null;
    this.live = false;
    this.userId = null;
    this.screenName = null;
    this.detailedLogs = null;
    this.scene = null;
    this.courses = new Map();
    this.courseSeq = 0;
    this.resetSession();
  }

  // Called when MTGA restarts and Player.log starts over.
  resetSession() {
    this.match = null;
    this.game = null;
    this.mySeat = null;
    this.connectDeck = null;
    this.finishedGames = new Set();
    this.setInMatch(false);
  }

  setInMatch(value) {
    if (this.inMatch === value) return;
    this.inMatch = value;
    this.emit('state');
  }

  handleRawLine(line) {
    if (line.startsWith('DETAILED LOGS: ')) {
      const enabled = line.includes('ENABLED');
      if (enabled !== this.detailedLogs) {
        this.detailedLogs = enabled;
        this.emit('status');
      }
    }
  }

  handleEntry({ label, json }) {
    if (!json || typeof json !== 'object') return;

    const account = /Match to (\w+):/.exec(label) || /: (\w+) to Match:/.exec(label);
    if (account) this.userId = account[1];

    if (json.greToClientEvent) {
      const ts = toMillis(json.timestamp);
      for (const msg of json.greToClientEvent.greToClientMessages || []) this.handleGre(msg, ts);
      return;
    }
    if (json.matchGameRoomStateChangedEvent) {
      this.handleRoom(json.matchGameRoomStateChangedEvent, toMillis(json.timestamp));
      return;
    }
    if (label.includes('Client.SceneChange')) {
      this.handleScene(json);
      return;
    }
    if (json.authenticateResponse) {
      this.screenName = cleanName(json.authenticateResponse.screenName) || this.screenName;
      return;
    }
    if (label.includes('==> EventJoin')) {
      const request = decodeRequest(json.request);
      if (request?.EventName) this.emit('eventJoin', { eventName: request.EventName });
      return;
    }
    if (label.includes('<== ')) {
      if (Array.isArray(json.Courses)) this.replaceCourses(json.Courses);
      else if (json.Course && json.Course.CourseId) this.upsertCourse(json.Course);
      else if (json.CourseId && json.InternalEventName) this.upsertCourse(json);
    }
  }

  // ---- events / courses -------------------------------------------------------------

  // EventGetCoursesV2 lists every course the account has; anything missing has ended.
  replaceCourses(list) {
    const present = new Set(list.map((c) => c.CourseId));
    for (const course of this.courses.values()) {
      if (!present.has(course.courseId) && !course.gone) {
        course.gone = true;
        this.emit('course', course);
      }
    }
    list.forEach((c) => this.upsertCourse(c));
  }

  upsertCourse(c) {
    if (!c || !c.CourseId || !c.InternalEventName) return;
    const prev = this.courses.get(c.CourseId);
    const main = deckList(c.CourseDeck?.MainDeck);
    const course = {
      courseId: c.CourseId,
      eventName: c.InternalEventName,
      module: c.CurrentModule || prev?.module || null,
      wins: c.CurrentWins ?? 0,
      losses: c.CurrentLosses ?? 0,
      deckName: c.CourseDeckSummary?.Name || prev?.deckName || null,
      cardPool: Array.isArray(c.CardPool) && c.CardPool.length ? c.CardPool : prev?.cardPool || null,
      deck: main && main.length ? { main, side: deckList(c.CourseDeck?.Sideboard) || [] } : prev?.deck || null,
      gone: false,
      seq: ++this.courseSeq,
    };
    this.courses.set(course.courseId, course);
    if (this.match && !this.match.courseId && this.match.eventId === course.eventName) {
      this.match.courseId = course.courseId;
    }
    this.emit('course', course);
  }

  courseForEvent(eventName, match = (a, b) => a === b) {
    let best = null;
    for (const course of this.courses.values()) {
      if (!match(eventName, course.eventName)) continue;
      const rank = (FINISHED_MODULES.has(course.module) || course.gone ? 0 : 1e9) + course.seq;
      if (!best || rank > best.rank) best = { course, rank };
    }
    return best ? best.course : null;
  }

  // The event whose landing page is open, plus its live course if the player has joined it.
  currentEventPage() {
    if (this.scene !== 'EventLanding' || !this.sceneContext) return null;
    const course = this.courseForEvent(this.sceneContext, sameEvent);
    const active = course && !course.gone && course.module !== 'Complete' ? course : null;
    return { name: this.sceneContext, course: active };
  }

  handleScene(json) {
    const scene = json.toSceneName;
    if (!scene) return;
    this.scene = scene;
    this.sceneContext = json.context || null;
    // Scene changes only happen in the lobby, so any match we thought was live is over.
    if (this.inMatch) {
      this.match = null;
      this.game = null;
      this.setInMatch(false);
    }
    this.emit('scene', scene);
  }

  // ---- matches --------------------------------------------------------------------

  ensureMatch(matchId, ts) {
    if (this.match && this.match.matchId === matchId) return this.match;
    this.match = {
      matchId,
      eventId: null,
      courseId: null,
      startedAt: ts,
      mySeat: this.mySeat,
      myTeam: null,
      opponent: null,
      superFormat: null,
      bestOf: 1,
      deck: this.connectDeck,
    };
    this.game = null;
    return this.match;
  }

  handleRoom(evt, ts) {
    const info = evt.gameRoomInfo || {};
    const cfg = info.gameRoomConfig || {};
    if (cfg.matchId) this.ensureMatch(cfg.matchId, ts);
    const m = this.match;

    if (m && Array.isArray(cfg.reservedPlayers) && cfg.reservedPlayers.length) {
      const players = cfg.reservedPlayers;
      const me =
        players.find((p) => this.userId && p.userId === this.userId) ||
        players.find((p) => this.mySeat != null && p.systemSeatId === this.mySeat);
      const opp = players.find((p) => p !== me && (!me || p.userId !== me.userId));
      if (me) {
        m.mySeat = me.systemSeatId;
        m.myTeam = me.teamId ?? me.systemSeatId;
        m.eventId = me.eventId || m.eventId;
        this.screenName = cleanName(me.playerName) || this.screenName;
        if (!this.userId) this.userId = me.userId;
      }
      if (opp) {
        m.opponent = {
          name: cleanName(opp.playerName),
          userId: opp.userId,
          seat: opp.systemSeatId,
          rank: rankFromMetadata(cfg.clientMetadata, opp.userId),
        };
      }
      m.eventId = m.eventId || cfg.eventId || players[0].eventId || null;
      if (m.eventId && !m.courseId) m.courseId = this.courseForEvent(m.eventId)?.courseId || null;
    }

    if (info.stateType === 'MatchGameRoomStateType_Playing') this.setInMatch(true);
    if (info.finalMatchResult) this.finishMatch(info.finalMatchResult, ts);
  }

  finishMatch(final, ts) {
    const m = this.match && (!final.matchId || this.match.matchId === final.matchId)
      ? this.match
      : this.ensureMatch(final.matchId, ts);
    const list = final.resultList || [];
    const gameResults = list.filter((r) => r.scope === 'MatchScope_Game');

    // Emit any games whose GameOver message we never saw (e.g. tracker started mid-match).
    gameResults.forEach((r, i) => {
      const key = `${m.matchId}:${i + 1}`;
      if (this.finishedGames.has(key)) return;
      this.finishedGames.add(key);
      const game = this.game && this.game.number === i + 1 ? this.game : null;
      this.emit('gameEnd', this.buildRecord(m, game, i + 1, r, ts));
    });

    const matchResult = list.find((r) => r.scope === 'MatchScope_Match');
    this.emit('matchEnd', {
      matchId: m.matchId,
      eventName: m.eventId,
      courseId: m.courseId,
      result: outcomeFor(matchResult, this.myTeam(m)),
      endReason: matchResult?.reason ? matchResult.reason.replace('ResultReason_', '') : null,
      games: gameResults.length,
      endedAt: ts ?? Date.now(),
    });

    this.match = null;
    this.game = null;
    this.setInMatch(false);
  }

  myTeam(m, game) {
    const seat = m.mySeat ?? this.mySeat;
    return (game && game.teams[seat]) ?? m.myTeam ?? seat;
  }

  // ---- games ----------------------------------------------------------------------

  handleGre(msg, ts) {
    if (msg.type === 'GREMessageType_ConnectResp') {
      if (msg.systemSeatIds?.length) this.mySeat = msg.systemSeatIds[0];
      this.connectDeck = msg.connectResp?.deckMessage?.deckCards || null;
      if (this.match) this.match.deck = this.match.deck || this.connectDeck;
      this.setInMatch(true);
    } else if (
      msg.type === 'GREMessageType_GameStateMessage' ||
      msg.type === 'GREMessageType_QueuedGameStateMessage'
    ) {
      this.handleGameState(msg, ts);
    }
  }

  startGame(number, ts) {
    this.game = {
      number,
      startedAt: ts,
      turns: 0,
      turnNumber: 0,
      activePlayer: null,
      phase: null,
      seatTurns: {},
      firstPlayer: null,
      mulligans: {},
      life: {},
      teams: {},
      objects: new Map(),
      ended: false,
    };
    this.setInMatch(true);
    this.emit('gameStart', { matchId: this.match.matchId, gameNumber: number });
  }

  handleGameState(msg, ts) {
    if (msg.systemSeatIds?.length) this.mySeat = msg.systemSeatIds[0];
    const gsm = msg.gameStateMessage;
    if (!gsm) return;
    const gi = gsm.gameInfo;
    if (gi?.matchID) this.ensureMatch(gi.matchID, ts);
    const m = this.match;
    if (!m) return;
    if (m.mySeat == null) m.mySeat = this.mySeat;

    if (gi) {
      if (gi.superFormat) m.superFormat = gi.superFormat;
      if (gi.matchWinCondition) m.bestOf = gi.matchWinCondition.includes('2of3') ? 3 : 1;
    }
    if (gi?.gameNumber && (!this.game || this.game.number !== gi.gameNumber)) this.startGame(gi.gameNumber, ts);
    if (!this.game) this.startGame(1, ts);
    const g = this.game;

    const before = `${g.turnNumber}:${g.activePlayer}`;
    const ti = gsm.turnInfo;
    if (ti) {
      if (ti.turnNumber) {
        g.turns = Math.max(g.turns, ti.turnNumber);
        g.turnNumber = Math.max(g.turnNumber, ti.turnNumber);
      }
      if (ti.activePlayer) g.activePlayer = ti.activePlayer;
      if (ti.phase) g.phase = ti.phase.replace('Phase_', '');
      if (g.firstPlayer == null && ti.activePlayer && (ti.turnNumber || 1) === 1) g.firstPlayer = ti.activePlayer;
    }

    if (Array.isArray(gsm.players)) {
      let turnSum = 0;
      for (const p of gsm.players) {
        const seat = p.systemSeatNumber;
        turnSum += p.turnNumber || 0;
        if (p.turnNumber != null) g.seatTurns[seat] = Math.max(g.seatTurns[seat] || 0, p.turnNumber);
        if (p.mulliganCount != null) g.mulligans[seat] = Math.max(g.mulligans[seat] || 0, p.mulliganCount);
        if (p.lifeTotal != null) g.life[seat] = p.lifeTotal;
        if (p.teamId != null) g.teams[seat] = p.teamId;
      }
      g.turns = Math.max(g.turns, turnSum);
    }

    for (const o of gsm.gameObjects || []) {
      if (!CARD_OBJECT_TYPES.has(o.type)) continue;
      const grpId = o.overlayGrpId || o.grpId;
      if (!grpId) continue;
      const prev = g.objects.get(o.instanceId);
      g.objects.set(o.instanceId, {
        grpId,
        owner: o.ownerSeatId,
        isPublic:
          Boolean(prev?.isPublic) ||
          o.visibility === 'Visibility_Public' ||
          o.type === 'GameObjectType_RevealedCard',
        colors: o.color || prev?.colors || [],
        subtypes: o.subtypes || prev?.subtypes || [],
        superTypes: o.superTypes || prev?.superTypes || [],
        cardTypes: o.cardTypes || prev?.cardTypes || [],
      });
    }

    if (gi?.stage === 'GameStage_GameOver' && Array.isArray(gi.results)) this.finishGame(gi, ts);
    else if (`${g.turnNumber}:${g.activePlayer}` !== before) this.emit('turn', this.liveState());
  }

  finishGame(gi, ts) {
    const m = this.match;
    const gameResults = gi.results.filter((r) => r.scope === 'MatchScope_Game');
    if (!gameResults.length) return;
    const number = gi.gameNumber || gameResults.length;
    const key = `${m.matchId}:${number}`;
    if (this.finishedGames.has(key)) return;
    this.finishedGames.add(key);
    if (this.game && this.game.number === number) this.game.ended = true;
    const result = gameResults[number - 1] || gameResults[gameResults.length - 1];
    this.emit('gameEnd', this.buildRecord(m, this.game, number, result, ts));
    this.emit('turn', null);
  }

  // Snapshot of the game in progress for the mid-game notepad, or null between games.
  liveState() {
    const m = this.match;
    const g = this.game;
    if (!this.inMatch || !m || !g || g.ended) return null;
    const mySeat = m.mySeat ?? this.mySeat;
    const oppSeat = m.opponent?.seat ?? (mySeat === 1 ? 2 : 1);
    return {
      gameId: `${m.matchId}:${g.number}`,
      matchId: m.matchId,
      gameNumber: g.number,
      eventName: m.eventId,
      opponentName: m.opponent?.name || null,
      turnNumber: g.turnNumber,
      myTurn: g.activePlayer != null && g.activePlayer === mySeat,
      myTurns: g.seatTurns[mySeat] || 0,
      oppTurns: g.seatTurns[oppSeat] || 0,
      phase: g.phase,
      onPlay: g.firstPlayer == null ? null : g.firstPlayer === mySeat,
    };
  }

  summarizeSide(game, seat, { publicOnly }) {
    const colors = new Set();
    const cards = new Set();
    for (const o of game.objects.values()) {
      if (o.owner !== seat || (publicOnly && !o.isPublic)) continue;
      const info = this.cardLookup ? this.cardLookup(o.grpId) : null;
      const isLand = o.cardTypes.includes('CardType_Land') || Boolean(info?.isLand);
      const isBasic = o.superTypes.includes('SuperType_Basic');
      if (isLand) {
        for (const st of o.subtypes) if (BASIC_LAND_TYPES[st]) colors.add(BASIC_LAND_TYPES[st]);
        for (const c of info?.colorIdentity || []) colors.add(c);
      } else {
        for (const c of o.colors) if (CARD_COLORS[c]) colors.add(CARD_COLORS[c]);
        if (!o.colors.length) for (const c of info?.colors || []) colors.add(c);
      }
      if (!isBasic) cards.add(o.grpId);
    }
    return { colors: sortColors(colors), cards: [...cards] };
  }

  buildRecord(m, game, number, result, ts) {
    const mySeat = m.mySeat ?? this.mySeat;
    const oppSeat = m.opponent?.seat ?? (mySeat === 1 ? 2 : 1);
    const outcome = outcomeFor(result, this.myTeam(m, game)) || 'loss';
    const reason = result?.reason ? result.reason.replace('ResultReason_', '') : null;
    const opp = game ? this.summarizeSide(game, oppSeat, { publicOnly: true }) : { colors: [], cards: [] };
    const mine = game ? this.summarizeSide(game, mySeat, { publicOnly: false }) : { colors: [], cards: [] };
    if (m.eventId && !m.courseId) m.courseId = this.courseForEvent(m.eventId)?.courseId || null;

    return {
      id: `${m.matchId}:${number}`,
      matchId: m.matchId,
      gameNumber: number,
      bestOf: m.bestOf,
      eventName: m.eventId,
      courseId: m.courseId,
      superFormat: m.superFormat ? m.superFormat.replace('SuperFormat_', '') : null,
      startedAt: game?.startedAt ?? null,
      endedAt: ts ?? Date.now(),
      result: outcome,
      endReason: reason,
      conceded: reason === 'Concede' ? (outcome === 'win' ? 'opponent' : 'me') : null,
      turns: game?.turns || null,
      onPlay: game && game.firstPlayer != null ? game.firstPlayer === mySeat : null,
      myMulligans: game ? game.mulligans[mySeat] || 0 : null,
      oppMulligans: game ? game.mulligans[oppSeat] || 0 : null,
      myLife: game?.life[mySeat] ?? null,
      oppLife: game?.life[oppSeat] ?? null,
      myName: this.screenName,
      opponent: {
        name: m.opponent?.name || null,
        rank: m.opponent?.rank || null,
        colors: opp.colors,
        cardsSeen: opp.cards,
      },
      myColors: mine.colors,
      deck: m.deck || null,
      partial: !game,
    };
  }
}

module.exports = { MtgaTracker, toMillis, sameEvent, COLOR_ORDER };
