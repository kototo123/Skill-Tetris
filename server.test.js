const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { RoomManager, createServer } = require('./server.js');
const WebSocket = require('ws');

test('creates a room with a short invite code', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  assert.match(room.code, /^[A-Z0-9]{5}$/);
  assert.equal(room.players.length, 1);
});

test('joins a room by code and reaches ready when both players ready', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  manager.joinRoom(room.code, 'p2');
  manager.setReady(room.code, 'p1');
  assert.equal(manager.setReady(room.code, 'p2').status, 'ready');
});

test('starts each player with an empty random hand while keeping cleanse fixed', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  const state = room.states.get('p1');
  assert.equal(state.energy, 50);
  assert.equal(Array.isArray(state.skills), true);
  assert.equal(state.skills.length, 0);
  assert.equal(state.skills.includes('cleanse'), false);
});

test('drawSkill spends energy and adds one card to the hand', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  room.status = 'playing';
  const state = room.states.get('p1');
  state.energy = 10;
  state.skills = [];
  const command = manager.recordCommand(room.code, 'p1', { type: 'drawSkill' });
  assert.equal(command.effect.cost, 10);
  assert.equal(room.states.get('p1').energy, 0);
  assert.equal(room.states.get('p1').skills.length, 1);
});

test('fixed cleanse can be used without owning a card and cards are consumed', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  room.status = 'playing';
  const state = room.states.get('p1');
  state.energy = 40;
  state.skills = ['reshape'];
  const command = manager.recordCommand(room.code, 'p1', { type: 'skill', skill: 'cleanse' });
  assert.equal(command.effect.cost, 30);
  assert.deepEqual(room.states.get('p1').skills, ['reshape']);
  room.states.get('p1').energy = 25;
  manager.recordCommand(room.code, 'p1', { type: 'skill', skill: 'reshape' });
  assert.deepEqual(room.states.get('p1').skills, []);
});

test('drawSkill rejects a full three-card hand without spending energy', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  room.status = 'playing';
  const state = room.states.get('p1');
  state.energy = 50;
  state.skills = ['jam', 'reverse', 'slam'];
  assert.throws(() => manager.recordCommand(room.code, 'p1', { type: 'drawSkill' }), /SKILL_HAND_FULL/);
  assert.equal(state.energy, 50);
  assert.equal(room.commands.length, 0);
});

test('attack cards cannot be forged when they are not in the server hand', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  Object.assign(room.states.get('host'), { energy: 100, skills: [] });

  assert.throws(() => manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'jam' }), /SKILL_NOT_OWNED/);
  assert.throws(() => manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'reverse' }), /SKILL_NOT_OWNED/);
  assert.equal(room.states.get('host').energy, 100);
});

test('removed shield commands cannot be forged after the skill leaves the card pool', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  room.status = 'playing';
  Object.assign(room.states.get('host'), { energy: 100, skills: [] });
  assert.throws(() => manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'shield' }), /INVALID_SKILL/);
});

test('stale state snapshots cannot refund energy spent by a skill command', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  room.status = 'playing';
  Object.assign(room.states.get('p1'), { energy: 20, skills: [] });
  const command = manager.recordCommand(room.code, 'p1', { type: 'drawSkill' });
  assert.equal(command.seq, 1);

  manager.updateState(room.code, 'p1', { energy: 20, ackSeq: 0 });
  assert.equal(room.states.get('p1').energy, 10);

  manager.updateState(room.code, 'p1', { energy: 28, ackSeq: 1 });
  assert.equal(room.states.get('p1').energy, 10);

  manager.updateState(room.code, 'p1', { score: 100, energy: 28, ackSeq: 1 });
  assert.equal(room.states.get('p1').energy, 28);
});

test('consecutive line clears keep the client combo energy reward', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  room.status = 'playing';
  manager.updateState(room.code, 'p1', { score: 100, energy: 42 });
  manager.updateState(room.code, 'p1', { score: 200, energy: 68 });
  assert.equal(room.states.get('p1').energy, 68);
});

