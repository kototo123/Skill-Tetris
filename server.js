const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SKILL_CARDS = ['jam', 'reverse', 'swapShape', 'slam', 'reshape', 'store', 'predict', 'reflect', 'clearTop', 'copyBoard'];
const SKILL_COSTS = { jam: 10, reverse: 10, swapShape: 25, slam: 35, reshape: 25, store: 15, predict: 15, reflect: 25, clearTop: 40, copyBoard: 35 };

function randomCards(count = 3) {
  return Array.from({ length: count }, () => SKILL_CARDS[Math.floor(Math.random() * SKILL_CARDS.length)]);
}

function initialState(stateSeq = 0) {
  return { score: 0, energy: 50, stateSeq, alive: true, board: null, current: null, skills: [], held: null, predictUntil: 0, reflect: false, copyBoard: null };
}

function cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clearHighestOccupiedRow(board) {
  const rows = cloneValue(board);
  const index = rows.findIndex(row => row.some(Boolean));
  if (index < 0) return rows;
  rows.splice(index, 1);
  rows.unshift(Array(rows[0]?.length || 10).fill(0));
  return rows;
}

function reshapeBottom(board, depth = 4) {
  const rows = cloneValue(board);
  const start = Math.max(0, rows.length - depth);
  const width = rows[0]?.length || 10;
  const colors = rows.slice(start).flat().filter(Boolean);
  const rebuilt = Array.from({ length: rows.length - start }, () => Array(width).fill(0));
  colors.forEach((color, index) => {
    const row = rebuilt.length - 1 - Math.floor(index / Math.max(1, width - 1));
    if (row < 0) return;
    rebuilt[row][index % Math.max(1, width - 1)] = color;
  });
  return [...rows.slice(0, start), ...rebuilt];
}

function consumeOne(cards, skill) {
  const next = [...cards];
  const index = next.indexOf(skill);
  if (index >= 0) next.splice(index, 1);
  return next;
}

