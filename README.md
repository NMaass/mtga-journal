# MTGA Journal

A small Windows overlay for MTG Arena that makes you stop and think between games. It reads
MTGA's `Player.log` and locks the **Play** button until you have written the note the moment
calls for:

| When | What you write | What it unlocks |
| --- | --- | --- |
| You open a draft or sealed event you have not joined yet | Reread one past note (pick one or get a random one), plus an optional takeaway | The event's start button |
| Your deck is built, before game 1 | Draft notes, deck notes, how the deck wins, sideboard options | Play |
| During a game | Nothing is required. A notepad over the opponent's pet asks turn-by-turn questions | — (it never blocks the game) |
| A game ends | Notes on the game. Result, opponent colors, turns, play/draw and mulligans are filled in from the log | Play |

Everything lands in a journal grouped into one accordion per draft (or per day for constructed
queues). Each game shows its notes, tags, mid-game notes and the cards your opponent showed.

## Setup

1. In MTGA, open **Settings → Account** and turn on **Detailed Logs (Plugin Support)**, then
   restart MTGA. Without it the log has no game data.
2. Run MTGA windowed or in borderless fullscreen. Windows can't draw anything over exclusive
   fullscreen, so the overlays would be invisible.
3. Install and start the app:

   ```bash
   npm install
   ```

   ```bash
   npm start
   ```

   If Electron complains that it failed to install, run `node node_modules/electron/install.js` once.

The app lives in the system tray. Closing the journal window keeps it running; quit from the
tray menu.

## Building an installer

To run the app without `npm start`, build a Windows installer:

```bash
npm run dist
```

This writes `dist\MTGA Journal Setup <version>.exe`. It installs for the current user without
asking for admin rights, adds Start-menu and desktop shortcuts, and starts the app when it
finishes. Uninstall from Windows **Settings → Apps**; your journal in `Documents\MTGA Journal`
is left alone. The installer is not code-signed, so SmartScreen may warn on first run
(**More info → Run anyway**).

- `dist\win-unpacked\MTGA Journal.exe` is the same app without installing it.
- The development flags work on the packaged exe too, e.g. `"MTGA Journal.exe" --demo`.
- The installed app and `npm start` are the same app to Windows: whichever starts second just
  brings up the first one's journal window.
- The icons in `build\` are drawn by `scripts/make-icons.js` from the same code as the tray icon
  (`src/main/icon.js`); `npm run dist` regenerates them.

## First-run calibration

- **Play-button lock:** open MTGA to its Home or an event page, then choose
  **Adjust Play-button lock area…** in the tray menu (or Settings → Adjust…) and drag a box
  over the Play button. The default is a guess at the bottom-right corner. The same box also
  locks a draft's start button before you have reviewed a note, so if that event page puts its
  entry buttons somewhere else, draw the box to cover both.
- **Mid-game notepad:** in your first game, drag the notepad by its header (or resize it from
  its edges) so it sits over your opponent's pet. Both areas are saved relative to the MTGA
  window, so they follow it when it moves or resizes.

## The mid-game notepad

It shows only while a game is in progress and never takes focus by itself. Click into it to
type; **Enter** saves and hands focus straight back to MTGA, and **Esc** returns without saving.
Use the **–** button to collapse it to a small pill.

The questions follow your own turn count:

- Your turn 2: *How is the board going to look on turn 5?*
- Your turn 5: shows what you predicted on turn 2 and asks how close it was
- Your other turns from 3 on: *What kind of permission does my opponent have right now?*
- Opponent's turns and the mulligan: *How is this game going to end?*

What you write appears at the top of the post-game notes window, so you can compare it with how
the game actually went.

## Escape hatches

- **Pause lock until next game** in the tray menu or Settings: for when you need to queue now.
- Settings can turn off the review gate, the deck-prep gate or the notepad, and limit required
  post-game notes to Limited games.

## Your data

The journal is plain JSON at `Documents\MTGA Journal\journal.json`. Before the first change in
each session the previous version is copied to `journal.json.bak`, and **Settings → Export
Markdown** writes a readable `journal.md`. On startup the app also imports games from the current
and previous MTGA logs, so recent games show up even if the app was not running when you played
them.

Card names come from MTGA's own card database, opened read-only for a few seconds at a time.

## Development

```bash
npm test
```

```bash
npm run e2e
```

```bash
npm run demo
```

- `npm test` runs the tracker against a synthetic draft session (`test/fixtures/session.js`).
- `npm run e2e` launches the real app against that session written stage by stage, clicks through
  each gate, and saves screenshots. Windows appear on screen for about a minute while it runs.
- `npm run demo` uses a separate demo journal and pretends MTGA fills your screen.
- `npm run replay -- path\to\Player.log` prints every game the parser finds in a log.

Log parsing follows the approach of the 17lands client,
[rconroy293/mtga-log-client](https://github.com/rconroy293/mtga-log-client).
