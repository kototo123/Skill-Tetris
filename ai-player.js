const { Player, collides, mergePiece, clearLines, rotate } = require('./game.js');

function cloneMatrix(matrix) { return matrix.map(row => row.slice()); }

function rotationsOf(cells, locked = false) {
  const rotations = [];
  let current = cloneMatrix(cells);
  const count = locked ? 1 : 4;
  for (let index = 0; index < count; index += 1) {
    const signature = JSON.stringify(current);
    if (!rotations.some(item => item.signature === signature)) rotations.push({ signature, cells: cloneMatrix(current) });
    current = rotate(current);
  }
  return rotations.map(item => item.cells);
}

function boardMetrics(board) {
  const width = board[0].length;
  const height = board.length;
  const heights = [];
  let holes = 0;
  for (let x = 0; x < width; x += 1) {
    let first = height;
    let occupiedSeen = false;
    for (let y = 0; y < height; y += 1) {
      if (board[y][x]) {
        if (!occupiedSeen) first = y;
        occupiedSeen = true;
      } else if (occupiedSeen) holes += 1;
    }
    heights.push(height - first);
  }
  let bumpiness = 0;
  for (let index = 1; index < heights.length; index += 1) bumpiness += Math.abs(heights[index] - heights[index - 1]);
  return {
    holes,
    aggregateHeight: heights.reduce((sum, value) => sum + value, 0),
    maximumHeight: Math.max(...heights),
    bumpiness
  };
}

function placementScore(board, lines, random) {
  const metrics = boardMetrics(board);
  return lines * 1100
    - metrics.holes * 95
    - metrics.aggregateHeight * 4.5
    - metrics.maximumHeight * 14
    - metrics.bumpiness * 3.5
    + (random() - 0.5) * 6;
}

function choosePlacements(player, random = Math.random, limit = 8) {
  if (!player?.alive || !player.current?.cells || !Array.isArray(player.board?.[0])) return null;
  const width = player.board[0].length;
  const placements = [];
  rotationsOf(player.current.cells, player.jammed === true).forEach(cells => {
    const pieceWidth = cells[0].length;
    for (let x = 0; x <= width - pieceWidth; x += 1) {
      if (Number.isInteger(player.blockedColumn) && cells.some(row => row.some((value, dx) => value && x + dx === player.blockedColumn))) continue;
      let y = -cells.length;
      while (!collides(player.board, cells, x, y + 1)) y += 1;
      if (collides(player.board, cells, x, y)) continue;
      if (y < 0) continue;
      const merged = mergePiece(player.board, cells, x, y, player.current.color);
      const result = clearLines(merged);
      const score = placementScore(result.board, result.lines, random);
      placements.push({ cells: cloneMatrix(cells), x, y, score, lines: result.lines });
    }
  });
  placements.sort((a, b) => b.score - a.score);
  return placements.slice(0, Math.max(1, limit));
}

function chooseBestPlacement(player, random = Math.random) {
  const placements = choosePlacements(player, random, 1);
  return placements?.[0] || null;
}

// Returns the rotation index (0..3) of `cells` within the rotation set of `current.cells`.
function rotationIndexOf(currentCells, targetCells) {
  const rotations = rotationsOf(currentCells, false);
  const targetSig = JSON.stringify(targetCells);
  return rotations.findIndex(item => JSON.stringify(item) === targetSig);
}

const AI_DROP_INTERVAL_TICKS = 5;
const AI_REACTION_DELAY_TICKS = 7;

function createAiContext() {
  return { target: null, targetFresh: false, dropCooldown: 0, reactionCooldown: AI_REACTION_DELAY_TICKS };
}

function ensureAiTarget(player, context, random) {
  if (!context.targetFresh || !context.target) {
    let placement;
    if (player.aiDisruptedUntil > Date.now()) {
      const candidates = choosePlacements(player, random, 3) || [];
      placement = candidates[Math.floor(random() * Math.min(candidates.length, 2))] || candidates[0];
    } else {
      placement = chooseBestPlacement(player, random);
    }
    context.target = placement;
    context.targetFresh = true;
    if (!placement) player.alive = false;
  }
  return context.target;
}

