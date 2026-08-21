const { Player, addGarbageLines, createBoard, advancePlayer } = HexGame;
const skillCatalog = {
  jam: ['锁定', '禁止旋转 · 10'], reverse: ['反向操控', '左右旋转反向 · 10'], swapShape: ['形态交换', '交换双方当前形状 · 25'], slam: ['坠落', '强制对方硬降 · 35'],
  zone: ['禁区', '封锁边侧一列15秒 · 20'], intercept: ['截胡', '当前块换成下一块 · 25'], offset: ['错位', '左右偏移两格 · 25'], mirrorBoard: ['镜像棋盘', '左右翻转棋盘 · 50'], gravity: ['重力加速', '当前块三倍下落 · 25'], cardSwap: ['卡牌交换', '随机交换一张牌 · 30'],
  reshape: ['重构', '整理底部四行 · 25'], store: ['储存', '暂存当前方块 · 15'], predict: ['预测', '显示后续方块 · 15'], reflect: ['反弹', '反弹下一次攻击 · 25'], clearTop: ['天降清除', '消除最上面一行 · 40'], copyBoard: ['复制底板', '记录当前棋盘 · 35'],
  drain: ['偷能', '吸取对方10能量 · 15'], reroll: ['换形', '重随机当前方块 · 15'], copy: ['复制', '复制对方最近技能 · 20'], gambler: ['赌徒', '随机品质新技能 · 10'], frenzy: ['狂热', '6秒清行额外能量 · 20'], unlockHardDrop: ['解锁硬降', '本局解锁硬降 · 80']
};
const skillCosts = { cleanse: 30, jam: 10, reverse: 10, swapShape: 25, slam: 35, zone: 20, intercept: 25, offset: 25, mirrorBoard: 50, gravity: 25, cardSwap: 30, reshape: 25, store: 15, predict: 15, reflect: 25, clearTop: 40, copyBoard: 35, drain: 15, reroll: 15, copy: 20, gambler: 10, frenzy: 20, unlockHardDrop: 80 };
const attackSkills = new Set(['jam', 'reverse', 'swapShape', 'slam', 'zone', 'intercept', 'offset', 'mirrorBoard', 'gravity', 'drain']);
function baseSkill(card) { return String(card || '').split('@')[0]; }
function cardCost(card) { const [skill, modifier] = String(card || '').split('@'); const cost = skillCosts[skill] || 0; return modifier === 'discount' ? Math.max(5, cost - 5) : modifier === 'overload' ? cost + 10 : cost; }
function cardLabel(card) { const modifier = String(card || '').split('@')[1]; return modifier === 'discount' ? '折扣' : modifier === 'overload' ? '过载' : modifier === 'weak' ? '残缺' : modifier === 'gold' ? '金色' : ''; }

const players = { a: new Player('我', 'cyan'), b: new Player('对手', 'pink') };
players.a.dropInterval = 760;
players.b.dropInterval = 760;
players.a.skills = [];
players.b.skills = [];

let online = false;
let selfId = '';
let hostId = '';
let matchStarted = false;
let matchEnded = false;
let opponentLossReported = false;
let countdownRunning = false;
let lastStateSent = 0;
let skillSyncPauseUntil = 0;
let hiddenAt = 0;
let roomStatus = 'waiting';
let lastAckSeq = 0;
let lastRoomSignature = '';
const logEl = document.querySelector('#log');
const feedbackEl = document.querySelector('#action-feedback');
const presenceEl = document.querySelector('#room-presence');
const roomToastEl = document.querySelector('#room-toast');
const lobbyEl = document.querySelector('#lobby-overlay');
const appEl = document.querySelector('.app');
let feedbackTimer = 0;
let roomToastTimer = 0;
let resultTimer = 0;

