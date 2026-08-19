const { Player, addGarbageLines, createBoard } = HexGame;

const players = { a: new Player('我', 'cyan'), b: new Player('对手', 'pink') };
players.a.dropInterval = 760;
players.b.dropInterval = 760;

let online = false;
let selfId = '';
let hostId = '';
let matchStarted = false;
let matchEnded = false;
let remoteDropClock = 0;
let countdownRunning = false;
let lastStateSent = 0;
const logEl = document.querySelector('#log');

function log(message) {
  const item = document.createElement('p');
  item.textContent = message;
  logEl.prepend(item);
  while (logEl.children.length > 8) logEl.lastChild.remove();
}

function applyRemoteState(state) {
  if (!state) return;
  const remote = players.b;
  remote.board = Array.isArray(state.board) ? state.board : createBoard();
  remote.score = state.score || 0;
  remote.energy = state.energy || 0;
  remote.alive = state.alive !== false;
  if (state.current) {
    remote.current = { name: 'remote', cells: state.current.cells, color: state.current.color };
    remote.x = state.current.x;
    remote.y = state.current.y;
  }
  paint('b');
  if (!remote.alive) finishMatch('你赢了');
}

function applySelfState(state) {
  if (!state) return;
  const local = players.a;
  // Keep local movement prediction stable. Only import server-owned outcomes;
  // replacing the active piece on every snapshot causes visible rubber-banding.
  if (Number.isFinite(state.energy) && state.energy > local.energy) local.energy = state.energy;
  local.alive = state.alive !== false;
  if (Array.isArray(state.board) && state.board.length === local.board.length) {
    const serverGarbage = state.board.flat().filter(cell => cell === 8).length;
    const localGarbage = local.board.flat().filter(cell => cell === 8).length;
    if (serverGarbage > localGarbage) local.board = state.board;
  }
  if (!local.alive) finishMatch('你输了');
  paint('a');
}

function setOnlineControls() {
  document.querySelectorAll('[data-player="b"] button, .skill[data-player="b"]').forEach(button => {
    button.disabled = online;
  });
  document.querySelector('#status').textContent = online ? '左侧为自己，右侧为对手' : '本地练习';
}

function runCountdown(seconds = 3) {
  if (countdownRunning) return;
  countdownRunning = true;
  resetMatch();
  const overlay = document.querySelector('#countdown');
  overlay.removeAttribute('hidden');
  overlay.style.setProperty('display', 'grid', 'important');
  overlay.style.setProperty('visibility', 'visible', 'important');
  let value = seconds;
  overlay.textContent = value;
  const timer = setInterval(() => {
    value -= 1;
    if (value > 0) overlay.textContent = value;
    else {
      clearInterval(timer);
      overlay.textContent = 'GO';
      setTimeout(() => { overlay.setAttribute('hidden', ''); overlay.style.setProperty('display', 'none', 'important'); countdownRunning = false; matchStarted = true; }, 450);
    }
  }, 1000);
}

function resetMatch() {
  players.a = new Player('我', 'cyan');
  players.b = new Player('对手', 'pink');
  players.a.dropInterval = 760;
  players.b.dropInterval = 760;
  matchEnded = false;
  matchStarted = false;
  remoteDropClock = 0;
  const result = document.querySelector('#result');
  result.hidden = true;
  result.style.display = 'none';
  paint('a');
  paint('b');
}

function finishMatch(message) {
  if (matchEnded) return;
  matchEnded = true;
  const result = document.querySelector('#result');
  result.textContent = message;
  result.hidden = false;
  result.style.display = 'grid';
}

const network = new MatchClient({
  onStatus: status => document.querySelector('#online-status').textContent = status,
  onEvent: event => {
    if (event.selfId) { selfId = event.selfId; online = true; setOnlineControls(); }
    if (event.room) {
      hostId = event.room.players[0]?.playerId || '';
      document.querySelector('#room-code').value = event.room.code;
      document.querySelector('#snapshot').textContent = `${event.room.status} · ${event.room.players.length}/2 players · seq ${event.room.seq}`;
      if (event.room.status === 'countdown') runCountdown(event.room.countdown || 3);
      const startButton = document.querySelector('#start-room');
      startButton.hidden = !(selfId === hostId && event.room.status === 'ready');
      if (event.room.status === 'playing') matchStarted = true;
      const opponent = event.room.players.find(player => player.playerId !== selfId);
      const self = event.room.players.find(player => player.playerId === selfId);
      if (self && event.type === 'snapshot') applySelfState(self.state);
      if (opponent) applyRemoteState(opponent.state);
    }
    if (event.type === 'countdown') runCountdown(event.countdown || 3);
    if (event.type === 'command' && event.payload?.type === 'skill') {
      const name = event.payload.skill === 'strike' ? '电弧轰击' : '棱镜护盾';
      log(`${event.playerId === selfId ? '你' : '对手'} 使用了 ${name}`);
    }
    if (event.type === 'error') log(`network error: ${event.code}`);
  }
});

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
document.querySelector('#create-room').onclick = () => { network.connect(wsUrl); network.create(); };
document.querySelector('#join-room').onclick = () => { network.connect(wsUrl); network.join(document.querySelector('#room-code').value); };
document.querySelector('#ready-room').onclick = () => network.ready();
document.querySelector('#start-room').onclick = () => network.start();