test('using one duplicated card leaves the other copy in hand', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  room.status = 'playing';
  Object.assign(room.states.get('host'), { energy: 50, skills: ['predict', 'predict'] });
  manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'predict' });
  assert.deepEqual(room.states.get('host').skills, ['predict']);
});

test('swapShape exchanges both active pieces and reports authoritative snapshots', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  const host = room.states.get('host');
  const guest = room.states.get('guest');
  host.energy = 25;
  host.skills = ['swapShape'];
  host.current = { cells: [[1, 1, 1, 1]], x: 3, y: 4, color: 'cyan' };
  guest.current = { cells: [[1, 1], [1, 1]], x: 4, y: 7, color: 'yellow' };

  const command = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'swapShape' });

  assert.deepEqual(room.states.get('host').current.cells, [[1, 1], [1, 1]]);
  assert.deepEqual(room.states.get('guest').current.cells, [[1, 1, 1, 1]]);
  assert.deepEqual(command.effect.players.host.current, room.states.get('host').current);
  assert.deepEqual(command.effect.players.guest.current, room.states.get('guest').current);
});

test('swapShape clamps a wider incoming piece inside the ten-column board', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  Object.assign(room.states.get('host'), { energy: 25, skills: ['swapShape'], current: { cells: [[1, 1]], x: 8, y: 3, color: 'yellow' } });
  room.states.get('guest').current = { cells: [[1, 1, 1, 1]], x: 3, y: 2, color: 'cyan' };
  manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'swapShape' });
  assert.equal(room.states.get('host').current.x, 6);
});

test('swapShape lifts an incoming piece above occupied cells', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  const board = Array.from({ length: 20 }, () => Array(10).fill(0));
  board[3][3] = 1;
  Object.assign(room.states.get('host'), { energy: 25, skills: ['swapShape'], board, current: { cells: [[1]], x: 3, y: 3, color: 'red' } });
  room.states.get('guest').current = { cells: [[1, 1, 1, 1]], x: 3, y: 2, color: 'cyan' };
  manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'swapShape' });
  assert.equal(room.states.get('host').current.y < 3, true);
});

test('viewer snapshots hide the opponents random cards and saved board', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  Object.assign(room.states.get('guest'), { skills: ['slam', 'predict'], copyBoard: { board: [[1]], current: null, expiresAt: Date.now() + 5000 } });
  const snapshot = manager.snapshot(room.code, 'host');
  const guest = snapshot.players.find(player => player.playerId === 'guest');
  assert.deepEqual(guest.state.skills, [null, null]);
  assert.equal(guest.state.copyBoard, null);
});

test('reflect sends the next attack back to its caster and is consumed', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  Object.assign(room.states.get('guest'), { energy: 25, skills: ['reflect'] });
  manager.recordCommand(room.code, 'guest', { type: 'skill', skill: 'reflect' });
  Object.assign(room.states.get('host'), { energy: 10, skills: ['jam'] });

  const command = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'jam' });

  assert.equal(command.effect.reflected, true);
  assert.equal(command.effect.targetId, 'host');
  assert.equal(room.states.get('host').jammed, true);
  assert.equal(room.states.get('guest').reflect, false);
});

test('slam marks the opponent for one forced hard drop', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  Object.assign(room.states.get('host'), { energy: 35, skills: ['slam'] });

  const command = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'slam' });

  assert.equal(command.effect.forceDrop, true);
  assert.equal(command.effect.targetId, 'guest');
});

test('clearTop removes the highest occupied row instead of an empty top row', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  room.status = 'playing';
  const board = Array.from({ length: 20 }, () => Array(10).fill(0));
  board[7][2] = 1;
  board[8][3] = 1;
  Object.assign(room.states.get('host'), { energy: 40, skills: ['clearTop'], board });

  manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'clearTop' });

  assert.equal(room.states.get('host').board[7].every(cell => cell === 0), true);
  assert.equal(room.states.get('host').board[8][3], 1);
});

