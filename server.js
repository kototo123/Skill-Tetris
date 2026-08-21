const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SHAPES } = require('./game.js');
const { createAiPlayer, playBestMove, stateFromPlayer, applyStateToPlayer } = require('./ai-player.js');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SKILL_CARDS = ['jam', 'reverse', 'swapShape', 'slam', 'zone', 'intercept', 'offset', 'mirrorBoard', 'gravity', 'cardSwap', 'reshape', 'store', 'predict', 'reflect', 'clearTop', 'copyBoard', 'drain', 'reroll', 'copy', 'gambler', 'frenzy'];
const SKILL_COSTS = { jam: 10, reverse: 10, swapShape: 25, slam: 35, zone: 20, intercept: 25, offset: 25, mirrorBoard: 50, gravity: 25, cardSwap: 30, reshape: 25, store: 15, predict: 15, reflect: 25, clearTop: 40, copyBoard: 35, drain: 15, reroll: 15, copy: 20, gambler: 10, frenzy: 20 };
const COPY_EXCLUDED = new Set(['cleanse', 'unlockHardDrop', 'copy', 'gambler']);

function baseSkill(card) { return String(card || '').split('@')[0]; }

function skillCost(card) {
  const [skill, modifier] = String(card || '').split('@');
  const base = SKILL_COSTS[skill];
  if (!base) return 0;
  if (modifier === 'discount') return Math.max(5, base - 5);
  if (modifier === 'overload') return base + 10;
  return base;
}

function gamblerCard() {
  const pool = SKILL_CARDS.filter(skill => skill !== 'gambler');
  const skill = pool[Math.floor(Math.random() * pool.length)];
  const roll = Math.random();
  const modifier = roll < 0.55 ? '' : roll < 0.75 ? 'discount' : roll < 0.9 ? 'overload' : roll < 0.98 ? 'weak' : 'gold';
  return modifier ? `${skill}@${modifier}` : skill;
}

function randomCards(count = 3) {
  return Array.from({ length: count }, () => SKILL_CARDS[Math.floor(Math.random() * SKILL_CARDS.length)]);
}

