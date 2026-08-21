const { Player, addGarbageLines, createBoard, advancePlayer } = HexGame;

const players = { a: new Player('我', 'cyan'), b: new Player('对手', 'pink') };
players.a.dropInterval = 760;
players.b.dropInterval = 760;

let online = false;
let selfId = '';
let hostId = '';
let matchStarted = false;
let matchEnded = false;
let countdownRunning = false;
let lastStateSent = 0;
let skillSyncPauseUntil = 0;
let hiddenAt = 0;
let roomStatus = 'waiting';
let lastRoomSignature = '';
const logEl = document.querySelector('#log');
const skillNames = { jam: '干扰锁定', reverse: '反向操控', shield: '棱镜护盾', cleanse: '净化' };
const feedbackEl = document.querySelector('#action-feedback');
const presenceEl = document.querySelector('#room-presence');
const roomToastEl = document.querySelector('#room-toast');
const lobbyEl = document.querySelector('#lobby-overlay');
const appEl = document.querySelector('.app');
let feedbackTimer = 0;
let roomToastTimer = 0;
let resultTimer = 0;

function feedback(message, tone = '') {
  feedbackEl.textContent = message;
  feedbackEl.className = `action-feedback ${tone}`.trim();
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { feedbackEl.className = 'action-feedback'; }, 1200);
}

function showRoomToast(message) {
  roomToastEl.textContent = message;
  roomToastEl.classList.remove('show');
  clearTimeout(roomToastTimer);
  void roomToastEl.offsetWidth;
  roomToastEl.classList.add('show');
  roomToastTimer = setTimeout(() => roomToastEl.classList.remove('show'), 1900);
}

function updateRoomPresence(room) {
  if (!room) return;
  const players = room.players || [];
  const self = players.find(player => player.playerId === selfId);
  const opponent = players.find(player => player.playerId !== selfId);
  const readyCount = players.filter(player => player.ready).length;
  const phase = players.length < 2
    ? '等待对手'
    : room.status === 'playing' || room.status === 'countdown'
      ? (room.status === 'countdown' ? '倒计时中' : '对战进行中')
      : readyCount < 2
        ? '等待准备'
        : '等待开始';
  const detail = `${players.length}/2 人 · 准备 ${readyCount}/2${self?.ready ? ' · 我已准备' : ''}${opponent?.ready ? ' · 对手已准备' : ''}`;
  presenceEl.innerHTML = `<span class="room-phase">${phase}</span><span class="room-players">${detail}</span>`;
  const lobbyTitle = document.querySelector('#lobby-title');
  const lobbyMessage = document.querySelector('#lobby-message');
  if (lobbyTitle) lobbyTitle.textContent = phase;
  if (lobbyMessage) lobbyMessage.textContent = phase === '等待对手'
    ? '等待另一位玩家加入房间。'
    : phase === '等待准备'
      ? '双方都点击准备后，房主才能开始。'
      : phase === '等待开始'
        ? '双方已准备，请房主点击开始游戏。'
        : '比赛进行中。';
}

function setRoomView(status = 'waiting') {
  const inGame = online && status === 'playing';
  appEl.classList.toggle('game-hidden', !inGame);
  lobbyEl.hidden = inGame;
  if (!online) {
    presenceEl.innerHTML = '<span class="room-phase">房间模式</span><span class="room-players">请创建或加入房间</span>';
    lobbyEl.hidden = false;
  }
}

function log(message) {
  const item = document.createElement('p');
  item.textContent = message;
  logEl.prepend(item);
  while (logEl.children.length > 8) logEl.lastChild.remove();
}

function animateSkill(skill, actorId) {
  const isSelf = actorId === selfId || (!online && actorId === 'local-a');
  const targetKey = skill === 'jam' || skill === 'reverse' ? (isSelf ? 'b' : 'a') : (isSelf ? 'a' : 'b');
  const target = document.querySelector('#board-' + targetKey)?.closest('.player');
  if (!target) return;
  const toast = document.querySelector('#skill-toast');
  const flash = document.querySelector('#screen-flash');
  const label = skill === 'jam'
    ? (isSelf ? '干扰锁定！' : '对手锁定了你的方块')
    : skill === 'reverse'
      ? (isSelf ? '反向操控！' : '你的操作方向反了')
      : skill === 'cleanse'
        ? (isSelf ? '净化启动' : '对手使用了净化')
        : (isSelf ? '棱镜护盾启动' : '对手启动棱镜护盾');
  toast.textContent = label;
  toast.classList.remove('show');
  flash.classList.remove('show');
  target.classList.remove('skill-hit', 'skill-cast', 'skill-shield');
  void target.offsetWidth;
  void toast.offsetWidth;
  toast.classList.add('show');
  if (skill === 'jam' || skill === 'reverse') {
    target.classList.add(isSelf ? 'skill-cast' : 'skill-hit');
    flash.classList.add('show');
  } else if (skill === 'shield') {
    target.classList.add('skill-shield');
    setTimeout(() => target.classList.remove('skill-shield'), 1800);
  } else {
    target.classList.add('skill-cast');
  }
  setTimeout(() => { target.classList.remove('skill-hit', 'skill-cast'); flash.classList.remove('show'); }, 700);
}