test('copyBoard consumes one card to save a board and restores it once for free', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  room.status = 'playing';
  const savedBoard = Array.from({ length: 20 }, () => Array(10).fill(0));
  savedBoard[18][1] = 1;
  const savedCurrent = { cells: [[1, 1]], x: 4, y: 8, color: 'cyan' };
  Object.assign(room.states.get('host'), { energy: 35, skills: ['copyBoard'], board: savedBoard, current: savedCurrent });

  const armed = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'copyBoard' });
  assert.equal(armed.effect.copyArmed, true);
  assert.equal(room.states.get('host').energy, 0);
  assert.deepEqual(room.states.get('host').skills, []);

  room.states.get('host').board = Array.from({ length: 20 }, () => Array(10).fill(8));
  room.states.get('host').current = { cells: [[1]], x: 0, y: 0, color: 'red' };
  const restored = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'copyBoard' });

  assert.equal(restored.effect.restoreCopy, true);
  assert.deepEqual(restored.effect.board, savedBoard);
  assert.deepEqual(restored.effect.current, savedCurrent);
  assert.equal(room.states.get('host').copyBoard, null);
});

test('records ordered player commands', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  room.status = 'playing';
  manager.recordCommand(room.code, 'p1', { type: 'move', direction: 1 });
  assert.deepEqual(room.commands[0].payload, { type: 'move', direction: 1 });
  assert.equal(room.commands[0].seq, 1);
});

test('rejects malformed commands and exposes authoritative snapshots', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  manager.joinRoom(room.code, 'p2');
  room.status = 'playing';
  assert.throws(() => manager.recordCommand(room.code, 'p1', { type: 'move', direction: 0 }), /INVALID_DIRECTION/);
  manager.recordCommand(room.code, 'p1', { type: 'hardDrop' });
  const snapshot = manager.updateState(room.code, 'p1', { score: 1000, energy: 150, alive: true, board: [[1]] });
  assert.equal(snapshot.seq, 1);
  assert.equal(snapshot.players.find(player => player.playerId === 'p1').state.energy, 100);
  assert.equal(snapshot.players.find(player => player.playerId === 'p2').connected, false);
});

test('serves the mobile client from the realtime server', async () => {
  const { httpServer, wss } = createServer();
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const response = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/index.html`, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });
  await new Promise(resolve => httpServer.close(resolve));
  assert.equal(response.status, 200);
  assert.match(response.type, /text\/html/);
  assert.match(response.body, /Skill Tetris/);
  assert.match(response.body, /id="room-presence"/);
  assert.match(response.body, /id="room-toast"/);
  assert.match(response.body, /id="lobby-overlay"/);
  assert.match(response.body, /id="countdown-value"/);
  assert.match(response.body, /id="result"/);
  assert.match(response.body, /id="skills-a"/);
  assert.match(response.body, /id="skill-slots-a"/);
  assert.match(response.body, /class="draw-skill"/);
  assert.match(response.body, /lobby-overlay[^}]*pointer-events:none/);
  assert.match(response.body, /\.lobby-overlay\[hidden\]\{display:none!important\}/);
  assert.doesNotMatch(response.body, /连接快照/);
});

test('serves the synchronized mobile app script', async () => {
  const { httpServer } = createServer();
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const response = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/app.js`, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  await new Promise(resolve => httpServer.close(resolve));
  assert.equal(response.status, 200);
  assert.match(response.body, /applyRemoteState/);
  assert.match(response.body, /dropInterval = 760/);
  assert.match(response.body, /updateRoomPresence/);
  assert.match(response.body, /showRoomToast/);
  assert.match(response.body, /setRoomView/);
  assert.match(response.body, /readyButton.textContent = selfRoomPlayer/);
  assert.match(response.body, /network\.state\(stateOf\(player\)\)/);
  assert.match(response.body, /copyDurationMs/);
  assert.match(response.body, /predictDurationMs/);
});

