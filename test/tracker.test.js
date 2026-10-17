const test = require('node:test');
const assert = require('node:assert');
const { LogLineParser } = require('../src/main/logReader');
const { MtgaTracker, sameEvent } = require('../src/main/tracker');
const { eventInfo } = require('../src/main/eventNames');
const { buildSteps, EVENT, EVENT_PAGE, COURSE, MATCH } = require('./fixtures/session');

function feed(tracker, lines) {
  const parser = new LogLineParser((e) => tracker.handleEntry(e), (l) => tracker.handleRawLine(l));
  for (const line of lines) parser.push(line);
}

test('event names', () => {
  assert.deepStrictEqual(eventInfo('PremierDraft_FRA_20260929'), { format: 'Premier Draft', setCode: 'FRA', isLimited: true });
  assert.deepStrictEqual(eventInfo('Trad_Sealed_FRA_20260929'), { format: 'Traditional Sealed', setCode: 'FRA', isLimited: true });
  assert.strictEqual(eventInfo('Ladder').format, 'Ranked Standard');
  assert.strictEqual(eventInfo('Ladder').isLimited, false);
  assert.ok(sameEvent('FRA_Premier_Draft', 'PremierDraft_FRA_20260929'));
  assert.ok(sameEvent('Trad_Sealed_FRA', 'Trad_Sealed_FRA_20260929'));
  assert.ok(!sameEvent('FRA_Premier_Draft', 'QuickDraft_FRA_20260929'));
});

test('a full draft session moves through review, prep, live turns and the game result', () => {
  const steps = buildSteps(Date.UTC(2026, 9, 17, 20));
  const t = new MtgaTracker();
  const games = [];
  const matches = [];
  const turns = [];
  const joins = [];
  t.on('gameEnd', (g) => games.push(g));
  t.on('matchEnd', (m) => matches.push(m));
  t.on('turn', (s) => s && turns.push(s));
  t.on('eventJoin', (e) => joins.push(e.eventName));

  feed(t, steps.boot);
  assert.strictEqual(t.detailedLogs, true);
  assert.strictEqual(t.currentEventPage(), null, 'Home is not an event page');

  feed(t, steps.openDraftPage);
  assert.deepStrictEqual(t.currentEventPage(), { name: EVENT_PAGE, course: null }, 'unjoined draft page -> review gate');

  feed(t, steps.joinAndDraft);
  assert.deepStrictEqual(joins, [EVENT]);
  assert.strictEqual(t.courses.get(COURSE).module, 'DeckSelect');

  feed(t, steps.buildDeck);
  const page = t.currentEventPage();
  assert.strictEqual(page.course.courseId, COURSE);
  assert.strictEqual(page.course.module, 'CreateMatch');
  assert.strictEqual(page.course.wins + page.course.losses, 0, 'built deck, no games -> prep gate');
  assert.strictEqual(page.course.deck.main.length, 39);
  assert.strictEqual(page.course.deck.side.length, 6);

  feed(t, steps.matchStart);
  assert.strictEqual(t.inMatch, true);
  for (let turn = 1; turn <= 9; turn += 1) feed(t, steps[`turn${turn}`]);
  const live = t.liveState();
  assert.strictEqual(live.gameId, `${MATCH}:1`);
  assert.strictEqual(live.turnNumber, 9);
  assert.strictEqual(live.myTurn, true);
  assert.strictEqual(live.myTurns, 5);
  assert.strictEqual(live.oppTurns, 4);
  assert.strictEqual(live.opponentName, 'Rival');
  assert.ok(turns.some((s) => s.myTurn && s.myTurns === 2), 'notepad sees your turn 2');

  feed(t, steps.gameOver);
  assert.strictEqual(t.liveState(), null);
  assert.strictEqual(t.inMatch, false);
  assert.strictEqual(games.length, 1);
  const g = games[0];
  assert.strictEqual(g.result, 'win');
  assert.strictEqual(g.conceded, 'opponent');
  assert.strictEqual(g.turns, 9);
  assert.strictEqual(g.onPlay, true);
  assert.strictEqual(g.oppMulligans, 1);
  assert.strictEqual(g.courseId, COURSE);
  assert.strictEqual(g.eventName, EVENT);
  assert.deepStrictEqual(g.opponent.colors, ['W', 'B']);
  assert.strictEqual(g.opponent.name, 'Rival');
  assert.strictEqual(g.opponent.cardsSeen.length, 3);
  assert.deepStrictEqual(matches.map((m) => m.result), ['win']);

  feed(t, steps.backToEvent);
  assert.strictEqual(t.currentEventPage().course.wins, 1, 'mid-run page: no review or prep gate');
});

test('a game is only reported once even when GameOver is logged twice', () => {
  const steps = buildSteps();
  const t = new MtgaTracker();
  const games = [];
  t.on('gameEnd', (g) => games.push(g));
  feed(t, [...steps.boot, ...steps.matchStart, ...steps.turn1, ...steps.gameOver, ...steps.gameOver]);
  assert.strictEqual(games.length, 1);
});

test('payloads split across lines are still parsed', () => {
  const entries = [];
  const parser = new LogLineParser((e) => entries.push(e));
  ['[UnityCrossThreadLogger]1/1/2026 1:00:00 PM', '<== EventGetCoursesV2(abc)', '{', '  "Courses": []', '}'].forEach((l) => parser.push(l));
  assert.strictEqual(entries.length, 1);
  assert.ok(entries[0].label.includes('<== EventGetCoursesV2'));
  assert.deepStrictEqual(entries[0].json, { Courses: [] });
});