function renderSkillHand(key) {
  const slots = document.querySelector(`#skill-slots-${key}`);
  if (!slots) return;
  slots.innerHTML = '';
  const hand = players[key].skills || [];
  const visibleCards = key === 'b' && online ? hand.map(() => null) : hand.slice();
  if (key === 'a' && players[key].copyExpiresAt > Date.now()) visibleCards.push('copyRestore');
  visibleCards.slice(0, 3).forEach(skill => {
    const button = document.createElement('button');
    if (!skill) {
      button.className = 'skill-card-back';
      button.disabled = true;
      button.innerHTML = '未知<small>对手手牌</small>';
    } else {
      const actualSkill = skill === 'copyRestore' ? 'copyBoard' : baseSkill(skill);
      button.className = 'skill'; button.dataset.player = key; button.dataset.skill = actualSkill; button.dataset.card = skill;
      const modifier = String(skill).split('@')[1];
      if (modifier) button.classList.add(`quality-${modifier}`);
      if (skill === 'copyRestore') {
        button.dataset.restore = 'true';
        button.innerHTML = '回到底板<small>5秒内免费</small>';
      } else {
        const definition = skillCatalog[actualSkill] || [actualSkill, '随机技能'];
        const label = cardLabel(skill);
        button.innerHTML = `${definition[0]}${label ? ` · ${label}` : ''}<small>${definition[1].replace(/·\s*\d+$/, `· ${cardCost(skill)}`)}</small>`;
      }
    }
    slots.appendChild(button);
  });
  for (let index = visibleCards.length; index < 3; index += 1) {
    const empty = document.createElement('button');
    empty.className = 'skill-slot-empty'; empty.disabled = true; empty.textContent = '空卡槽';
    slots.appendChild(empty);
  }
}

function renderAllSkillHands() { renderSkillHand('a'); renderSkillHand('b'); }

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