test('returns a stable error when a client sends state before joining a room', async () => {
  const { httpServer, wss } = createServer();
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const response = new Promise((resolve, reject) => {
    socket.once('message', raw => resolve(JSON.parse(raw.toString())));
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ type: 'state', state: { score: 0 } }));
  assert.deepEqual(await response, { type: 'error', code: 'NOT_IN_ROOM' });
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.close();
  await closed;
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => httpServer.close(resolve));
});

function openSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
    socket.once('error', reject);
  });
}

test('identifies each client and broadcasts the opponent active-piece snapshot', async () => {
  const { httpServer, wss } = createServer();
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const first = await openSocket(port);
  const second = await openSocket(port);

  const created = nextMessage(first, message => message.type === 'room');
  first.send(JSON.stringify({ type: 'create' }));
  const firstRoom = await created;
  assert.equal(firstRoom.selfId, firstRoom.room.players[0].playerId);

  const joinedForSecond = nextMessage(second, message => message.type === 'room');
  second.send(JSON.stringify({ type: 'join', code: firstRoom.room.code }));
  const secondRoom = await joinedForSecond;
  assert.equal(secondRoom.selfId, secondRoom.room.players[1].playerId);

  const opponentSnapshot = nextMessage(second, message => message.type === 'snapshot');
  first.send(JSON.stringify({ type: 'state', state: {
    score: 25, energy: 10, alive: true, board: [[0]],
    current: { cells: [[1]], x: 4, y: 3, color: 'cyan' }
  } }));
  const snapshot = await opponentSnapshot;
  const firstState = snapshot.room.players.find(player => player.playerId === firstRoom.selfId).state;
  assert.deepEqual(firstState.current, { cells: [[1]], x: 4, y: 3, color: 'cyan' });

  first.terminate();
  second.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => httpServer.close(resolve));
});

test('draw broadcasts reveal the new card only to its owner', async () => {
  const { httpServer, wss, manager } = createServer();
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const host = await openSocket(port);
  const guest = await openSocket(port);
  const created = nextMessage(host, message => message.type === 'room');
  host.send(JSON.stringify({ type: 'create' }));
  const hostRoom = await created;
  const joinedForGuest = nextMessage(guest, message => message.type === 'room');
  guest.send(JSON.stringify({ type: 'join', code: hostRoom.room.code }));
  const guestRoom = await joinedForGuest;
  const room = manager.getRoom(hostRoom.room.code);
  room.status = 'playing';
  Object.assign(room.states.get(hostRoom.selfId), { energy: 10, skills: [] });

  const ownerCommand = nextMessage(host, message => message.type === 'command' && message.payload?.type === 'drawSkill');
  const opponentCommand = nextMessage(guest, message => message.type === 'command' && message.payload?.type === 'drawSkill');
  host.send(JSON.stringify({ type: 'command', payload: { type: 'drawSkill' } }));
  const ownerEvent = await ownerCommand;
  const opponentEvent = await opponentCommand;

  assert.equal(typeof ownerEvent.effect.skill, 'string');
  assert.equal(ownerEvent.effect.hand.length, 1);
  assert.equal(opponentEvent.effect.skill, undefined);
  assert.equal(opponentEvent.effect.hand, undefined);
  assert.deepEqual(opponentEvent.room.players.find(player => player.playerId === hostRoom.selfId).state.skills, [null]);
  assert.equal(guestRoom.selfId !== hostRoom.selfId, true);

  host.terminate(); guest.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => httpServer.close(resolve));
});

test('stamps player snapshots with the time that player last updated state', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  const before = Date.now();
  manager.updateState(room.code, 'guest', { score: 4, alive: true });
  const updatedAt = room.states.get('guest').updatedAt;
  assert.equal(Number.isFinite(updatedAt), true);
  assert.equal(updatedAt >= before, true);
});

test('only the host can start a ready room and emits a three second countdown', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  manager.setReady(room.code, 'host');
  manager.setReady(room.code, 'guest');
  assert.throws(() => manager.startRoom(room.code, 'guest'), /ONLY_HOST/);
  const started = manager.startRoom(room.code, 'host');
  assert.equal(started.status, 'countdown');
  assert.equal(started.countdown, 3);
});