function applyRemoteState(state) {
  if (!state) return;
  const remote = players.b;
  const updatedAt = Number(state.updatedAt) || 0;
  if (updatedAt && updatedAt === remote.lastServerStateAt) return;
  remote.lastServerStateAt = updatedAt;
  remote.board = Array.isArray(state.board) ? state.board : createBoard();
  remote.score = state.score || 0;
  remote.energy = state.energy || 0;
  remote.alive = state.alive !== false;
  remote.jammed = state.jammed === true;
  remote.reversed = state.reversed === true;
  remote.lastSnapshotAt = Date.now();
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
  if (!local.alive) finishMatch('你输了');
  paint('a');
}

function showCountdown(value) {
  const text = `比赛将在 ${value} 秒后开始`;
  document.querySelector('#snapshot').textContent = text;
  log(text);
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
  const valueEl = document.querySelector('#countdown-value');
  overlay.removeAttribute('hidden');
  overlay.classList.add('visible');
  let value = seconds;
  valueEl.textContent = value;
  valueEl.classList.remove('go');
  const timer = setInterval(() => {
    value -= 1;
    if (value > 0) valueEl.textContent = value;
    else {
      clearInterval(timer);
      valueEl.textContent = 'GO';
      valueEl.classList.add('go');
      setTimeout(() => { overlay.setAttribute('hidden', ''); overlay.classList.remove('visible'); countdownRunning = false; matchStarted = true; setRoomView('playing'); }, 650);
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
  const result = document.querySelector('#result');
  if (result) {
    result.hidden = true;
    result.classList.remove('show', 'loss');
  }
  clearTimeout(resultTimer);
  paint('a');
  paint('b');
}

function finishMatch(message) {
  if (matchEnded) return;
  matchEnded = true;
  const result = document.querySelector('#result');
  if (!result) return;
  result.querySelector('.result-title').textContent = message;
  result.classList.toggle('loss', message.includes('输'));
  result.classList.remove('show');
  result.hidden = false;
  void result.offsetWidth;
  result.classList.add('show');
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    result.hidden = true;
    result.classList.remove('show');
    matchStarted = false;
    setRoomView('finished');
  }, 2250);
}

const network = new MatchClient({
  onStatus: status => document.querySelector('#online-status').textContent = status,
  onEvent: event => {
    if (event.selfId) { selfId = event.selfId; online = true; setOnlineControls(); }
    if (event.room) {
      hostId = event.room.players[0]?.playerId || '';
      document.querySelector('#room-code').value = event.room.code;
      document.querySelector('#snapshot').textContent = `${event.room.status} · ${event.room.players.length}/2 players · seq ${event.room.seq}`;
      roomStatus = event.room.status;
      setRoomView(event.room.status);
      updateRoomPresence(event.room);
      const signature = `${event.room.status}:${event.room.players.length}:${event.room.players.map(player => `${player.playerId}:${player.ready}`).join('|')}`;
      if (lastRoomSignature && signature !== lastRoomSignature) {
        if (event.room.players.length === 2 && !lastRoomSignature.includes(':2:')) showRoomToast('对手已加入房间');
        else if (event.room.status === 'ready') showRoomToast('双方已准备，房主可以开始');
        else if (event.room.players.some(player => player.ready)) showRoomToast('准备状态已更新');
      }
      lastRoomSignature = signature;
      if (event.room.status === 'countdown') { showCountdown(event.room.countdown || 3); runCountdown(event.room.countdown || 3); }
      const startButton = document.querySelector('#start-room');
      startButton.hidden = !(selfId === hostId && event.room.status === 'ready');
      const readyButton = document.querySelector('#ready-room');
      const selfRoomPlayer = event.room.players.find(player => player.playerId === selfId);
      readyButton.textContent = selfRoomPlayer?.ready ? '已准备' : '准备';
      readyButton.disabled = ['countdown', 'playing'].includes(event.room.status) || selfRoomPlayer?.ready === true;
      if (event.room.status === 'playing') { matchStarted = true; setRoomView('playing'); }
      if (event.room.status === 'finished' && event.room.winnerId) finishMatch(event.room.winnerId === selfId ? '你赢了' : '你输了');
      const opponent = event.room.players.find(player => player.playerId !== selfId);
      const self = event.room.players.find(player => player.playerId === selfId);
      if (self && event.type === 'snapshot') applySelfState(self.state);
      if (opponent) applyRemoteState(opponent.state);
    }
    if (event.type === 'countdown') { showCountdown(event.countdown || 3); runCountdown(event.countdown || 3); }
    if (event.type === 'command' && event.payload?.type === 'skill') {
      const name = event.payload.skill === 'jam' ? '干扰锁定' : event.payload.skill === 'reverse' ? '反向操控' : event.payload.skill === 'cleanse' ? '净化' : '棱镜护盾';
      log(`${event.playerId === selfId ? '你' : '对手'} 使用了 ${name}`);
      if (event.playerId === selfId && Number.isFinite(event.effect?.energy)) {
        players.a.energy = event.effect.energy;
        paint('a');
      }
      if (event.effect?.targetId === selfId && event.effect.garbageLines > 0) {
        players.a.board = addGarbageLines(players.a.board, event.effect.garbageLines);
        paint('a');
      }
      if (event.effect?.targetId === selfId && event.effect.cleanse > 0) {
        players.a.board = cleanseBoard(players.a.board, event.effect.cleanse);
        players.a.jammed = false;
        players.a.reversed = false;
        paint('a');
      }
      if (event.effect?.targetId === selfId && event.effect?.jammed) {
        players.a.jammed = true;
        paint('a');
        log('你的当前方块被锁定，暂时无法旋转');
      }
      if (event.effect?.targetId === selfId && event.effect?.reversed) {
        players.a.reversed = true;
        paint('a');
        log('你的左右和旋转方向被反转了');
      }
      if (event.effect?.blocked) log('护盾抵挡了这次攻击');
    }
    if (event.type === 'command' && event.payload?.type === 'skill') {
      animateSkill(event.payload.skill, event.playerId);
    }
    if (event.type === 'error') { log(`技能/网络错误: ${event.code}`); feedback(`房间操作失败：${event.code}`, 'error'); }
    if (event.disconnectedId && event.disconnectedId !== selfId) { log('对手已离线'); showRoomToast('对手已离开房间'); setRoomView('waiting'); }
  }
});

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
function bindTap(selector, action) {
  const button = document.querySelector(selector);
  let lastTouch = 0;
  button.onclick = event => {
    if (Date.now() - lastTouch < 500) return;
    event.preventDefault();
    action();
  };
  button.ontouchend = event => {
    event.preventDefault();
    lastTouch = Date.now();
    action();
  };
}
bindTap('#create-room', () => { feedback('正在创建房间...', 'success'); network.connect(wsUrl); network.create(); });
bindTap('#join-room', () => {
  const code = document.querySelector('#room-code').value.trim();
  if (!code) { feedback('请先输入邀请码', 'warn'); return; }
  feedback('正在加入房间...', 'success'); network.connect(wsUrl); network.join(code);
});
bindTap('#ready-room', () => { feedback('已发送准备状态', 'success'); network.ready(); });
bindTap('#start-room', () => { feedback('正在开始比赛...', 'success'); network.start(); });

function resumeAfterHidden() {
  if (!hiddenAt || !online || roomStatus !== 'playing' || matchEnded) return;
  const elapsed = Date.now() - hiddenAt;
  hiddenAt = 0;
  advancePlayer(players.a, elapsed);
  paint('a');
  network.state(stateOf(players.a));
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  resumeAfterHidden();
});
window.addEventListener('focus', resumeAfterHidden);

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
    const cost = 10;
    button.disabled = (online && (key === 'b' || !matchStarted || matchEnded)) || !player.alive;
    button.classList.toggle('insufficient', player.energy < cost);
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
  if (online && roomStatus !== 'playing') { document.querySelector('#snapshot').textContent = '等待比赛开始'; feedback('比赛还没有开始', 'warn'); return; }
  if (online && matchEnded) return;
  const player = players[key];
  if (!player.alive) return;
  const reverse = player.reversed === true;
  if (action === 'left') player.move(reverse ? 1 : -1);
  if (action === 'right') player.move(reverse ? -1 : 1);
  if (action === 'rotate' && !player.jammed) reverse ? player.rotateReverse() : player.rotate();
  if (action === 'drop') player.softDrop();
  if (action === 'hard') player.hardDrop();
  if (online) network.command(commandFor(action));
  paint(key);
}