function animateSkill(skill, actorId, effect = null) {
  const isSelf = actorId === selfId || (!online && actorId === 'local-a');
  const attack = attackSkills.has(skill);
  const targetKey = online && effect?.targetId
    ? (effect.targetId === selfId ? 'a' : 'b')
    : attack ? (isSelf ? 'b' : 'a') : (isSelf ? 'a' : 'b');
  const target = document.querySelector('#board-' + targetKey)?.closest('.player');
  if (!target) return;
  const toast = document.querySelector('#skill-toast');
  const flash = document.querySelector('#screen-flash');
  const label = skill === 'draw' ? (isSelf ? '抽到新技能' : '对手抽取了技能') : `${isSelf ? '发动' : '对手使用'} ${skillCatalog[skill]?.[0] || '技能'}`;
  toast.textContent = label;
  toast.classList.remove('show');
  flash.classList.remove('show');
  target.classList.remove('skill-hit', 'skill-cast', 'skill-shield');
  void target.offsetWidth;
  void toast.offsetWidth;
  toast.classList.add('show');
  if (attack) {
    target.classList.add(effect?.reflected || !isSelf ? 'skill-hit' : 'skill-cast');
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
  const remoteSignature = JSON.stringify({ board: state.board || null, current: state.current || null, alive: state.alive !== false });
  const pieceChanged = remoteSignature !== remote.lastRemoteSignature;
  remote.lastServerStateAt = updatedAt;
  remote.lastRemoteSignature = remoteSignature;
  remote.board = Array.isArray(state.board) ? state.board : createBoard();
  remote.score = state.score || 0;
  remote.energy = state.energy || 0;
  remote.alive = state.alive !== false;
  remote.jammed = state.jammed === true;
  remote.reversed = state.reversed === true;
  remote.reflect = state.reflect === true;
  remote.blockedColumn = Number.isInteger(state.blockedColumn) ? state.blockedColumn : null;
  remote.blockedUntil = state.blockedRemainingMs > 0 ? Date.now() + state.blockedRemainingMs : 0;
  remote.gravity = state.gravity === true;
  remote.hardDropUnlocked = state.hardDropUnlocked === true;
  remote.frenzyUntil = state.frenzyRemainingMs > 0 ? Date.now() + state.frenzyRemainingMs : 0;
  remote.skills = Array.isArray(state.skills) ? state.skills.slice() : remote.skills;
  if (pieceChanged) remote.lastSnapshotAt = Date.now();
  if (state.current && pieceChanged) {
    remote.current = { name: 'remote', cells: state.current.cells, color: state.current.color };
    remote.x = state.current.x;
    remote.y = state.current.y;
  }
  paint('b');
  renderSkillHand('b');
  if (!remote.alive) finishMatch('你赢了');
}

function applySelfState(state) {
  if (!state) return;
  const local = players.a;
  // Keep local movement prediction stable. Only import server-owned outcomes;
  // replacing the active piece on every snapshot causes visible rubber-banding.
  if (Number.isFinite(state.energy) && state.energy > local.energy) local.energy = state.energy;
  local.alive = state.alive !== false;
  local.reflect = state.reflect === true;
  local.blockedColumn = Number.isInteger(state.blockedColumn) ? state.blockedColumn : null;
  local.blockedUntil = state.blockedRemainingMs > 0 ? Date.now() + state.blockedRemainingMs : 0;
  local.gravity = state.gravity === true;
  local.hardDropUnlocked = state.hardDropUnlocked === true;
  local.frenzyUntil = state.frenzyRemainingMs > 0 ? Date.now() + state.frenzyRemainingMs : local.frenzyUntil || 0;
  local.copyExpiresAt = state.copyRemainingMs > 0 ? Date.now() + state.copyRemainingMs : 0;
  local.predictUntil = state.predictRemainingMs > 0 ? Date.now() + state.predictRemainingMs : local.predictUntil || 0;
  if (Array.isArray(state.skills)) { local.skills = state.skills.slice(); renderSkillHand('a'); }
  if (!local.alive) finishMatch('你输了');
  paint('a');
}

function applyCurrentSnapshot(player, current) {
  if (!current || !Array.isArray(current.cells)) return;
  player.current = { name: current.name || 'skill', cells: current.cells.map(row => row.slice()), color: current.color || player.color };
  if (Number.isFinite(current.x)) player.x = current.x;
  if (Number.isFinite(current.y)) player.y = current.y;
}

function renderPrediction(key) {
  const player = players[key];
  const element = document.querySelector(`#prediction-${key}`);
  if (!element) return;
  const active = player.predictUntil > Date.now();
  element.classList.toggle('show', active);
  element.textContent = active ? `下: ${(player.nextQueue || []).map(piece => piece.name).join(' · ')}` : '';
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
  players.a.skills = [];
  players.b.skills = [];
  matchEnded = false;
  opponentLossReported = false;
  matchStarted = false;
  const result = document.querySelector('#result');
  if (result) {
    result.hidden = true;
    result.classList.remove('show', 'loss');
  }
  clearTimeout(resultTimer);
  paint('a');
  paint('b');
  renderAllSkillHands();
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
      lastAckSeq = Math.max(lastAckSeq, Number(event.room.seq) || 0);
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
    if (event.type === 'command' && (event.payload?.type === 'skill' || event.payload?.type === 'drawSkill')) {
      const skill = event.payload.skill || event.effect?.skill;
      const name = event.payload?.type === 'drawSkill' ? '抽取技能' : (skillCatalog[skill]?.[0] || (skill === 'cleanse' ? '净化' : '新技能'));
      log(`${event.playerId === selfId ? '你' : '对手'} 使用了 ${name}`);
      if (Number.isFinite(event.effect?.energy)) players.a.energy = event.effect.energy;
      if (Array.isArray(event.effect?.hand)) players.a.skills = event.effect.hand.slice();
      if (Number.isFinite(event.effect?.energy) || Array.isArray(event.effect?.hand)) {
        paint('a');
        renderSkillHand('a');
      }
      if (event.payload?.type === 'drawSkill') {
        animateSkill('draw', event.playerId, event.effect);
      }
      if (event.effect?.targetId === selfId && event.effect.garbageLines > 0) {
        players.a.board = addGarbageLines(players.a.board, event.effect.garbageLines);
        paint('a');
      }
      if (event.effect?.targetId === selfId && event.effect.cleanse > 0) {
        players.a.board = cleanseBoard(players.a.board, event.effect.cleanse);
        players.a.jammed = false;
        players.a.reversed = false;
        players.a.blockedColumn = null;
        players.a.blockedUntil = 0;
        players.a.gravity = false;
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
      if (event.effect?.targetId === selfId && Number.isInteger(event.effect?.blockedColumn)) {
        players.a.blockedColumn = event.effect.blockedColumn;
        players.a.blockedUntil = Date.now() + (event.effect.blockedDurationMs || 15000);
        feedback(`边侧第 ${event.effect.blockedColumn + 1} 列被封锁15秒`, 'warn');
      }
      if (event.effect?.targetId === selfId && event.effect?.intercept) {
        players.a.spawn();
        feedback('当前方块被截胡', 'warn');
        network.state(stateOf(players.a));
      }
      if (event.effect?.targetId === selfId && Number.isFinite(event.effect?.offset)) {
        const step = Math.sign(event.effect.offset);
        for (let index = 0; index < Math.abs(event.effect.offset); index += 1) players.a.move(step);
        feedback(`当前方块被错位 ${Math.abs(event.effect.offset)} 格`, 'warn');
        network.state(stateOf(players.a));
      }
      if (event.effect?.targetId === selfId && event.effect?.gravity) {
        players.a.gravity = true;
        feedback('重力加速已生效', 'warn');
      }
      if (event.effect?.targetId === selfId && event.effect?.forceDrop) {
        players.a.hardDrop();
        paint('a');
        network.state(stateOf(players.a));
      }
      if (event.effect?.targetId === selfId && event.effect?.store) {
        players.a.held = players.a.current;
        players.a.spawn();
        paint('a');
      }
      if (event.effect?.targetId === selfId && event.effect?.predictDurationMs) {
        players.a.predictUntil = Date.now() + event.effect.predictDurationMs;
        renderPrediction('a');
        feedback('预测已开启：后续三块可见', 'success');
      }
      if (event.effect?.targetId === selfId && event.effect?.reflect) {
        players.a.reflect = true;
        feedback('反弹已就绪：下一次攻击会弹回', 'success');
      }
      if (event.effect?.targetId === selfId && Array.isArray(event.effect?.board)) {
        players.a.board = event.effect.board.map(row => row.slice());
        paint('a');
        network.state(stateOf(players.a));
      }
      if (event.effect?.targetId === selfId && event.effect?.reroll && event.effect?.current) {
        applyCurrentSnapshot(players.a, event.effect.current);
        paint('a');
        network.state(stateOf(players.a));
      }
      if (event.playerId === selfId && event.effect?.hardDropUnlocked) {
        players.a.hardDropUnlocked = true;
        feedback('硬降已永久解锁（本局）', 'success');
      }
      if (event.playerId === selfId && event.effect?.frenzyDurationMs) {
        players.a.frenzyUntil = Date.now() + event.effect.frenzyDurationMs;
        feedback('狂热开启：清行额外获得能量', 'success');
      }
      if (event.effect?.drained > 0) feedback(event.playerId === selfId ? `吸取 ${event.effect.drained} 点能量` : `被吸取 ${event.effect.drained} 点能量`, event.playerId === selfId ? 'success' : 'warn');
      if (event.effect?.copiedSkill) feedback(`复制并发动：${skillCatalog[event.effect.copiedSkill]?.[0] || event.effect.copiedSkill}`, 'success');
      if (event.effect?.gambler && Array.isArray(event.effect.hand)) feedback('赌徒生成了一张品质卡', 'success');
      if (event.playerId === selfId && event.effect?.copyArmed) {
        players.a.copyExpiresAt = Date.now() + (event.effect.copyDurationMs || 5000);
        renderSkillHand('a');
        feedback('底板已记录，5秒内可恢复', 'success');
      }
      if (event.effect?.targetId === selfId && event.effect?.restoreCopy) {
        players.a.copyExpiresAt = 0;
        if (Array.isArray(event.effect.board)) players.a.board = event.effect.board.map(row => row.slice());
        applyCurrentSnapshot(players.a, event.effect.current);
        renderSkillHand('a');
        paint('a');
      }
      if (event.effect?.swapShape && event.effect.players) {
        const selfPiece = event.effect.players[selfId]?.current;
        const opponentId = Object.keys(event.effect.players).find(id => id !== selfId);
        applyCurrentSnapshot(players.a, selfPiece);
        applyCurrentSnapshot(players.b, event.effect.players[opponentId]?.current);
        paint('a'); paint('b');
      }
      if (event.effect?.reflected) log('攻击被反弹回施法者');
      else if (event.effect?.blocked) log('防御技能抵挡了这次攻击');
    }
    if (event.type === 'command' && event.payload?.type === 'skill') {
      animateSkill(event.effect?.executedSkill || event.payload.skill, event.playerId, event.effect);
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
  document.querySelector('#board-' + key).innerHTML = cells.flat().map((value, index) => `<div class="cell ${value ? 'filled ' + (value === 8 ? 'garbage' : value) : ''}${index % 10 === player.blockedColumn ? ' forbidden' : ''}"></div>`).join('');
  document.querySelector('#score-' + key).textContent = `${player.score} pts`;
  document.querySelector('#energy-' + key).textContent = `${player.energy} / 100`;
  document.querySelector('#fill-' + key).style.width = `${player.energy}%`;
  document.querySelectorAll(`.skill[data-player="${key}"]`).forEach(button => {
    const cost = button.dataset.restore === 'true' ? 0 : cardCost(button.dataset.card || button.dataset.skill);
    const alreadyUnlocked = button.dataset.skill === 'unlockHardDrop' && player.hardDropUnlocked;
    button.disabled = (online && (key === 'b' || !matchStarted || matchEnded)) || !player.alive || alreadyUnlocked;
    button.classList.toggle('insufficient', player.energy < cost);
  });
  const hardButton = document.querySelector(`.controls[data-player="${key}"] [data-action="hard"]`);
  if (hardButton) {
    hardButton.textContent = player.hardDropUnlocked ? '硬降' : '硬降锁定';
    hardButton.disabled = (online && (key === 'b' || !matchStarted || matchEnded)) || !player.alive;
    hardButton.classList.toggle('locked', !player.hardDropUnlocked);
  }
  const draw = document.querySelector(`.draw-skill[data-player="${key}"]`);
  if (draw) {
    const occupied = (player.skills || []).length + (player.copyExpiresAt > Date.now() ? 1 : 0);
    draw.disabled = (online && (key === 'b' || !matchStarted || matchEnded)) || !player.alive || player.energy < 10 || occupied >= 3;
    draw.classList.toggle('insufficient', player.energy < 10 || occupied >= 3);
  }
  renderPrediction(key);
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
  if (action === 'hard' && !player.hardDropUnlocked) { feedback('需要 80 能量解锁硬降', 'warn'); return; }
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

function drawSkill(key = 'a') {
  if (online && key !== 'a') return;
  if (online && (roomStatus !== 'playing' || matchEnded)) return;
  const player = players[key];
  const occupied = (player.skills || []).length + (player.copyExpiresAt > Date.now() ? 1 : 0);
  if (occupied >= 3) { feedback('技能卡槽已满', 'warn'); return; }
  if (player.energy < 10) { feedback(`能量不足：${player.energy} / 10`, 'error'); return; }
  if (online) {
    network.state(stateOf(player));
    network.command({ type: 'drawSkill' });
    skillSyncPauseUntil = performance.now() + 500;
    return;
  }
  const keys = Object.keys(skillCatalog);
  player.energy -= 10;
  player.skills = [...(player.skills || []), keys[Math.floor(Math.random() * keys.length)]];
  renderSkillHand(key); paint(key); animateSkill('draw', `local-${key}`);
}

function useSkill(button) {
  const key = button.dataset.player;
  if (online && key !== 'a') return;
  if (online && (roomStatus !== 'playing' || matchEnded)) return;
  const player = players[key];
  const skill = button.dataset.skill;
  const card = button.dataset.card || skill;
  const restoringCopy = skill === 'copyBoard' && button.dataset.restore === 'true' && player.copyExpiresAt > Date.now();
  const cost = restoringCopy ? 0 : cardCost(card);
  const fixedSkill = skill === 'cleanse' || skill === 'unlockHardDrop';
  if (!fixedSkill && !restoringCopy && !(player.skills || []).includes(card)) return;
  if (skill === 'unlockHardDrop' && player.hardDropUnlocked) { feedback('本局已经解锁硬降', 'warn'); return; }
  if (player.energy < cost) { feedback(`能量不足：${player.energy} / ${cost}`, 'error'); return; }
  button.classList.remove('action-success'); void button.offsetWidth; button.classList.add('action-success');
  if (online) {
    network.state(stateOf(player));
    network.command({ type: 'skill', skill, card });
    skillSyncPauseUntil = performance.now() + 500;
    return;
  }
  player.energy -= cost;
  if (!fixedSkill && !restoringCopy) {
    const index = player.skills.indexOf(card);
    if (index >= 0) player.skills.splice(index, 1);
  }
  if (skill === 'cleanse') { player.jammed = false; player.reversed = false; player.blockedColumn = null; player.blockedUntil = 0; player.gravity = false; }
  if (skill === 'unlockHardDrop') player.hardDropUnlocked = true;
  if (skill === 'reflect') player.reflect = true;
  if (skill === 'store') { player.held = player.current; player.spawn(); }
  if (skill === 'predict') { player.predictUntil = Date.now() + 8000; renderPrediction(key); }
  if (skill === 'clearTop') player.board = clearHighestOccupiedRow(player.board);
  if (skill === 'reshape') player.board = reshapeBottom(player.board);
  if (skill === 'copyBoard' && restoringCopy) {
    player.board = player.copyBoard.board.map(row => row.slice());
    applyCurrentSnapshot(player, player.copyBoard.current);
    player.copyBoard = null; player.copyExpiresAt = 0;
  } else if (skill === 'copyBoard') {
    player.copyBoard = { board: player.board.map(row => row.slice()), current: { cells: player.current.cells.map(row => row.slice()), x: player.x, y: player.y, color: player.current.color } };
    player.copyExpiresAt = Date.now() + 5000;
  }
  renderSkillHand(key); paint(key); animateSkill(skill, `local-${key}`);
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

let lastDrawPointer = 0;
document.addEventListener('pointerup', event => {
  const button = event.target.closest?.('.draw-skill');
  if (!button) return;
  event.preventDefault();
  lastDrawPointer = Date.now();
  drawSkill(button.dataset.player);
}, { passive: false });
document.addEventListener('click', event => {
  const button = event.target.closest?.('.draw-skill');
  if (!button || Date.now() - lastDrawPointer < 600) return;
  event.preventDefault();
  drawSkill(button.dataset.player);
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

function clearHighestOccupiedRow(board) {
  const rows = board.map(row => row.slice());
  const index = rows.findIndex(row => row.some(Boolean));
  if (index < 0) return rows;
  rows.splice(index, 1);
  rows.unshift(Array(rows[0]?.length || 10).fill(0));
  return rows;
}

function reshapeBottom(board, depth = 4) {
  const rows = board.map(row => row.slice());
  const start = Math.max(0, rows.length - depth);
  const width = rows[0]?.length || 10;
  const colors = rows.slice(start).flat().filter(Boolean);
  const rebuilt = Array.from({ length: rows.length - start }, () => Array(width).fill(0));
  colors.forEach((color, index) => {
    const row = rebuilt.length - 1 - Math.floor(index / Math.max(1, width - 1));
    if (row >= 0) rebuilt[row][index % Math.max(1, width - 1)] = color;
  });
  return [...rows.slice(0, start), ...rebuilt];
}

function stateOf(player) {
  return {
    score: player.score, energy: player.energy, ackSeq: lastAckSeq, alive: player.alive, jammed: player.jammed === true, reversed: player.reversed === true, skills: player.skills || [], board: player.board,
    blockedColumn: player.blockedColumn, blockedUntil: player.blockedUntil || 0, gravity: player.gravity === true, hardDropUnlocked: player.hardDropUnlocked === true,
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
    player.dropInterval = player.gravity ? 250 : player.frenzyUntil > Date.now() ? 540 : 760;
    if (advancePlayer(player, delta, 2) > 0) paint(key);
  });
  if (online && matchStarted && players.b.alive && Date.now() - (players.b.lastSnapshotAt || 0) > 350) {
    if (advancePlayer(players.b, delta, 2) > 0) paint('b');
  }
  if (online && matchStarted && !matchEnded && !players.b.alive && !opponentLossReported) {
    opponentLossReported = true;
    network.command({ type: 'reportOpponentLoss' });
  }
  if (online && matchStarted && !matchEnded && !players.a.alive) finishMatch('你输了');
  if (online && matchStarted && now >= skillSyncPauseUntil && now - lastStateSent >= 100) {
    lastStateSent = now;
    network.state(stateOf(players.a));
  }
  if (players.a.copyExpiresAt && players.a.copyExpiresAt <= Date.now()) {
    players.a.copyExpiresAt = 0;
    players.a.copyBoard = null;
    renderSkillHand('a');
  }
  Object.values(players).forEach(player => {
    if (player.blockedUntil > 0 && player.blockedUntil <= Date.now()) {
      player.blockedColumn = null;
      player.blockedUntil = 0;
      paint(player === players.a ? 'a' : 'b');
    }
  });
  renderPrediction('a');
  requestAnimationFrame(loop);
}

renderAllSkillHands();
paint('a'); paint('b'); setOnlineControls(); setRoomView('waiting'); log('请创建或加入房间'); requestAnimationFrame(loop);
