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

test('records ordered player commands', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  manager.recordCommand(room.code, 'p1', { type: 'move', direction: 1 });
  assert.deepEqual(room.commands[0].payload, { type: 'move', direction: 1 });
  assert.equal(room.commands[0].seq, 1);
});

test('rejects malformed commands and exposes authoritative snapshots', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('p1');
  manager.joinRoom(room.code, 'p2');
  assert.throws(() => manager.recordCommand(room.code, 'p1', { type: 'move', direction: 0 }), /INVALID_DIRECTION/);
  manager.recordCommand(room.code, 'p1', { type: 'hardDrop' });
  const snapshot = manager.updateState(room.code, 'p1', { score: 12, energy: 150, alive: true, board: [[1]] });
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

test('starting a room resets player state and a strike adds garbage to the opponent', () => {
  const manager = new RoomManager();
  const room = manager.createRoom('host');
  manager.joinRoom(room.code, 'guest');
  manager.updateState(room.code, 'host', { score: 99, energy: 80, alive: false, board: Array.from({ length: 20 }, () => Array(10).fill(0)) });
  manager.setReady(room.code, 'host');
  manager.setReady(room.code, 'guest');
  manager.startRoom(room.code, 'host');
  assert.equal(room.states.get('host').score, 0);
  assert.equal(room.states.get('host').alive, true);
  manager.recordCommand(room.code, 'host', { type: 'skill', skill: 'strike' });
  assert.equal(room.states.get('guest').board.at(-1).some(cell => cell === 8), true);
});

console.log('server room tests passed');
