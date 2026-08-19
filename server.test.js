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

console.log('server room tests passed');