document.querySelectorAll('.controls button').forEach(button => {
  let lastTouch = 0;
  const trigger = event => {
    event?.preventDefault();
    act(button.parentElement.dataset.player, button.dataset.action);
  };
  button.onclick = trigger;
  button.ontouchend = event => {
    lastTouch = Date.now();
    trigger(event);
  };
  button.onclick = event => {
    if (Date.now() - lastTouch < 500) return;
    trigger(event);
  };
});

function useSkill(button) {
    const key = button.dataset.player;
    if (online && key !== 'a') return;
    if (online && (roomStatus !== 'playing' || matchEnded)) return;
    const player = players[key];
    const cost = 10;
    if (player.energy < cost) {
      button.classList.remove('action-denied'); void button.offsetWidth; button.classList.add('action-denied');
      log('能量不足，需要 10 点');
      feedback(`能量不足：${player.energy} / ${cost}`, 'error');
      return;
    }
    button.classList.remove('action-success'); void button.offsetWidth; button.classList.add('action-success');
    player.energy -= cost;
    let localBlocked = false;
    if (!online) {
      const opponent = key === 'a' ? players.b : players.a;
      const attack = button.dataset.skill === 'jam' || button.dataset.skill === 'reverse';
      if (attack && opponent.shield) {
        opponent.shield = false;
        localBlocked = true;
        log('护盾抵挡了这次攻击');
      } else {
        if (button.dataset.skill === 'jam') opponent.jammed = true;
        if (button.dataset.skill === 'reverse') opponent.reversed = true;
      }
    }
    if (button.dataset.skill === 'shield') player.shield = true;
    if (button.dataset.skill === 'cleanse') {
      player.board = cleanseBoard(player.board, 2);
      player.jammed = false;
      player.reversed = false;
    }
    if (online) {
      network.command({ type: 'skill', skill: button.dataset.skill });
      skillSyncPauseUntil = performance.now() + 500;
    }
    if (!online && !localBlocked) animateSkill(button.dataset.skill, `local-${key}`);
    log(`已释放 ${skillNames[button.dataset.skill]}，消耗 ${cost} 能量`);
    feedback(`已释放 ${skillNames[button.dataset.skill]}，剩余 ${player.energy} 能量`, 'success');
    paint('a'); paint('b');
}