function fitPieceToBoard(board, incoming, position) {
  if (!incoming) return incoming;
  const width = Array.isArray(board?.[0]) ? board[0].length : 10;
  const height = Array.isArray(board) ? board.length : 20;
  const pieceWidth = incoming.cells?.[0]?.length || 1;
  const pieceHeight = incoming.cells?.length || 1;
  const x = Math.max(0, Math.min(position?.x ?? incoming.x ?? 0, width - pieceWidth));
  let y = Math.min(position?.y ?? incoming.y ?? -1, height - pieceHeight);
  const collides = () => incoming.cells.some((row, dy) => row.some((cell, dx) => {
    if (!cell) return false;
    const by = y + dy;
    const bx = x + dx;
    return bx < 0 || bx >= width || by >= height || (by >= 0 && board?.[by]?.[bx]);
  }));
  while (collides() && y > -pieceHeight) y -= 1;
  return { ...incoming, x, y };
}

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
    room.states.set(playerId, initialState());
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, playerId) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) throw new Error('ROOM_NOT_FOUND');
    if (room.players.includes(playerId)) return room;
    if (room.players.length >= 2) throw new Error('ROOM_FULL');
    room.players.push(playerId);
    room.states.set(playerId, initialState());
    return room;
  }

  setReady(code, playerId) {
    const room = this.getRoom(code);
    if (!room.players.includes(playerId)) throw new Error('PLAYER_NOT_IN_ROOM');
    if (room.status === 'finished') {
      room.status = 'waiting';
      room.winnerId = null;
      room.ready.clear();
    }
    if (!['waiting', 'ready'].includes(room.status)) throw new Error('READY_NOT_ALLOWED');
    room.ready.add(playerId);
    if (room.ready.size === 2) room.status = 'ready';
    return room;
  }

  startRoom(code, playerId) {
    const room = this.getRoom(code);
    if (room.hostId !== playerId) throw new Error('ONLY_HOST');
    if (['countdown', 'playing', 'finished'].includes(room.status)) throw new Error('MATCH_ALREADY_STARTED');
    if (room.players.length !== 2 || room.ready.size !== 2) throw new Error('NOT_READY');
    room.status = 'countdown';
    room.countdown = 3;
    room.seq += 1;
    room.players.forEach(id => room.states.set(id, initialState(room.seq)));
    room.commands = [];
    return room;
  }

  recordCommand(code, playerId, payload) {
    const room = this.getRoom(code);
    if (!room.players.includes(playerId)) throw new Error('PLAYER_NOT_IN_ROOM');
    if (room.status !== 'playing') throw new Error('MATCH_NOT_PLAYING');
    if (!payload || !['move', 'rotate', 'softDrop', 'hardDrop', 'skill', 'drawSkill'].includes(payload.type)) throw new Error('INVALID_COMMAND');
    if (payload.type === 'move' && ![-1, 1].includes(payload.direction)) throw new Error('INVALID_DIRECTION');
    const command = { seq: room.seq + 1, playerId, payload, at: Date.now() };
    if (payload.type === 'drawSkill') {
      const drawCost = 10;
      const player = room.states.get(playerId) || initialState();
      if (player.copyBoard && player.copyBoard.expiresAt <= Date.now()) player.copyBoard = null;
      if ((player.energy || 0) < drawCost) throw new Error('INSUFFICIENT_ENERGY');
      if ((player.skills || []).length + (player.copyBoard ? 1 : 0) >= 3) throw new Error('SKILL_HAND_FULL');
      player.energy -= drawCost;
      player.stateSeq = command.seq;
      player.skills = [...(player.skills || []), ...randomCards(1)];
      player.updatedAt = Date.now();
      room.states.set(playerId, player);
      command.effect = { cost: drawCost, energy: player.energy, skill: player.skills[player.skills.length - 1], hand: player.skills };
    }
    if (payload.type === 'skill') {
      const fixedSkill = payload.skill === 'cleanse';
      const skillCost = fixedSkill ? 30 : SKILL_COSTS[payload.skill];
      const attacker = room.states.get(playerId) || {};
      if (payload.skill === 'copyBoard' && attacker.copyBoard?.expiresAt > Date.now()) {
        attacker.board = cloneValue(attacker.copyBoard.board);
        attacker.current = cloneValue(attacker.copyBoard.current);
        attacker.copyBoard = null;
        attacker.stateSeq = command.seq;
        attacker.updatedAt = Date.now();
        room.states.set(playerId, attacker);
        command.effect = {
          skill: 'copyBoard', targetId: playerId, restoreCopy: true,
          board: cloneValue(attacker.board), current: cloneValue(attacker.current),
          energy: attacker.energy, hand: attacker.skills || []
        };
        room.seq = command.seq; room.commands.push(command);
        return command;
      }
      if (payload.skill === 'copyBoard' && attacker.copyBoard) attacker.copyBoard = null;
      if (!skillCost) throw new Error('INVALID_SKILL');
      if ((attacker.energy || 0) < skillCost) throw new Error('INSUFFICIENT_ENERGY');
      if (!fixedSkill && !(attacker.skills || []).includes(payload.skill)) throw new Error('SKILL_NOT_OWNED');
      attacker.energy -= skillCost;
      attacker.stateSeq = command.seq;
      if (!fixedSkill) attacker.skills = consumeOne(attacker.skills, payload.skill);
      if (payload.skill === 'reflect') attacker.reflect = true;
      if (payload.skill === 'cleanse') {
        attacker.jammed = false;
        attacker.reversed = false;
      }
      const opponentId = room.players.find(id => id !== playerId);
      let blocked = false;
      let reflected = false;
      let effectTargetId = playerId;
      const attackSkill = ['jam', 'reverse', 'swapShape', 'slam'].includes(payload.skill);
      if (opponentId && attackSkill) {
        const opponent = room.states.get(opponentId) || {};
        if (opponent.reflect) {
          opponent.reflect = false;
          blocked = true;
          reflected = true;
          effectTargetId = playerId;
          if (payload.skill === 'jam') attacker.jammed = true;
          if (payload.skill === 'reverse') attacker.reversed = true;
          if (payload.skill === 'slam') attacker.forceDrop = true;
          if (payload.skill === 'swapShape') blocked = true;
        } else if (payload.skill === 'jam') opponent.jammed = true;
        else if (payload.skill === 'reverse') opponent.reversed = true;
        else if (payload.skill === 'slam') opponent.forceDrop = true;
        else if (payload.skill === 'swapShape') {
          const own = cloneValue(attacker.current);
          const other = cloneValue(opponent.current);
          attacker.current = fitPieceToBoard(attacker.board, other, own);
          opponent.current = fitPieceToBoard(opponent.board, own, other);
        }
        if (!blocked) effectTargetId = opponentId;
        opponent.updatedAt = Date.now();
        opponent.stateSeq = command.seq;
        room.states.set(opponentId, opponent);
      }
      if (payload.skill === 'reshape' && Array.isArray(attacker.board)) attacker.board = reshapeBottom(attacker.board);
      if (payload.skill === 'store') attacker.store = true;
      if (payload.skill === 'predict') attacker.predictUntil = Date.now() + 8000;
      if (payload.skill === 'clearTop' && Array.isArray(attacker.board)) attacker.board = clearHighestOccupiedRow(attacker.board);
      if (payload.skill === 'copyBoard') attacker.copyBoard = { board: cloneValue(attacker.board), current: cloneValue(attacker.current), expiresAt: Date.now() + 5000 };
      const opponent = opponentId ? room.states.get(opponentId) : null;
      command.effect = {
        skill: payload.skill,
        targetId: attackSkill ? effectTargetId : playerId,
        cost: skillCost,
        energy: attacker.energy,
        blocked,
        reflected,
        jammed: payload.skill === 'jam' && (!blocked || reflected),
        reversed: payload.skill === 'reverse' && (!blocked || reflected),
        cleanse: payload.skill === 'cleanse' ? 2 : 0,
        forceDrop: payload.skill === 'slam' && (!blocked || reflected),
        swapShape: payload.skill === 'swapShape' && !blocked,
        reshape: payload.skill === 'reshape',
        store: payload.skill === 'store',
        predictUntil: attacker.predictUntil || 0,
        predictDurationMs: payload.skill === 'predict' ? 8000 : 0,
        reflect: payload.skill === 'reflect',
        clearTop: payload.skill === 'clearTop',
        copyArmed: payload.skill === 'copyBoard',
        copyExpiresAt: attacker.copyBoard?.expiresAt || 0,
        copyDurationMs: payload.skill === 'copyBoard' ? 5000 : 0,
        board: ['reshape', 'clearTop'].includes(payload.skill) ? cloneValue(attacker.board) : undefined,
        current: payload.skill === 'store' ? cloneValue(attacker.current) : undefined,
        players: payload.skill === 'swapShape' && !blocked ? {
          [playerId]: { current: cloneValue(attacker.current) },
          [opponentId]: { current: cloneValue(opponent?.current) }
        } : undefined,
        hand: attacker.skills || []
      };
      attacker.updatedAt = Date.now();
      room.states.set(playerId, attacker);
    }
    room.seq = command.seq;
    room.commands.push(command);
    if (room.commands.length > 200) room.commands.shift();
    return command;
  }

  updateState(code, playerId, state) {
    const room = this.getRoom(code);
    if (!room.players.includes(playerId)) throw new Error('PLAYER_NOT_IN_ROOM');
    const previous = room.states.get(playerId) || {};
    if (previous.copyBoard && previous.copyBoard.expiresAt <= Date.now()) previous.copyBoard = null;
    const nextBoard = Array.isArray(state?.board) ? state.board : previous.board;
    const acceptsState = (Number.isFinite(state?.ackSeq) ? state.ackSeq : 0) >= (previous.stateSeq || 0);
    const previousScore = previous.score || 0;
    const requestedScore = acceptsState && Number.isFinite(state?.score) ? Math.max(previousScore, state.score) : previousScore;
    const scoreGain = Math.max(0, requestedScore - previousScore);
    const requestedEnergy = Number.isFinite(state?.energy) ? Math.max(0, Math.min(100, state.energy)) : previous.energy || 0;
    const earnedEnergyCap = scoreGain > 0 ? 100 : 0;
    const nextEnergy = acceptsState && requestedEnergy > (previous.energy || 0)
      ? Math.min(requestedEnergy, (previous.energy || 0) + earnedEnergyCap, 100)
      : previous.energy || 0;
    room.states.set(playerId, {
      score: requestedScore,
      // State snapshots report energy earned by clearing lines. Skill spending
      // is applied separately by recordCommand.
      energy: nextEnergy,
      stateSeq: previous.stateSeq || 0,
      alive: acceptsState ? state?.alive !== false : previous.alive !== false,
      reflect: previous.reflect === true,
      jammed: acceptsState ? state?.jammed === true : previous.jammed === true,
      reversed: acceptsState ? state?.reversed === true : previous.reversed === true,
      skills: Array.isArray(previous.skills) ? previous.skills : [],
      held: previous.held || null,
      predictUntil: previous.predictUntil || 0,
      copyBoard: previous.copyBoard || null,
      updatedAt: Date.now(),
      board: acceptsState ? nextBoard : previous.board,
      current: acceptsState && state?.current && Array.isArray(state.current.cells) ? {
        cells: state.current.cells,
        x: Number.isFinite(state.current.x) ? state.current.x : 0,
        y: Number.isFinite(state.current.y) ? state.current.y : 0,
        color: String(state.current.color || 'cyan')
      } : previous.current || null
    });
    if (acceptsState && state?.alive === false && room.status === 'playing') {
      room.status = 'finished';
      room.winnerId = room.players.find(id => id !== playerId) || null;
      room.ready.clear();
    }
    return this.snapshot(room.code);
  }

  snapshot(code, viewerId = '') {
    const room = this.getRoom(code);
    return {
      code: room.code,
      status: room.status,
      countdown: room.countdown,
      winnerId: room.winnerId || null,
      players: room.players.map(playerId => {
        const raw = room.states.get(playerId) || null;
        if (!raw) return { playerId, ready: room.ready.has(playerId), connected: room.clients.has(playerId), state: null };
        const state = cloneValue(raw);
        state.copyRemainingMs = Math.max(0, (raw.copyBoard?.expiresAt || 0) - Date.now());
        state.predictRemainingMs = Math.max(0, (raw.predictUntil || 0) - Date.now());
        state.copyBoard = state.copyRemainingMs > 0 ? { active: true } : null;
        if (viewerId && viewerId !== playerId) {
          state.skills = (raw.skills || []).map(() => null);
          state.copyBoard = null;
          state.copyRemainingMs = 0;
          state.held = null;
        }
        return { playerId, ready: room.ready.has(playerId), connected: room.clients.has(playerId), state };
      }),
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
      let command;
      try { message = JSON.parse(raw.toString()); } catch { send({ type: 'error', code: 'BAD_JSON' }); return; }
      try {
        if (message.type === 'create') room = manager.createRoom(playerId);
        else if (message.type === 'join') room = manager.joinRoom(message.code, playerId);
        else if (!room) throw new Error('NOT_IN_ROOM');
        else if (message.type === 'ready') room = manager.setReady(room.code, playerId);
        else if (message.type === 'start') room = manager.startRoom(room.code, playerId);
        else if (message.type === 'command') command = manager.recordCommand(room.code, playerId, message.payload);
        else if (message.type === 'state') manager.updateState(room.code, playerId, message.state);
        else throw new Error('UNKNOWN_MESSAGE');
        if (room) {
          room.clients.set(playerId, socket);
          const event = { type: message.type === 'command' ? 'command' : message.type === 'state' ? 'snapshot' : message.type === 'start' ? 'countdown' : 'room', playerId, countdown: message.type === 'start' ? 3 : undefined, payload: message.payload };
          room.clients.forEach((client, clientId) => {
            if (client.readyState !== 1) return;
            let effect = command?.effect;
            if (effect && clientId !== playerId) {
              const { hand, energy, ...publicEffect } = effect;
              effect = message.payload?.type === 'drawSkill'
                ? { cost: publicEffect.cost, drewSkill: true }
                : publicEffect;
            }
            client.send(JSON.stringify({ ...event, room: manager.snapshot(room.code, clientId), effect, selfId: clientId }));
          });
          if (message.type === 'start') {
            setTimeout(() => {
              if (room.status !== 'countdown') return;
              room.status = 'playing';
              room.countdown = 0;
              room.clients.forEach((client, clientId) => {
                if (client.readyState === 1) client.send(JSON.stringify({ type: 'room', room: manager.snapshot(room.code, clientId), selfId: clientId }));
              });
            }, 3000);
          }
        }
      } catch (error) { send({ type: 'error', code: error.message }); }
    });
    socket.on('close', () => {
      if (!room) return;
      room.clients.delete(playerId);
      room.clients.forEach((client, clientId) => {
        if (client.readyState === 1) client.send(JSON.stringify({ type: 'room', room: manager.snapshot(room.code, clientId), disconnectedId: playerId, selfId: clientId }));
      });
    });
  });
  return { httpServer, manager, wss };
}

if (require.main === module) {
  const { httpServer } = createServer({ port: Number(process.env.PORT) || 4174 });
  const port = Number(process.env.PORT) || 4174;
  httpServer.listen(port, '0.0.0.0', () => console.log(`hexa-clash server listening on ${port}`));
}

module.exports = { RoomManager, createServer };
