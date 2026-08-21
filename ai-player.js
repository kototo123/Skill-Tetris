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

function chooseBestPlacement(player, random = Math.random) {
  if (!player?.alive || !player.current?.cells || !Array.isArray(player.board?.[0])) return null;
  const width = player.board[0].length;
  let best = null;
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
      if (!best || score > best.score) best = { cells: cloneMatrix(cells), x, y, score, lines: result.lines };
    }
  });
  return best;
}

function playBestMove(player, random = Math.random) {
  const placement = chooseBestPlacement(player, random);
  if (!placement) { player.alive = false; return null; }
  player.current.cells = cloneMatrix(placement.cells);
  player.x = placement.x;
  player.y = placement.y;
  player.lock();
  return placement;
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
    gravity: player.gravity === true,
    frenzyUntil: player.frenzyUntil || 0,
    hardDropUnlocked: true,
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
  player.skills = [...(state.skills || [])];
  player.held = state.held || null;
  player.lastSkill = state.lastSkill || null;
  return player;
}

function createAiPlayer() {
  const player = new Player('KTOTO AI', 'pink');
  player.skills = [];
  player.hardDropUnlocked = true;
  return player;
}

module.exports = { chooseBestPlacement, playBestMove, stateFromPlayer, applyStateToPlayer, createAiPlayer, boardMetrics };
