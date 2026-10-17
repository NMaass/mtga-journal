// Builds a synthetic Player.log for one Premier Draft session, in the same shape MTGA writes:
// open the event page, join, draft, build, play one Bo1 game turn by turn, win it.
// Card ids are real FRA cards so the MTGA card database can name them when it is installed.

const USER = 'TESTUSERID0000000000000000';
const OPP = 'OPPUSERID00000000000000000';
const EVENT = 'PremierDraft_FRA_20260929';
const EVENT_PAGE = 'FRA_Premier_Draft';
const COURSE = '11111111-2222-4333-8444-555555555555';
const MATCH = '99999999-8888-4777-8666-555555555555';
const DECK = [106320, 106399, 106399, 106259, 106499, 106306, 106461, 106361, 106361, 106361, 106468, 106304, 106328, 106303, 106303, 106311, 106520, 106256, 106458, 106257, 106369, 106325, 106418];
const SIDEBOARD = [106446, 106294, 106343, 106526, 106283, 106249];
const OPP_CARDS = [
  { grpId: 106446, color: ['CardColor_White'], cardTypes: ['CardType_Creature'] },
  { grpId: 106294, color: ['CardColor_Black'], cardTypes: ['CardType_Creature'] },
  { grpId: 106343, color: ['CardColor_Black'], cardTypes: ['CardType_Instant'] },
];

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const stamp = (t) => new Date(t).toLocaleString('en-US').replace(',', '');

function response(t, name, payload) {
  return [`[UnityCrossThreadLogger]${stamp(t)}`, `<== ${name}(${uuid()})`, JSON.stringify(payload)];
}

function request(name, payload) {
  return [`[UnityCrossThreadLogger]==> ${name} ${JSON.stringify({ id: uuid(), request: JSON.stringify(payload) })}`];
}

function scene(from, to, context) {
  return [`[UnityCrossThreadLogger]Client.SceneChange ${JSON.stringify({ fromSceneName: from, toSceneName: to, initiator: 'User', context })}`];
}

function course(module, { wins = 0, losses = 0, deck = false } = {}) {
  return {
    CourseId: COURSE,
    InternalEventName: EVENT,
    CurrentModule: module,
    ModulePayload: '',
    CurrentWins: wins,
    CurrentLosses: losses,
    CourseDeckSummary: { Name: 'Draft Deck', Attributes: [] },
    CourseDeck: deck
      ? {
          MainDeck: [...DECK, 106533, 106528].map((cardId) => ({ cardId, quantity: cardId > 106500 && [106533, 106528].includes(cardId) ? 8 : 1 })),
          Sideboard: SIDEBOARD.map((cardId) => ({ cardId, quantity: 1 })),
        }
      : undefined,
    CardPool: deck ? [...DECK, ...SIDEBOARD] : [],
  };
}

const playCourse = { CourseId: 'aaaaaaaa-0000-4000-8000-000000000000', InternalEventName: 'Play', CurrentModule: 'Complete' };

function gre(t, messages) {
  return [
    `[UnityCrossThreadLogger]${stamp(t)}: Match to ${USER}: GreToClientEvent`,
    JSON.stringify({ transactionId: uuid(), requestId: ++seq, timestamp: String(t), greToClientEvent: { greToClientMessages: messages } }),
  ];
}

function room(t, stateType, extra = {}) {
  return [
    `[UnityCrossThreadLogger]${stamp(t)}: Match to ${USER}: MatchGameRoomStateChangedEvent`,
    JSON.stringify({
      transactionId: uuid(),
      requestId: ++seq,
      timestamp: String(t),
      matchGameRoomStateChangedEvent: {
        gameRoomInfo: {
          gameRoomConfig: {
            reservedPlayers: [
              { userId: USER, playerName: 'TestPlayer', systemSeatId: 1, teamId: 1, eventId: EVENT },
              { userId: OPP, playerName: 'Rival', systemSeatId: 2, teamId: 2, eventId: EVENT },
            ],
            matchId: MATCH,
          },
          stateType,
          ...extra,
        },
      },
    }),
  ];
}