// Performs one step toward the placement locked for this piece.
function aiStep(player, random = Math.random, context = createAiContext()) {
  if (!player?.alive || !player.current?.cells || !Array.isArray(player.board?.[0])) return { action: 'dead' };
  if (context.pieceName && context.pieceName !== player.current.name) {
    context.pieceName = player.current.name;
    context.target = null;
    context.targetFresh = false;
    context.reactionCooldown = AI_REACTION_DELAY_TICKS;
  } else if (!context.pieceName) {
    context.pieceName = player.current.name;
  }
  if (player.forceDrop) {
    player.hardDrop();
    player.forceDrop = false;
    context.target = null;
    context.targetFresh = false;
    context.dropCooldown = 0;
    context.reactionCooldown = AI_REACTION_DELAY_TICKS;
    return { action: 'forceDrop' };
  }
  if (Number.isFinite(player.offset) && player.offset !== 0) {
    const step = Math.sign(player.offset);
    const distance = Math.abs(player.offset);
    for (let index = 0; index < distance; index += 1) player.move(step);
    player.offset = 0;
    context.target = null;
    context.targetFresh = false;
    context.reactionCooldown = AI_REACTION_DELAY_TICKS;
    return { action: 'offset' };
  }
  if (context.reactionCooldown > 0) {
    if (player.y < 0 && !chooseBestPlacement(player, random)) {
      player.alive = false;
      return { action: 'dead' };
    }
    context.reactionCooldown -= 1;
    return { action: 'wait' };
  }
  const placement = ensureAiTarget(player, context, random);
  if (!placement) { player.alive = false; return { action: 'dead' }; }
  const rotIdx = rotationIndexOf(player.current.cells, placement.cells);
  const needsRotate = rotIdx > 0;
  const needsMove = player.x !== placement.x;
  const reversed = player.reversed === true;
  if (needsRotate && !player.jammed) {
    if (reversed) player.rotateReverse();
    else player.rotate();
    return { action: 'rotate' };
  }
  if (needsMove) {
    const dx = placement.x > player.x ? 1 : -1;
    player.move(reversed ? -dx : dx);
    return { action: 'move' };
  }
  if (player.gravity) context.dropCooldown = Math.max(0, context.dropCooldown - 2);
  if (context.dropCooldown > 0) {
    context.dropCooldown -= 1;
    return { action: 'wait' };
  }
  if (player.softDrop()) {
    context.dropCooldown = AI_DROP_INTERVAL_TICKS;
    return { action: 'drop' };
  }
  player.lock();
  context.target = null;
  context.targetFresh = false;
  context.dropCooldown = 0;
  context.reactionCooldown = AI_REACTION_DELAY_TICKS;
  return { action: 'lock' };
}

// Legacy: used by tests that need a complete placement in one call.
function playBestMove(player, random = Math.random) {
  const context = createAiContext();
  while (player.alive && player.current?.cells) {
    const result = aiStep(player, random, context);
    if (!result || result.action === 'dead') { player.alive = false; return null; }
    if (result.action === 'lock') return { x: player.x, y: player.y };
  }
  return null;
}

function stateFromPlayer(player, stateSeq = 0) {
  return {
    score: player.score,
    energy: player.energy,
    stateSeq,
    alive: player.alive !== false,
    board: player.board.map(row => row.slice()),
    current: player.current ? { name: player.current.name, cells: cloneMatrix(player.current.cells), x: player.x, y: player.y, color: player.current.color } : null,
    skills: [...(player.skills || [])],
    jammed: player.jammed === true,
    reversed: player.reversed === true,
    reflect: player.reflect === true,
    blockedColumn: Number.isInteger(player.blockedColumn) ? player.blockedColumn : null,
    blockedUntil: player.blockedUntil || 0,
    aiDisruptedUntil: player.aiDisruptedUntil || 0,
    gravity: player.gravity === true,
    frenzyUntil: player.frenzyUntil || 0,
    hardDropUnlocked: player.hardDropUnlocked === true,
    predictUntil: 0,
    copyBoard: null,
    held: player.held || null,
    lastSkill: player.lastSkill || null,
    forceDrop: player.forceDrop === true,
    intercept: player.intercept === true,
    offset: Number.isFinite(player.offset) ? player.offset : 0,
    updatedAt: Date.now()
  };
}

function applyStateToPlayer(player, state) {
  if (!player || !state) return player;
  if (Array.isArray(state.board)) player.board = state.board.map(row => row.slice());
  if (state.current?.cells) {
    player.current = { name: state.current.name || 'AI', cells: cloneMatrix(state.current.cells), color: state.current.color || 'pink' };
    player.x = Number.isFinite(state.current.x) ? state.current.x : player.x;
    player.y = Number.isFinite(state.current.y) ? state.current.y : player.y;
  }
  ['score', 'energy', 'blockedUntil', 'frenzyUntil'].forEach(key => { if (Number.isFinite(state[key])) player[key] = state[key]; });
  ['alive', 'jammed', 'reversed', 'reflect', 'gravity', 'forceDrop', 'intercept'].forEach(key => { if (typeof state[key] === 'boolean') player[key] = state[key]; });
  player.offset = Number.isFinite(state.offset) ? state.offset : 0;
  player.blockedColumn = Number.isInteger(state.blockedColumn) ? state.blockedColumn : null;
  player.aiDisruptedUntil = Number.isFinite(state.aiDisruptedUntil) ? state.aiDisruptedUntil : 0;
  player.skills = [...(state.skills || [])];
  player.held = state.held || null;
  player.lastSkill = state.lastSkill || null;
  return player;
}

function createAiPlayer() {
  const player = new Player('KTOTO AI', 'pink');
  player.skills = [];
  player.hardDropUnlocked = false;
  player.aiDisruptedUntil = 0;
  return player;
}

module.exports = {
  chooseBestPlacement,
  choosePlacements,
  playBestMove,
  aiStep,
  createAiContext,
  AI_DROP_INTERVAL_TICKS,
  AI_REACTION_DELAY_TICKS,
  stateFromPlayer,
  applyStateToPlayer,
  createAiPlayer,
  boardMetrics
};