let lastSkillPointer = 0;
document.addEventListener('pointerup', event => {
  const button = event.target.closest?.('.skill');
  if (!button) return;
  event.preventDefault();
  lastSkillPointer = Date.now();
  useSkill(button);
}, { passive: false });
document.addEventListener('click', event => {
  const button = event.target.closest?.('.skill');
  if (!button) return;
  if (Date.now() - lastSkillPointer < 600) return;
  event.preventDefault();
  useSkill(button);
});

document.addEventListener('pointerdown', event => {
  const button = event.target.closest?.('button');
  if (!button) return;
  button.classList.add('is-pressed');
}, { passive: true });
document.addEventListener('pointerup', event => {
  const button = event.target.closest?.('button');
  if (button) button.classList.remove('is-pressed');
}, { passive: true });
document.addEventListener('pointercancel', event => {
  const button = event.target.closest?.('button');
  if (button) button.classList.remove('is-pressed');
}, { passive: true });

function bindTapSkill(button, action) {
  let lastTouch = 0;
  button.onclick = event => { if (Date.now() - lastTouch < 500) return; event.preventDefault(); action(); };
  button.ontouchend = event => { event.preventDefault(); lastTouch = Date.now(); action(); };
}

function cleanseBoard(board, count) {
  const rows = board.map(row => row.slice());
  let removed = 0;
  for (let index = rows.length - 1; index >= 0 && removed < count; index -= 1) {
    if (rows[index].some(cell => cell === 8)) { rows.splice(index, 1); rows.unshift(Array(10).fill(0)); removed += 1; }
  }
  return rows;
}

function stateOf(player) {
  return {
    score: player.score, energy: player.energy, alive: player.alive, jammed: player.jammed === true, reversed: player.reversed === true, board: player.board,
    current: { cells: player.current.cells, x: player.x, y: player.y, color: player.current.color }
  };
}

let lastFrame = performance.now();
function loop(now) {
  const delta = now - lastFrame;
  lastFrame = now;
  const activeKeys = online && matchStarted ? ['a'] : [];
  activeKeys.forEach(key => {
    if (online && !matchStarted) return;
    const player = players[key];
    if (!player.alive) return;
    if (advancePlayer(player, delta, 2) > 0) paint(key);
  });
  if (online && matchStarted && players.b.alive && Date.now() - (players.b.lastSnapshotAt || 0) > 350) {
    if (advancePlayer(players.b, delta, 2) > 0) paint('b');
  }
  if (online && matchStarted && !matchEnded && !players.a.alive) finishMatch('你输了');
  if (online && matchStarted && now >= skillSyncPauseUntil && now - lastStateSent >= 100) {
    lastStateSent = now;
    network.state(stateOf(players.a));
  }
  requestAnimationFrame(loop);
}

paint('a'); paint('b'); setOnlineControls(); setRoomView('waiting'); log('请创建或加入房间'); requestAnimationFrame(loop);