function paint(key) {
  const player = players[key];
  const cells = player.board.map(row => row.slice());
  if (player.current?.cells) {
    player.current.cells.forEach((row, dy) => row.forEach((value, dx) => {
      const y = player.y + dy;
      const x = player.x + dx;
      if (value && y >= 0 && cells[y] && x >= 0 && x < cells[y].length) cells[y][x] = player.current.color;
    }));
  }
  document.querySelector('#board-' + key).innerHTML = cells.flat().map(value => `<div class="cell ${value ? 'filled ' + (value === 8 ? 'garbage' : value) : ''}"></div>`).join('');
  document.querySelector('#score-' + key).textContent = `${player.score} pts`;
  document.querySelector('#energy-' + key).textContent = `${player.energy} / 100`;
  document.querySelector('#fill-' + key).style.width = `${player.energy}%`;
  document.querySelectorAll(`.skill[data-player="${key}"]`).forEach(button => {
    const cost = button.dataset.skill === 'strike' ? 20 : 10;
    button.disabled = (online && key === 'b') || player.energy < cost || !player.alive;
  });
}

function commandFor(action) {
  return {
    type: action === 'left' || action === 'right' ? 'move' : action === 'rotate' ? 'rotate' : action === 'drop' ? 'softDrop' : 'hardDrop',
    direction: action === 'left' ? -1 : action === 'right' ? 1 : undefined
  };
}

function act(key, action) {
  if (online && key !== 'a') return;
  if (online && !matchStarted) return;
  const player = players[key];
  if (!player.alive) return;
  if (action === 'left') player.move(-1);
  if (action === 'right') player.move(1);
  if (action === 'rotate') player.rotate();
  if (action === 'drop') player.softDrop();
  if (action === 'hard') player.hardDrop();
  if (online) network.command(commandFor(action));
  paint(key);
}

document.querySelectorAll('.controls button').forEach(button => {
  button.onclick = () => act(button.parentElement.dataset.player, button.dataset.action);
});

document.querySelectorAll('.skill').forEach(button => {
  button.onclick = () => {
    const key = button.dataset.player;
    if (online && key !== 'a') return;
    const player = players[key];
    const cost = button.dataset.skill === 'strike' ? 20 : 10;
    if (player.energy < cost) return;
    player.energy -= cost;
    if (button.dataset.skill === 'strike') {
      const target = key === 'a' ? players.b : players.a;
      target.board = addGarbageLines(target.board, 2);
    } else player.shield = true;
    if (online) network.command({ type: 'skill', skill: button.dataset.skill });
    paint('a'); paint('b');
  };
});

function stateOf(player) {
  return {
    score: player.score, energy: player.energy, alive: player.alive, board: player.board,
    current: { cells: player.current.cells, x: player.x, y: player.y, color: player.current.color }
  };
}

let lastFrame = performance.now();
function loop(now) {
  const delta = now - lastFrame;
  lastFrame = now;
  const activeKeys = online ? ['a'] : ['a', 'b'];
  activeKeys.forEach(key => {
    if (online && !matchStarted) return;
    const player = players[key];
    if (!player.alive) return;
    player.lastDrop += delta;
    if (player.lastDrop >= player.dropInterval) {
      player.lastDrop = 0;
      if (!player.softDrop()) player.lock();
      paint(key);
    }
  });
  if (online && matchStarted && !matchEnded) {
    remoteDropClock += delta;
    if (remoteDropClock >= players.b.dropInterval) {
      remoteDropClock = 0;
      if (players.b.alive && !players.b.softDrop()) players.b.lock();
      paint('b');
    }
    if (!players.a.alive) finishMatch('你输了');
  }
  if (online && matchStarted && now - lastStateSent >= 100) {
    lastStateSent = now;
    network.state(stateOf(players.a));
  }
  requestAnimationFrame(loop);
}

paint('a'); paint('b'); setOnlineControls(); log('本地练习已开始'); requestAnimationFrame(loop);
