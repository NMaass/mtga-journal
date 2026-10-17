const COPY = {
  postgame: ['Notes first', 'Click to write your game notes'],
  prep: ['Deck prep first', 'How does this deck win?'],
  review: ['Review first', 'Reread a past note before drafting'],
};
document.getElementById('lock').addEventListener('click', () => mj.openGate());
async function load() {
  const state = await mj.getState();
  const [title, sub] = COPY[state.gates[0]?.kind] || COPY.postgame;
  document.getElementById('title').textContent = title;
  document.getElementById('sub').textContent = sub;
}
mj.onChange(load);
load();