test('broadcasts countdown to both connected players', async () => {
  const { httpServer, wss } = createServer();
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const host = await openSocket(port);
  const guest = await openSocket(port);
  const created = nextMessage(host, message => message.type === 'room');
  host.send(JSON.stringify({ type: 'create' }));
  const code = (await created).room.code;
  const joined = nextMessage(guest, message => message.type === 'room');
  guest.send(JSON.stringify({ type: 'join', code }));
  await joined;
  const hostReady = nextMessage(host, message => message.type === 'room' && message.room.status === 'ready');
  host.send(JSON.stringify({ type: 'ready' }));
  guest.send(JSON.stringify({ type: 'ready' }));
  await hostReady;
  const hostCountdown = nextMessage(host, message => message.type === 'countdown');
  const guestCountdown = nextMessage(guest, message => message.type === 'countdown');
  host.send(JSON.stringify({ type: 'start' }));
  assert.equal((await hostCountdown).countdown, 3);
  assert.equal((await guestCountdown).countdown, 3);
  host.terminate(); guest.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => httpServer.close(resolve));
});

test('starting a room resets player state and jam locks the opponent piece', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  manager.updateState(room.code, 'host', { score: 99, energy: 80, alive: false, board: Array.from({ length: 20 }, () => Array(10).fill(0)) });
  manager.setReady(room.code, 'host');
  manager.setReady(room.code, 'guest');
  manager.startRoom(room.code, 'host');
  room.status = 'playing';
  assert.equal(room.states.get('host').score, 0);
  assert.equal(room.states.get('host').energy, 50);
  assert.equal(room.states.get('host').alive, true);
  manager.updateState(room.code, 'host', { ackSeq: room.seq, board: Array.from({ length: 20 }, () => Array(10).fill(0)) });
  room.states.get('host').energy = 10;
  room.states.get('host').skills = ['jam'];
  const strike = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'jam' });
  assert.equal(strike.effect.cost, 10);
  assert.equal(room.states.get('host').energy, 0);
  assert.equal(strike.effect.jammed, true);
  assert.equal(room.states.get('guest').jammed, true);
});

test('a stale snapshot from the previous round cannot overwrite the reset state', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.seq = 9;
  manager.setReady(room.code, 'host');
  manager.setReady(room.code, 'guest');
  manager.startRoom(room.code, 'host');

  manager.updateState(room.code, 'host', { energy: 88, score: 900, ackSeq: 9 });

  assert.equal(room.states.get('host').energy, 50);
  assert.equal(room.states.get('host').score, 0);
  assert.equal(room.seq > 9, true);
});

test('preserves reflect across state snapshots and rejects an unaffordable skill without recording it', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  Object.assign(room.states.get('host'), { energy: 25, skills: ['reflect', 'jam'], board: Array.from({ length: 20 }, () => Array(10).fill(0)) });
  manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'reflect' });
  manager.updateState(room.code, 'host', { score: 3, energy: 0, board: Array.from({ length: 20 }, () => Array(10).fill(0)) });
  assert.equal(room.states.get('host').reflect, true);
  assert.throws(() => manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'jam' }), /INSUFFICIENT_ENERGY/);
  assert.equal(room.seq, 1);
  assert.equal(room.commands.length, 1);
});

test('finishes the room with one authoritative winner when a player dies', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  const snapshot = manager.updateState(room.code, 'guest', { alive: false, board: Array.from({ length: 20 }, () => Array(10).fill(1)) });
  assert.equal(snapshot.status, 'finished');
  assert.equal(snapshot.winnerId, 'host');
});

