#!/usr/bin/env node
// End-to-end check: runs the real app against a synthetic Player.log that is written one
// stage at a time, and saves screenshots of every visible window after each stage.
//   node scripts/e2e.js [workdir]
// Windows will briefly appear on screen while it runs (about 30 seconds).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const electron = require('electron');
const { buildSteps, EVENT, MATCH } = require('../test/fixtures/session');

const work = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'mtga-journal-e2e'));
const dataDir = path.join(work, 'data');
const captures = path.join(work, 'captures');
const log = path.join(work, 'Player.log');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const now = Date.now();
const day = 24 * 3600e3;
// One earlier draft with notes, so there is something to review before drafting, plus a
// turn-2 prediction for the upcoming game so the turn-5 notepad can recall it.
fs.writeFileSync(
  path.join(dataDir, 'journal.json'),
  JSON.stringify(
    {
      version: 1,
      runs: {
        'earlier-run': {
          id: 'earlier-run',
          kind: 'limited',
          eventName: EVENT,
          format: 'Premier Draft',
          setCode: 'FRA',
          courseId: 'earlier-run',
          createdAt: now - 3 * day,
          lastPlayedAt: now - 3 * day,
          notes: '',
          prep: {
            draft: 'Took a white bomb P1P1 and never saw white again.',
            deck: 'UR tempo, only three two-drops.',
            plan: 'Fliers plus burn to close it out.',
            sideboard: 'Plummet in against fliers.',
            savedAt: now - 3 * day,
          },
          course: null,
          deckColors: { main: ['U', 'R'], splash: [] },
        },
      },
      games: {
        'earlier-match:1': {
          id: 'earlier-match:1',
          matchId: 'earlier-match',
          gameNumber: 1,
          bestOf: 1,
          eventName: EVENT,
          courseId: 'earlier-run',
          superFormat: 'Limited',
          startedAt: now - 3 * day - 900e3,
          endedAt: now - 3 * day,
          result: 'loss',
          endReason: 'Game',
          turns: 14,
          onPlay: false,
          myMulligans: 1,
          oppMulligans: 0,
          opponent: { name: 'Gatekeeper', colors: ['W', 'G'], cardsSeen: [] },
          myColors: ['U', 'R'],
          runId: 'earlier-run',
          notes: 'Kept a two-lander on the draw and stumbled until turn 5. Mulligan that next time.',
          tags: ['Mana screw'],
          liveNotes: [],
          pending: false,
          notedAt: now - 3 * day,
        },
      },
      deleted: [],
      liveNotes: {
        [`${MATCH}:1`]: [
          {
            text: 'Two fliers and a held-up counter on my side, two ground blockers on theirs.',
            prompt: 'How is the board going to look on turn 5?',
            promptKey: 'board-t5',
            turn: 3,
            myTurn: true,
            myTurns: 2,
            at: now,
          },
        ],
      },
      reviews: [],
      reviewCredit: false,
    },
    null,
    2,
  ),
);

const steps = buildSteps(now);
// "@name" asks the app for screenshots, "!action" performs a scripted click-through.
const write = (...names) => {
  const lines = names.flatMap((n) => {
    if (n.startsWith('@')) return [`MTGA-JOURNAL-CAPTURE ${n.slice(1)}`];
    if (n.startsWith('!')) return [`MTGA-JOURNAL-ACT ${n.slice(1)}`];
    return steps[n];
  });
  fs.appendFileSync(log, `${lines.join('\n')}\n`);
};
write('boot');

const app = spawn(electron, ['.', `--log=${log}`, `--data-dir=${dataDir}`, `--capture=${captures}`], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
});
const exited = new Promise((resolve) => app.on('exit', resolve));

const plan = [
  ['openDraftPage', '@1-review', '!review-random', '@1b-reviewed'],
  ['joinAndDraft', 'buildDeck', '@2-prep', '!prep-fill', '@2b-prepped'],
  ['matchStart', 'turn1', 'turn2', 'turn3', '@3-notepad-your-turn-2'],
  ['turn4', '!notepad-note', '@4-notepad-their-turn'],
  ['turn5', 'turn6', 'turn7', 'turn8', 'turn9', '@5-notepad-your-turn-5'],
  ['gameOver', '@6-postgame', '!postgame-note', '@6b-noted'],
  ['backToEvent', '@7-journal', '@done'],
];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(5000);
  for (const stage of plan) {
    write(...stage);
    // Each screenshot or scripted action takes a few seconds in the app; let it catch up
    // before the log moves on, so every screenshot shows the stage it is named after.
    await wait(1500 + stage.filter((n) => /^[@!]/.test(n)).length * 4000);
  }
  const timer = setTimeout(() => app.kill(), 20000);
  await exited;
  clearTimeout(timer);

  const files = fs.existsSync(captures) ? fs.readdirSync(captures).sort() : [];
  console.log(`\n${files.length} screenshots in ${captures}`);
  for (const f of files) console.log(`  ${f}`);
  const journal = JSON.parse(fs.readFileSync(path.join(dataDir, 'journal.json'), 'utf8'));
  const game = journal.games[`${MATCH}:1`];
  const run = Object.values(journal.runs).find((r) => r.id !== 'earlier-run');
  const review = journal.reviews[0];
  console.log('');
  console.log(`review:   ${review ? `${review.type} ${review.id}, takeaway "${review.takeaway}"` : 'MISSING'}; spent by joining: ${journal.reviewCredit === false}`);
  console.log(`prep:     ${run?.prep ? ['draft', 'deck', 'plan', 'sideboard'].map((k) => `${k}="${run.prep[k]}"`).join(' ') : 'MISSING'}`);
  console.log(`game:     ${game ? `${game.result} in ${game.turns} turns, pending=${game.pending}, tags=${game.tags}` : 'MISSING'}`);
  console.log(`notes:    ${game?.notes || 'MISSING'}`);
  console.log(`mid-game: ${(game?.liveNotes || []).map((n) => `T${n.turn} ${n.text}`).join(' | ')}`);
})();
