#!/usr/bin/env node
// Replays an MTGA Player.log through the tracker and prints what the journal would record.
//   node scripts/replay.js [path/to/Player.log] [--json]
const path = require('path');
const os = require('os');
const { parseLogFile } = require('../src/main/logReader');
const { MtgaTracker } = require('../src/main/tracker');
const { eventInfo } = require('../src/main/eventNames');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const file =
  args.find((a) => !a.startsWith('--')) ||
  path.join(os.homedir(), 'AppData', 'LocalLow', 'Wizards Of The Coast', 'MTGA', 'Player.log');

const tracker = new MtgaTracker();
const games = [];
const matches = [];
tracker.on('gameEnd', (g) => games.push(g));
tracker.on('matchEnd', (m) => matches.push(m));

const started = Date.now();
parseLogFile(file, (e) => tracker.handleEntry(e), (l) => tracker.handleRawLine(l));
const elapsed = Date.now() - started;

if (asJson) {
  console.log(JSON.stringify({ games, matches, courses: [...tracker.courses.values()] }, null, 2));
  process.exit(0);
}

console.log(`Parsed ${file} in ${elapsed} ms`);
console.log(`Detailed logs: ${tracker.detailedLogs}  user: ${tracker.screenName} (${tracker.userId})  scene: ${tracker.scene}  inMatch: ${tracker.inMatch}`);
for (const g of games) {
  const info = eventInfo(g.eventName);
  const play = g.onPlay == null ? '?' : g.onPlay ? 'play' : 'draw';
  console.log(
    [
      new Date(g.endedAt).toLocaleString(),
      `${info.format}${info.setCode ? ' ' + info.setCode : ''}`,
      `G${g.gameNumber}/Bo${g.bestOf}`,
      g.result.toUpperCase().padEnd(4),
      `vs ${g.opponent.name} [${g.opponent.colors.join('') || '-'}]`,
      `T${g.turns}`,
      `on ${play}`,
      `mull ${g.myMulligans}/${g.oppMulligans}`,
      `${g.endReason}`,
      `seen ${g.opponent.cardsSeen.length}`,
      `me [${g.myColors.join('')}]`,
      `course ${g.courseId ? g.courseId.slice(0, 8) : '-'}`,
    ].join(' | '),
  );
}
for (const m of matches) console.log(`match ${m.matchId.slice(0, 8)} ${m.eventName} -> ${m.result} (${m.games} games)`);