test('blocks commands outside active play and reports jam target', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  assert.throws(() => manager.recordCommand(room.code, 'host', { type: 'move', direction: 1 }), /MATCH_NOT_PLAYING/);
  room.status = 'playing';
  Object.assign(room.states.get('host'), { energy: 10, skills: ['jam'] });
  Object.assign(room.states.get('guest'), { energy: 25, skills: ['reflect'] });
  manager.recordCommand(room.code, 'guest', { type: 'skill', skill: 'reflect' });
  const blocked = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'jam' });
  assert.equal(blocked.effect.blocked, true);
  assert.equal(blocked.effect.reflected, true);
  assert.equal(blocked.effect.jammed, true);
  assert.equal(blocked.effect.targetId, 'host');
  room.status = 'finished';
  assert.throws(() => manager.recordCommand(room.code, 'host', { type: 'hardDrop' }), /MATCH_NOT_PLAYING/);
});

test('enforces room state transitions for ready start and finish', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  manager.updateState(room.code, 'guest', { alive: false });
  assert.equal(room.status, 'waiting');
  manager.setReady(room.code, 'host');
  manager.setReady(room.code, 'guest');
  manager.startRoom(room.code, 'host');
  assert.throws(() => manager.startRoom(room.code, 'host'), /MATCH_ALREADY_STARTED/);
  assert.throws(() => manager.setReady(room.code, 'host'), /READY_NOT_ALLOWED/);
});

test('keeps finished room open and allows both players to prepare a rematch', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'finished';
  room.winnerId = 'host';
  assert.equal(manager.setReady(room.code, 'host').status, 'waiting');
  assert.equal(manager.setReady(room.code, 'guest').status, 'ready');
  assert.equal(manager.startRoom(room.code, 'host').status, 'countdown');
});

test('notifies the remaining player when the opponent disconnects', async () => {
  const { httpServer, wss } = createServer();
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  const host = await openSocket(port);
  const guest = await openSocket(port);
  const created = nextMessage(host, message => message.type === 'room');
  host.send(JSON.stringify({ type: 'create' }));
  const code = (await created).room.code;
  const joined = nextMessage(guest, message => message.type === 'room');
  guest.send(JSON.stringify({ type: 'join', code }));
  const guestRoom = await joined;
  const disconnected = nextMessage(host, message => message.disconnectedId === guestRoom.selfId);
  guest.close();
  const notice = await disconnected;
  assert.equal(notice.room.players.find(player => player.playerId === guestRoom.selfId).connected, false);
  host.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => httpServer.close(resolve));
});

test('accepts jam as a real low-cost skill', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  room.states.get('host').energy = 10;
  room.states.get('host').skills = ['jam'];
  const command = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'jam' });
  assert.equal(command.effect.jammed, true);
  assert.equal(room.states.get('host').energy, 0);
});

test('accepts reverse as a low-cost attack and marks the opponent', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  room.states.get('host').energy = 10;
  room.states.get('host').skills = ['reverse'];
  const command = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'reverse' });
  assert.equal(command.effect.reversed, true);
  assert.equal(command.effect.cost, 10);
  assert.equal(room.states.get('host').energy, 0);
  assert.equal(room.states.get('guest').reversed, true);
});

test('targets cleanse at the caster and charges thirty energy', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  room.states.get('host').energy = 30;
  const command = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'cleanse' });
  assert.equal(command.effect.targetId, 'host');
  assert.equal(command.effect.energy, 0);
});

test('cleanse removes active attack debuffs', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  room.status = 'playing';
  manager.updateState(room.code, 'host', { energy: 30, jammed: true, reversed: true });
  const command = manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'cleanse' });
  assert.equal(command.effect.targetId, 'host');
  assert.equal(room.states.get('host').jammed, false);
  assert.equal(room.states.get('host').reversed, false);
});

test('using another defensive card does not secretly cleanse debuffs or cancel reflect', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  room.status = 'playing';
  Object.assign(room.states.get('host'), {
    energy: 40,
    skills: ['predict'],
    jammed: true,
    reversed: true,
    reflect: true
  });

  manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'predict' });

  assert.equal(room.states.get('host').jammed, true);
  assert.equal(room.states.get('host').reversed, true);
  assert.equal(room.states.get('host').reflect, true);
});


console.log('server room tests passed');
