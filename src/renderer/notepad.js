const { h } = UI;
const el = (id) => document.getElementById(id);
const pad = el('pad');
const pill = el('pill');
const input = el('input');
const promptEl = el('prompt');
const recallEl = el('recall');
const history = el('history');

let state = null;
// The question the current draft answers; kept while typing even if the turn moves on.
let draftPrompt = null;

// Turn-based questions. "Turn N" is the player's own Nth turn.
function promptFor(live, notes) {
  const prediction = notes.find((n) => n.promptKey === 'board-t5');
  if (live.myTurn && live.myTurns === 2) {
    return { key: 'board-t5', text: 'How is the board going to look on turn 5?' };
  }
  if (live.myTurn && live.myTurns === 5 && prediction) {
    return { key: 'board-t5-check', text: 'Turn 5 — how close was your prediction?', recall: prediction.text };
  }
  if (live.myTurn && live.myTurns >= 3) {
    return { key: 'permission', text: 'What kind of permission does my opponent have right now?' };
  }
  return { key: 'ending', text: 'How is this game going to end?' };
}

function turnLabel(live) {
  if (!live.turnNumber) return 'Mulligans';
  return live.myTurn ? `Your turn ${live.myTurns}` : `Their turn ${live.oppTurns}`;
}

function render() {
  const live = state?.live;
  const collapsed = Boolean(state?.settings?.notepadCollapsed);
  pad.hidden = collapsed;
  pill.hidden = !collapsed;
  if (!live) return;

  el('turn').textContent = turnLabel(live);
  el('opp').textContent = live.opponentName ? `vs ${live.opponentName}` : '';
  el('pill-text').textContent = `Notes · ${turnLabel(live)}`;
  pad.classList.toggle('their-turn', !live.myTurn);

  const notes = state.liveNotes || [];
  const current = input.value.trim() && draftPrompt ? draftPrompt : promptFor(live, notes);
  if (!input.value.trim()) draftPrompt = current;
  promptEl.textContent = current.text;
  recallEl.hidden = !current.recall;
  recallEl.replaceChildren(current.recall ? h('span', { class: 'faint' }, 'You said: ') : '', current.recall || '');

  history.replaceChildren(
    ...notes
      .slice()
      .reverse()
      .map((n) =>
        h('li', {},
          h('span', { class: 'live-turn' }, n.turn != null ? `T${n.turn}` : '·'),
          h('div', {}, n.prompt ? h('div', { class: 'faint live-prompt' }, n.prompt) : null, h('div', { class: 'live-text' }, n.text))),
      ),
  );
}

async function save() {
  const text = input.value.trim();
  if (!text) return mj.focusMtga();
  const prompt = draftPrompt || promptFor(state.live, state.liveNotes || []);
  try {
    await mj.addLiveNote({ text, prompt: prompt.text, promptKey: prompt.key });
    input.value = '';
    draftPrompt = null;
    mj.focusMtga();
  } catch (err) {
    promptEl.textContent = UI.errorText(err);
  }
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    save();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    mj.focusMtga();
  }
});
input.addEventListener('input', () => {
  if (!input.value.trim()) {
    draftPrompt = null;
    render();
  }
});
el('save').addEventListener('click', save);
el('collapse').addEventListener('click', () => mj.setNotepadCollapsed(true));
el('expand').addEventListener('click', () => mj.setNotepadCollapsed(false));
window.addEventListener('focus', () => document.body.classList.add('focused'));
window.addEventListener('blur', () => document.body.classList.remove('focused'));

async function load() {
  state = await mj.getState();
  render();
}
mj.onChange(load);
load();