function initialState(stateSeq = 0) {
  return { score: 0, energy: 50, stateSeq, alive: true, board: null, current: null, skills: [], held: null, predictUntil: 0, reflect: false, copyBoard: null, hardDropUnlocked: false, blockedColumn: null, blockedUntil: 0, gravity: false, frenzyUntil: 0, lastSkill: null };
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
  const index = next.findIndex(card => card === skill || baseSkill(card) === skill);
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

  createAiRoom(playerId) {
    const room = this.createRoom(playerId);
    const botId = `ai-${room.code.toLowerCase()}`;
    room.isAi = true;
    room.publicCode = 'KTOTO';
    room.botId = botId;
    room.aiPlayer = createAiPlayer();
    room.players.push(botId);
    room.ready.add(botId);
    room.states.set(botId, stateFromPlayer(room.aiPlayer));
    return room;
  }

  joinRoom(code, playerId) {
    const room = this.rooms.get(String(code).toUpperCase());
    if (!room) throw new Error('ROOM_NOT_FOUND');
    if (room.players.includes(playerId)) return room;
    if (room.players.length >= 2) throw new Error('ROOM_FULL');
    if (room.status === 'finished') {
      room.status = 'waiting';
      room.winnerId = null;
      room.ready.clear();
    }
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
      if (room.isAi) room.ready.add(room.botId);
    }
    if (!['waiting', 'ready'].includes(room.status)) throw new Error('READY_NOT_ALLOWED');
    room.ready.add(playerId);
    if (room.ready.size === 2) room.status = 'ready';
    if (room.isAi && playerId !== room.botId && room.status === 'ready') this.startRoom(room.code, room.hostId);
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
    if (room.isAi) {
      room.aiPlayer = createAiPlayer();
      room.aiTickCount = 0;
      room.states.set(room.botId, stateFromPlayer(room.aiPlayer, room.seq));
    }
    room.commands = [];
    return room;
  }

  tickAiRoom(code, random = Math.random) {
    const room = this.getRoom(code);
    if (!room.isAi || room.status !== 'playing') return { placement: null, commands: [] };
    const humanId = room.players.find(id => id !== room.botId);
    const human = room.states.get(humanId);
    if (!human || human.alive === false) {
      room.status = 'finished';
      room.winnerId = room.botId;
      room.ready.clear();
      return { placement: null, commands: [] };
    }

    const botState = room.states.get(room.botId) || initialState(room.seq);
    applyStateToPlayer(room.aiPlayer, botState);
    if (room.aiPlayer.intercept) {
      room.aiPlayer.spawn();
      room.aiPlayer.intercept = false;
    }
    const placement = playBestMove(room.aiPlayer, random);
    room.aiPlayer.forceDrop = false;
    room.aiPlayer.offset = 0;
    room.aiTickCount = (room.aiTickCount || 0) + 1;
    room.states.set(room.botId, { ...botState, ...stateFromPlayer(room.aiPlayer, room.seq), skills: [...(botState.skills || [])] });

    const commands = [];
    const currentBot = () => room.states.get(room.botId);
    const tryCommand = payload => {
      try { commands.push(this.recordCommand(room.code, room.botId, payload)); } catch { /* An unavailable random card waits for a later tick. */ }
    };
    if (room.aiPlayer.alive !== false && room.aiTickCount % 3 === 1) {
      const state = currentBot();
      const danger = state.board?.slice(0, 7).some(row => row.some(Boolean));
      if (danger && (state.jammed || state.reversed || Number.isInteger(state.blockedColumn) || state.gravity) && state.energy >= 30) {
        tryCommand({ type: 'skill', skill: 'cleanse' });
      }
      const affordable = (currentBot().skills || []).find(card => skillCost(card) <= currentBot().energy);
      if (affordable) tryCommand({ type: 'skill', skill: baseSkill(affordable), card: affordable });
      else if ((currentBot().skills || []).length < 3 && currentBot().energy >= 10) tryCommand({ type: 'drawSkill' });
    }

    if (room.aiPlayer.alive === false) {
      room.status = 'finished';
      room.winnerId = humanId;
      room.ready.clear();
    }
    return { placement, commands };
  }

  removePlayer(code, playerId) {
    const room = this.getRoom(code);
    const index = room.players.indexOf(playerId);
    if (index < 0) return room;
    const wasPlaying = room.status === 'playing';
    room.players.splice(index, 1);
    room.clients.delete(playerId);
    room.states.delete(playerId);
    room.ready.delete(playerId);
    if (room.isAi && playerId !== room.botId) {
      this.rooms.delete(room.code);
      return null;
    }
    if (!room.players.length) {
      this.rooms.delete(room.code);
      return null;
    }
    if (room.hostId === playerId) room.hostId = room.players[0];
    room.ready.clear();
    room.countdown = 0;
    room.status = wasPlaying ? 'finished' : 'waiting';
    room.winnerId = wasPlaying ? room.players[0] : null;
    return room;
  }

  recordCommand(code, playerId, payload) {
    const room = this.getRoom(code);
    if (!room.players.includes(playerId)) throw new Error('PLAYER_NOT_IN_ROOM');
    if (room.status !== 'playing') throw new Error('MATCH_NOT_PLAYING');
    if (!payload || !['move', 'rotate', 'softDrop', 'hardDrop', 'skill', 'drawSkill', 'reportOpponentLoss'].includes(payload.type)) throw new Error('INVALID_COMMAND');
    if (payload.type === 'move' && ![-1, 1].includes(payload.direction)) throw new Error('INVALID_DIRECTION');
    if (payload.type === 'hardDrop' && !(room.states.get(playerId)?.hardDropUnlocked)) throw new Error('HARD_DROP_LOCKED');
    const command = { seq: room.seq + 1, playerId, payload, at: Date.now() };
    if (payload.type === 'reportOpponentLoss') {
      const opponentId = room.players.find(id => id !== playerId);
      const opponent = opponentId ? room.states.get(opponentId) : null;
      if (!opponentId || !opponent || opponent.alive === false) throw new Error('OPPONENT_NOT_ACTIVE');
      if (Date.now() - (opponent.updatedAt || 0) < 500) throw new Error('OPPONENT_STATE_FRESH');
      opponent.alive = false;
      opponent.updatedAt = Date.now();
      room.states.set(opponentId, opponent);
      room.status = 'finished';
      room.winnerId = playerId;
      room.ready.clear();
      command.effect = { opponentLost: true, targetId: opponentId };
    }
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
      const attacker = room.states.get(playerId) || {};
      const opponentId = room.players.find(id => id !== playerId);
      const opponent = opponentId ? room.states.get(opponentId) : null;
      const fixedSkill = ['cleanse', 'unlockHardDrop'].includes(payload.skill);
      const ownedCard = fixedSkill ? payload.skill : (attacker.skills || []).find(card => {
        if (payload.card) return card === payload.card && baseSkill(card) === payload.skill;
        return baseSkill(card) === payload.skill;
      });
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
      if (payload.skill === 'unlockHardDrop' && attacker.hardDropUnlocked) throw new Error('HARD_DROP_ALREADY_UNLOCKED');
      if (!fixedSkill && !SKILL_COSTS[payload.skill]) throw new Error('INVALID_SKILL');
      if (!fixedSkill && !ownedCard) throw new Error('SKILL_NOT_OWNED');
      let resolvedSkill = payload.skill;
      if (payload.skill === 'copy') {
        if (!opponent?.lastSkill || COPY_EXCLUDED.has(opponent.lastSkill)) throw new Error('NOTHING_TO_COPY');
        resolvedSkill = opponent.lastSkill;
      }
      const modifier = String(ownedCard || '').split('@')[1] || '';
      const weak = modifier === 'weak';
      const gold = modifier === 'gold';
      const remainingSkills = fixedSkill ? (attacker.skills || []) : consumeOne(attacker.skills, ownedCard);
      if (resolvedSkill === 'cardSwap' && (!remainingSkills.length || !(opponent?.skills || []).length)) throw new Error('CARD_SWAP_UNAVAILABLE');
      const cost = payload.skill === 'cleanse' ? 30 : payload.skill === 'unlockHardDrop' ? 80 : skillCost(ownedCard);
      if (!cost) throw new Error('INVALID_SKILL');
      if ((attacker.energy || 0) < cost) throw new Error('INSUFFICIENT_ENERGY');
      attacker.energy -= cost;
      attacker.stateSeq = command.seq;
      if (!fixedSkill) attacker.skills = remainingSkills;
      if (resolvedSkill === 'reflect') attacker.reflect = true;
      if (resolvedSkill === 'cleanse') {
        attacker.jammed = false;
        attacker.reversed = false;
        attacker.blockedColumn = null;
        attacker.blockedUntil = 0;
        attacker.gravity = false;
      }
      if (resolvedSkill === 'unlockHardDrop') attacker.hardDropUnlocked = true;
      let blocked = false;
      let reflected = false;
      let drained = 0;
      let effectTargetId = playerId;
      const attackSkill = ['jam', 'reverse', 'swapShape', 'slam', 'zone', 'intercept', 'offset', 'mirrorBoard', 'gravity', 'drain'].includes(resolvedSkill);
      let target = attacker;
      if (opponentId && attackSkill) {
        if (opponent.reflect) {
          opponent.reflect = false;
          blocked = true;
          reflected = true;
          effectTargetId = playerId;
          target = attacker;
        } else {
          effectTargetId = opponentId;
          target = opponent;
        }
        if (resolvedSkill === 'jam') target.jammed = true;
        else if (resolvedSkill === 'reverse') target.reversed = true;
        else if (resolvedSkill === 'slam') target.forceDrop = true;
        else if (resolvedSkill === 'zone') {
          const edgeColumns = [0, 1, 2, 7, 8, 9];
          target.blockedColumn = edgeColumns[Math.floor(Math.random() * edgeColumns.length)];
          target.blockedUntil = Date.now() + 15000;
        }
        else if (resolvedSkill === 'intercept') target.intercept = true;
        else if (resolvedSkill === 'offset') target.offset = (Math.random() < 0.5 ? -1 : 1) * (weak ? 1 : gold ? 3 : 2);
        else if (resolvedSkill === 'gravity') target.gravity = true;
        else if (resolvedSkill === 'mirrorBoard' && Array.isArray(target.board)) {
          const weakCopy = payload.skill === 'copy' && (SKILL_COSTS[resolvedSkill] || 0) >= 40;
          const split = weakCopy ? Math.max(0, target.board.length - 10) : 0;
          target.board = [...target.board.slice(0, split), ...target.board.slice(split).map(row => row.slice().reverse())];
        } else if (resolvedSkill === 'drain') {
          const receiver = target === attacker ? opponent : attacker;
          drained = Math.min(weak ? 5 : gold ? 15 : 10, target.energy || 0);
          target.energy = Math.max(0, (target.energy || 0) - drained);
          receiver.energy = Math.min(100, (receiver.energy || 0) + drained);
        } else if (resolvedSkill === 'swapShape') {
          const own = cloneValue(attacker.current);
          const other = cloneValue(opponent.current);
          attacker.current = fitPieceToBoard(attacker.board, other, own);
          opponent.current = fitPieceToBoard(opponent.board, own, other);
        }
        opponent.updatedAt = Date.now();
        opponent.stateSeq = command.seq;
        room.states.set(opponentId, opponent);
      }
      if (resolvedSkill === 'cardSwap') {
        const ownIndex = Math.floor(Math.random() * attacker.skills.length);
        const otherIndex = Math.floor(Math.random() * opponent.skills.length);
        [attacker.skills[ownIndex], opponent.skills[otherIndex]] = [opponent.skills[otherIndex], attacker.skills[ownIndex]];
        opponent.updatedAt = Date.now();
        room.states.set(opponentId, opponent);
      }
      if (resolvedSkill === 'reshape' && Array.isArray(attacker.board)) attacker.board = reshapeBottom(attacker.board);
      if (resolvedSkill === 'store') attacker.store = true;
      const predictDurationMs = weak ? 5000 : gold ? 12000 : 8000;
      const frenzyDurationMs = weak ? 4000 : gold ? 9000 : 6000;
      if (resolvedSkill === 'predict') attacker.predictUntil = Date.now() + predictDurationMs;
      if (resolvedSkill === 'clearTop' && Array.isArray(attacker.board)) attacker.board = clearHighestOccupiedRow(attacker.board);
      if (resolvedSkill === 'copyBoard') attacker.copyBoard = { board: cloneValue(attacker.board), current: cloneValue(attacker.current), expiresAt: Date.now() + 5000 };
      if (resolvedSkill === 'reroll') {
        const currentSignature = JSON.stringify(attacker.current?.cells || []);
        const choices = SHAPES.filter(shape => JSON.stringify(shape.cells) !== currentSignature);
        const shape = choices[Math.floor(Math.random() * choices.length)];
        attacker.current = fitPieceToBoard(attacker.board, { cells: cloneValue(shape.cells), color: shape.color }, attacker.current);
      }
      if (resolvedSkill === 'gambler') attacker.skills.push(gamblerCard());
      if (resolvedSkill === 'frenzy') attacker.frenzyUntil = Date.now() + frenzyDurationMs;
      if (!COPY_EXCLUDED.has(resolvedSkill)) attacker.lastSkill = resolvedSkill;
      command.effect = {
        skill: payload.skill,
        executedSkill: resolvedSkill,
        copiedSkill: payload.skill === 'copy' ? resolvedSkill : undefined,
        targetId: attackSkill ? effectTargetId : playerId,
        cost,
        energy: attacker.energy,
        blocked,
        reflected,
        modifier,
        weak,
        gold,
        jammed: resolvedSkill === 'jam',
        reversed: resolvedSkill === 'reverse',
        cleanse: resolvedSkill === 'cleanse' ? 2 : 0,
        forceDrop: resolvedSkill === 'slam',
        blockedColumn: resolvedSkill === 'zone' ? target.blockedColumn : undefined,
        blockedDurationMs: resolvedSkill === 'zone' ? 15000 : 0,
        intercept: resolvedSkill === 'intercept',
        offset: resolvedSkill === 'offset' ? target.offset : undefined,
        gravity: resolvedSkill === 'gravity',
        mirrorBoard: resolvedSkill === 'mirrorBoard',
        drained,
        cardSwap: resolvedSkill === 'cardSwap',
        hardDropUnlocked: resolvedSkill === 'unlockHardDrop',
        reroll: resolvedSkill === 'reroll',
        gambler: resolvedSkill === 'gambler',
        frenzyDurationMs: resolvedSkill === 'frenzy' ? frenzyDurationMs : 0,
        swapShape: resolvedSkill === 'swapShape',
        reshape: resolvedSkill === 'reshape',
        store: resolvedSkill === 'store',
        predictUntil: attacker.predictUntil || 0,
        predictDurationMs: resolvedSkill === 'predict' ? predictDurationMs : 0,
        reflect: resolvedSkill === 'reflect',
        clearTop: resolvedSkill === 'clearTop',
        copyArmed: resolvedSkill === 'copyBoard',
        copyExpiresAt: attacker.copyBoard?.expiresAt || 0,
        copyDurationMs: resolvedSkill === 'copyBoard' ? 5000 : 0,
        board: ['reshape', 'clearTop'].includes(resolvedSkill) ? cloneValue(attacker.board) : resolvedSkill === 'mirrorBoard' ? cloneValue(target.board) : undefined,
        current: ['store', 'reroll'].includes(resolvedSkill) ? cloneValue(attacker.current) : undefined,
        players: resolvedSkill === 'swapShape' ? {
          [playerId]: { current: cloneValue(attacker.current) },
          [opponentId]: { current: cloneValue(opponent?.current) }
        } : undefined,
        hand: attacker.skills || [],
        hands: resolvedSkill === 'cardSwap' ? { [playerId]: attacker.skills || [], [opponentId]: opponent.skills || [] } : undefined,
        energies: resolvedSkill === 'drain' ? { [playerId]: attacker.energy, [opponentId]: opponent.energy } : undefined
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
    const blockActive = Number.isInteger(previous.blockedColumn) && (previous.blockedUntil || 0) > Date.now();
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
      hardDropUnlocked: previous.hardDropUnlocked === true,
      blockedColumn: blockActive ? previous.blockedColumn : null,
      blockedUntil: blockActive ? previous.blockedUntil : 0,
      gravity: acceptsState ? state?.gravity === true : previous.gravity === true,
      frenzyUntil: previous.frenzyUntil || 0,
      lastSkill: previous.lastSkill || null,
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
      code: room.publicCode || room.code,
      status: room.status,
      countdown: room.countdown,
      winnerId: room.winnerId || null,
      players: room.players.map(playerId => {
        const raw = room.states.get(playerId) || null;
        if (!raw) return { playerId, ready: room.ready.has(playerId), connected: playerId === room.botId || room.clients.has(playerId), state: null };
        const state = cloneValue(raw);
        state.copyRemainingMs = Math.max(0, (raw.copyBoard?.expiresAt || 0) - Date.now());
        state.predictRemainingMs = Math.max(0, (raw.predictUntil || 0) - Date.now());
        state.frenzyRemainingMs = Math.max(0, (raw.frenzyUntil || 0) - Date.now());
        state.blockedRemainingMs = Math.max(0, (raw.blockedUntil || 0) - Date.now());
        if (state.blockedRemainingMs <= 0) state.blockedColumn = null;
        state.copyBoard = state.copyRemainingMs > 0 ? { active: true } : null;
        if (viewerId && viewerId !== playerId) {
          state.skills = (raw.skills || []).map(() => null);
          state.copyBoard = null;
          state.copyRemainingMs = 0;
          state.held = null;
        }
        return { playerId, ready: room.ready.has(playerId), connected: playerId === room.botId || room.clients.has(playerId), state };
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
  const heartbeat = setInterval(() => {
    wss.clients.forEach(client => {
      if (client.isAlive === false) { client.terminate(); return; }
      client.isAlive = false;
      client.ping();
    });
  }, 10000);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));
  wss.on('connection', socket => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    let playerId = `guest-${Math.random().toString(36).slice(2, 8)}`;
    let room;
    const send = message => socket.send(JSON.stringify(message));
    const broadcast = (targetRoom, eventType, actorId, payload, command) => {
      targetRoom.clients.forEach((client, clientId) => {
        if (client.readyState !== 1) return;
        let effect = command?.effect;
        if (effect) {
          const privateHand = effect.hands?.[clientId] || (clientId === actorId ? effect.hand : undefined);
          const privateEnergy = effect.energies?.[clientId] ?? (clientId === actorId ? effect.energy : undefined);
          const { hand, hands, energy, energies, ...publicEffect } = effect;
          effect = payload?.type === 'drawSkill' && clientId !== actorId
            ? { cost: publicEffect.cost, drewSkill: true }
            : { ...publicEffect, hand: privateHand, energy: privateEnergy };
        }
        client.send(JSON.stringify({ type: eventType, playerId: actorId, countdown: eventType === 'countdown' ? 3 : undefined, payload, room: manager.snapshot(targetRoom.code, clientId), effect, selfId: clientId }));
      });
    };
    const stopAi = targetRoom => {
      if (targetRoom?.aiTimer) { clearInterval(targetRoom.aiTimer); targetRoom.aiTimer = null; }
    };
    const startAi = targetRoom => {
      if (!targetRoom?.isAi || targetRoom.aiTimer) return;
      targetRoom.aiTimer = setInterval(() => {
        if (!manager.rooms.has(targetRoom.code) || targetRoom.status !== 'playing') { stopAi(targetRoom); return; }
        const result = manager.tickAiRoom(targetRoom.code);
        result.commands.forEach(command => broadcast(targetRoom, 'command', command.playerId, command.payload, command));
        broadcast(targetRoom, 'snapshot', targetRoom.botId);
        if (targetRoom.status === 'finished') { stopAi(targetRoom); broadcast(targetRoom, 'room', targetRoom.botId); }
      }, 1100);
      targetRoom.aiTimer.unref?.();
    };
    const scheduleStart = targetRoom => {
      if (targetRoom.startTimer) clearTimeout(targetRoom.startTimer);
      targetRoom.startTimer = setTimeout(() => {
        targetRoom.startTimer = null;
        if (!manager.rooms.has(targetRoom.code) || targetRoom.status !== 'countdown') return;
        targetRoom.status = 'playing';
        targetRoom.countdown = 0;
        targetRoom.clients.forEach((client, clientId) => { if (client.readyState === 1) client.send(JSON.stringify({ type: 'room', room: manager.snapshot(targetRoom.code, clientId), selfId: clientId })); });
        startAi(targetRoom);
      }, 3000);
      targetRoom.startTimer.unref?.();
    };
    socket.on('message', raw => {
      let message;
      let command;
      try { message = JSON.parse(raw.toString()); } catch { send({ type: 'error', code: 'BAD_JSON' }); return; }
      try {
        if (message.type === 'create') room = manager.createRoom(playerId);
        else if (message.type === 'join') room = String(message.code || '').trim().toUpperCase() === 'KTOTO'
          ? manager.createAiRoom(playerId)
          : manager.joinRoom(message.code, playerId);
        else if (message.type === 'leave') {
          if (!room) throw new Error('NOT_IN_ROOM');
          stopAi(room);
          if (room.startTimer) { clearTimeout(room.startTimer); room.startTimer = null; }
          const updatedRoom = manager.removePlayer(room.code, playerId);
          if (updatedRoom) {
            updatedRoom.clients.forEach((client, clientId) => {
              if (client.readyState === 1) client.send(JSON.stringify({ type: 'room', room: manager.snapshot(updatedRoom.code, clientId), disconnectedId: playerId, selfId: clientId }));
            });
          }
          room = null;
          send({ type: 'left' });
          return;
        }
        else if (!room) throw new Error('NOT_IN_ROOM');
        else if (message.type === 'ready') room = manager.setReady(room.code, playerId);
        else if (message.type === 'start') room = manager.startRoom(room.code, playerId);
        else if (message.type === 'command') command = manager.recordCommand(room.code, playerId, message.payload);
        else if (message.type === 'state') manager.updateState(room.code, playerId, message.state);
        else throw new Error('UNKNOWN_MESSAGE');
        if (room) {
          room.clients.set(playerId, socket);
          const eventType = message.type === 'command' ? 'command' : message.type === 'state' ? 'snapshot' : room.status === 'countdown' ? 'countdown' : 'room';
          broadcast(room, eventType, playerId, message.payload, command);
          if (room.status === 'countdown') scheduleStart(room);
        }
      } catch (error) { send({ type: 'error', code: error.message }); }
    });
    socket.on('close', () => {
      if (!room) return;
      stopAi(room);
      if (room.startTimer) clearTimeout(room.startTimer);
      room = manager.removePlayer(room.code, playerId);
      if (!room) return;
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
