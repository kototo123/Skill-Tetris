const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code = '';
  for (let i = 0; i < 5; i += 1) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

class RoomManager {
  constructor() { this.rooms = new Map(); }

  createRoom(playerId) {
    let code = makeCode();
    while (this.rooms.has(code)) code = makeCode();
    const room = { code, hostId: playerId, status: 'waiting', countdown: 0, players: [playerId], ready: new Set(), commands: [], seq: 0, clients: new Map(), states: new Map(), disconnected: new Map() };
    room.states.set(playerId, { score: 0, energy: 0, alive: true, board: null, current: null });
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, playerId) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) throw new Error('ROOM_NOT_FOUND');
    if (room.players.includes(playerId)) return room;
    if (room.players.length >= 2) throw new Error('ROOM_FULL');
    room.players.push(playerId);
    room.states.set(playerId, { score: 0, energy: 0, alive: true, board: null, current: null });
    return room;
  }

  setReady(code, playerId) {
    const room = this.getRoom(code);
    if (!room.players.includes(playerId)) throw new Error('PLAYER_NOT_IN_ROOM');
    room.ready.add(playerId);
    if (room.ready.size === 2) room.status = 'ready';
    return room;
  }

  startRoom(code, playerId) {
    const room = this.getRoom(code);
    if (room.hostId !== playerId) throw new Error('ONLY_HOST');
    if (room.players.length !== 2 || room.ready.size !== 2) throw new Error('NOT_READY');
    room.status = 'countdown';
    room.countdown = 3;
    return room;
  }

  recordCommand(code, playerId, payload) {
    const room = this.getRoom(code);
    if (!room.players.includes(playerId)) throw new Error('PLAYER_NOT_IN_ROOM');
    if (!payload || !['move', 'rotate', 'softDrop', 'hardDrop', 'skill'].includes(payload.type)) throw new Error('INVALID_COMMAND');
    if (payload.type === 'move' && ![-1, 1].includes(payload.direction)) throw new Error('INVALID_DIRECTION');
    const command = { seq: ++room.seq, playerId, payload, at: Date.now() };
    room.commands.push(command);
    if (room.commands.length > 200) room.commands.shift();
    return command;
  }

  updateState(code, playerId, state) {
    const room = this.getRoom(code);
    if (!room.players.includes(playerId)) throw new Error('PLAYER_NOT_IN_ROOM');
    const previous = room.states.get(playerId) || {};
    room.states.set(playerId, {
      score: Number.isFinite(state?.score) ? state.score : previous.score || 0,
      energy: Number.isFinite(state?.energy) ? Math.max(0, Math.min(100, state.energy)) : previous.energy || 0,
      alive: state?.alive !== false,
      board: Array.isArray(state?.board) ? state.board : previous.board,
      current: state?.current && Array.isArray(state.current.cells) ? {
        cells: state.current.cells,
        x: Number.isFinite(state.current.x) ? state.current.x : 0,
        y: Number.isFinite(state.current.y) ? state.current.y : 0,
        color: String(state.current.color || 'cyan')
      } : previous.current || null
    });
    return this.snapshot(room.code);
  }

  snapshot(code) {
    const room = this.getRoom(code);
    return {
      code: room.code,
      status: room.status,
      countdown: room.countdown,
      players: room.players.map(playerId => ({ playerId, ready: room.ready.has(playerId), connected: room.clients.has(playerId), state: room.states.get(playerId) || null })),
      seq: room.seq
    };
  }

  getRoom(code) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) throw new Error('ROOM_NOT_FOUND');
    return room;
  }
}

function createServer({ port = 4174, manager = new RoomManager() } = {}) {
  let WebSocketServer;
  try { ({ WebSocketServer } = require('ws')); } catch { WebSocketServer = null; }
  const publicFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/game.js': ['game.js', 'text/javascript; charset=utf-8'], '/client-network.js': ['client-network.js', 'text/javascript; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, service: 'hexa-clash', rooms: manager.rooms.size })); return; }
    const file = publicFiles[req.url];
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    const content = fs.readFileSync(path.join(__dirname, file[0]));
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
    res.end(content);
  });
  if (!WebSocketServer) return { httpServer, manager };
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', socket => {
    let playerId = `guest-${Math.random().toString(36).slice(2, 8)}`;
    let room;
    const send = message => socket.send(JSON.stringify(message));
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { send({ type: 'error', code: 'BAD_JSON' }); return; }
      try {
        if (message.type === 'create') room = manager.createRoom(playerId);
        else if (message.type === 'join') room = manager.joinRoom(message.code, playerId);
        else if (!room) throw new Error('NOT_IN_ROOM');
        else if (message.type === 'ready') room = manager.setReady(room.code, playerId);
        else if (message.type === 'start') room = manager.startRoom(room.code, playerId);
        else if (message.type === 'command') manager.recordCommand(room.code, playerId, message.payload);
        else if (message.type === 'state') manager.updateState(room.code, playerId, message.state);
        else throw new Error('UNKNOWN_MESSAGE');
        if (room) {
          room.clients.set(playerId, socket);
          const event = { type: message.type === 'command' ? 'command' : message.type === 'state' ? 'snapshot' : message.type === 'start' ? 'countdown' : 'room', room: manager.snapshot(room.code), playerId, countdown: message.type === 'start' ? 3 : undefined, payload: message.payload };
          room.clients.forEach((client, clientId) => {
            if (client.readyState === 1) client.send(JSON.stringify({ ...event, selfId: clientId }));
          });
          if (message.type === 'start') {
            setTimeout(() => {
              if (room.status !== 'countdown') return;
              room.status = 'playing';
              room.countdown = 0;
              const live = { type: 'room', room: manager.snapshot(room.code) };
              room.clients.forEach((client, clientId) => {
                if (client.readyState === 1) client.send(JSON.stringify({ ...live, selfId: clientId }));
              });
            }, 3000);
          }
        }
      } catch (error) { send({ type: 'error', code: error.message }); }
    });
    socket.on('close', () => { if (room) room.clients.delete(playerId); });
  });
  return { httpServer, manager, wss };
}

if (require.main === module) {
  const { httpServer } = createServer({ port: Number(process.env.PORT) || 4174 });
  const port = Number(process.env.PORT) || 4174;
  httpServer.listen(port, '0.0.0.0', () => console.log(`hexa-clash server listening on ${port}`));
}

module.exports = { RoomManager, createServer };
