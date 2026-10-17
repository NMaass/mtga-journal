// Turns MTGA internal event names ("PremierDraft_FRA_20260929") into display info.

const WHOLE_NAMES = {
  Play: 'Standard Play',
  Ladder: 'Ranked Standard',
  Traditional_Ladder: 'Traditional Ranked Standard',
  Traditional_Play: 'Traditional Standard Play',
  Historic_Play: 'Historic Play',
  Historic_Ladder: 'Ranked Historic',
  Alchemy_Play: 'Alchemy Play',
  Alchemy_Ladder: 'Ranked Alchemy',
  Explorer_Play: 'Explorer Play',
  Explorer_Ladder: 'Ranked Explorer',
  Timeless_Play: 'Timeless Play',
  Timeless_Ladder: 'Ranked Timeless',
  DirectGame: 'Direct Challenge',
  AIBotMatch: 'Bot Match',
};

const WORDS = { Trad: 'Traditional', Comp: 'Competitive', Bo3: 'Bo3', Bo1: 'Bo1' };

function humanize(token) {
  return token
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map((w) => WORDS[w] || w)
    .join(' ');
}

function eventInfo(eventName) {
  const name = eventName || 'Unknown';
  const isLimited = /draft|sealed|cube/i.test(name);
  if (WHOLE_NAMES[name]) return { format: WHOLE_NAMES[name], setCode: null, isLimited };

  const tokens = name.split('_').filter(Boolean);
  const date = tokens.find((t) => /^\d{8}$/.test(t)) || null;
  const setCode = tokens.find((t) => t !== date && /^[A-Z0-9]{2,5}$/.test(t) && /[A-Z]/.test(t)) || null;
  const words = tokens.filter((t) => t !== date && t !== setCode).map(humanize);
  const format = words.join(' ').replace(/\s+/g, ' ').trim() || name;
  return { format, setCode, isLimited };
}

module.exports = { eventInfo };