function gameState(t, { turn, active, stage = 'GameStage_Play', results, objects = [] }) {
  const myTurns = Math.ceil(turn / 2);
  const oppTurns = Math.floor(turn / 2);
  return gre(t, [
    {
      type: 'GREMessageType_GameStateMessage',
      systemSeatIds: [1],
      gameStateMessage: {
        type: 'GameStateType_Diff',
        gameInfo: {
          matchID: MATCH,
          gameNumber: 1,
          stage,
          matchWinCondition: 'MatchWinCondition_SingleElimination',
          superFormat: 'SuperFormat_Limited',
          ...(results ? { results } : {}),
        },
        turnInfo: turn ? { phase: 'Phase_Main1', turnNumber: turn, activePlayer: active } : undefined,
        players: [
          { systemSeatNumber: 1, teamId: 1, turnNumber: myTurns, lifeTotal: 20 },
          { systemSeatNumber: 2, teamId: 2, turnNumber: oppTurns, lifeTotal: Math.max(0, 20 - turn * 2), mulliganCount: 1 },
        ],
        gameObjects: objects,
      },
    },
  ]);
}

function oppObject(i, card) {
  return {
    instanceId: 300 + i,
    grpId: card.grpId,
    overlayGrpId: card.grpId,
    type: 'GameObjectType_Card',
    visibility: 'Visibility_Public',
    ownerSeatId: 2,
    controllerSeatId: 2,
    cardTypes: card.cardTypes,
    color: card.color,
  };
}

// Each step is a list of log lines; the e2e driver appends them one step at a time.
function buildSteps(start = Date.now()) {
  let t = start;
  const tick = (s = 5) => (t += s * 1000);
  const win = [{ scope: 'MatchScope_Game', result: 'ResultType_WinLoss', winningTeamId: 1, reason: 'ResultReason_Concede' }];

  const steps = {
    boot: [
      "Mono path[0] = 'C:/Program Files/Wizards of the Coast/MTGA/MTGA_Data/Managed'",
      'DETAILED LOGS: ENABLED',
      ...response(tick(), 'EventGetCoursesV2', { Courses: [playCourse] }),
      ...scene('None', 'Home', "Landing Page 'Home'"),
    ],
    openDraftPage: [
      ...scene('Home', 'EventLanding', EVENT_PAGE),
      ...response(tick(), 'EventGetCoursesV2', { Courses: [playCourse] }),
    ],
    joinAndDraft: [
      ...request('EventJoin', { EventName: EVENT, EntryCurrencyType: 'Gem', EntryCurrencyPaid: 1500 }),
      ...response(tick(), 'EventJoin', { Course: course('PlayerDraft') }),
      ...scene('EventLanding', 'TableDraftQueue', `Entering table draft queue: ${EVENT_PAGE}`),
      ...scene('TableDraftQueue', 'Draft', 'HumanDraft'),
      ...response(tick(600), 'DraftCompleteDraft', { ...course('DeckSelect'), DraftId: uuid() }),
      ...scene('Draft', 'DeckBuilder', 'deck builder'),
    ],
    buildDeck: [
      ...request('EventSetDeckV3', { EventName: EVENT }),
      ...response(tick(120), 'EventSetDeckV3', course('CreateMatch', { deck: true })),
      ...scene('DeckBuilder', 'EventLanding', EVENT_PAGE),
    ],
    matchStart: [
      ...gre(tick(), [{ type: 'GREMessageType_ConnectResp', systemSeatIds: [1], connectResp: { deckMessage: { deckCards: DECK, sideboardCards: SIDEBOARD } } }]),
      ...room(tick(1), 'MatchGameRoomStateType_Playing'),
      ...gameState(tick(1), { turn: 0, active: 1 }),
    ],
  };
  for (let turn = 1; turn <= 9; turn += 1) {
    const objects = turn >= 2 && turn % 2 === 0 ? [oppObject(turn, OPP_CARDS[(turn / 2 - 1) % OPP_CARDS.length])] : [];
    steps[`turn${turn}`] = gameState(tick(40), { turn, active: turn % 2 === 1 ? 1 : 2, objects });
  }
  steps.gameOver = [
    ...gameState(tick(30), { turn: 9, active: 1, stage: 'GameStage_GameOver', results: win }),
    ...room(tick(1), 'MatchGameRoomStateType_MatchCompleted', {
      finalMatchResult: { matchId: MATCH, resultList: [...win, { ...win[0], scope: 'MatchScope_Match' }] },
    }),
  ];
  steps.backToEvent = [
    ...response(tick(), 'EventGetCoursesV2', { Courses: [playCourse, course('CreateMatch', { wins: 1, deck: true })] }),
    ...scene('None', 'EventLanding', EVENT_PAGE),
  ];
  return steps;
}

module.exports = { buildSteps, EVENT, EVENT_PAGE, COURSE, MATCH };
