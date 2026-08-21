(function (root) {
  const SHAPES = [
    { name: 'I', color: 'cyan', cells: [[1, 1, 1, 1]] },
    { name: 'O', color: 'yellow', cells: [[1, 1], [1, 1]] },
    { name: 'T', color: 'purple', cells: [[0, 1, 0], [1, 1, 1]] },
    { name: 'L', color: 'orange', cells: [[1, 0, 0], [1, 1, 1]] },
    { name: 'J', color: 'blue', cells: [[0, 0, 1], [1, 1, 1]] },
    { name: 'S', color: 'green', cells: [[0, 1, 1], [1, 1, 0]] },
    { name: 'Z', color: 'red', cells: [[1, 1, 0], [0, 1, 1]] },
  ];

  function createBoard(width = 10, height = 20) {
    return Array.from({ length: height }, () => Array(width).fill(0));
  }

  function rotate(matrix) {
    return matrix[0].map((_, x) => matrix.map(row => row[x]).reverse());
  }

  function rotateCounterClockwise(matrix) {
    return matrix[0].map((_, x) => matrix.map(row => row[row.length - 1 - x]));
  }

  function collides(board, piece, x, y) {
    return piece.some((row, dy) => row.some((cell, dx) => {
      if (!cell) return false;
      const bx = x + dx;
      const by = y + dy;
      return bx < 0 || bx >= board[0].length || by >= board.length || (by >= 0 && board[by][bx]);
    }));
  }

  function mergePiece(board, piece, x, y, value = 1) {
    const result = board.map(row => row.slice());
    piece.forEach((row, dy) => row.forEach((cell, dx) => {
      if (cell && y + dy >= 0 && result[y + dy]) result[y + dy][x + dx] = value;
    }));
    return result;
  }

  function clearLines(board) {
    const width = board[0].length;
    const remaining = board.filter(row => !row.every(Boolean));
    const lines = board.length - remaining.length;
    while (remaining.length < board.length) remaining.unshift(Array(width).fill(0));
    return { board: remaining, lines };
  }

  function addGarbageLines(board, count = 1, hole = Math.floor(Math.random() * board[0].length)) {
    const width = board[0].length;
    const result = board.slice(count).map(row => row.slice());
    for (let i = 0; i < count; i += 1) {
      const row = Array(width).fill(8);
      row[(hole + i) % width] = 0;
      result.push(row);
    }
    return result;
  }

  function canUseSkill(energy, cost) { return energy >= cost; }

  function collidesForPlayer(player, piece, x, y) {
    if (collides(player.board, piece, x, y)) return true;
    if (player.blockedUntil > 0 && player.blockedUntil <= Date.now()) {
      player.blockedColumn = null;
      player.blockedUntil = 0;
    }
    if (!Number.isInteger(player.blockedColumn)) return false;
    return piece.some(row => row.some((cell, dx) => cell && x + dx === player.blockedColumn));
  }

  function randomShape() {
    const shape = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    return { ...shape, cells: shape.cells.map(row => row.slice()) };
  }

  class Player {
    constructor(name, color) {
      this.name = name;
      this.color = color;
      this.board = createBoard();
      this.current = randomShape();
      this.nextQueue = [randomShape(), randomShape(), randomShape()];
      this.next = this.nextQueue[0];
      this.x = 3;
      this.y = -1;
      this.energy = 50;
      this.score = 0;
      this.combo = 0;
      this.alive = true;
      this.shield = false;
      this.jammed = false;
      this.blockedColumn = null;
      this.blockedUntil = 0;
      this.gravity = false;
      this.frenzyUntil = 0;
      this.hardDropUnlocked = false;
      this.dropInterval = 760;
      this.lastDrop = 0;
    }

    spawn() {
      this.current = this.nextQueue.shift();
      this.nextQueue.push(randomShape());
      this.next = this.nextQueue[0];
      this.x = Math.floor((10 - this.current.cells[0].length) / 2);
      this.y = -1;
      if (collides(this.board, this.current.cells, this.x, this.y)) this.alive = false;
    }

    move(dx) { if (!collidesForPlayer(this, this.current.cells, this.x + dx, this.y)) this.x += dx; }
    rotate() {
      if (this.jammed) return;
      const next = rotate(this.current.cells);
      if (!collidesForPlayer(this, next, this.x, this.y)) this.current.cells = next;
    }
    rotateReverse() {
      if (this.jammed) return;
      const next = rotateCounterClockwise(this.current.cells);
      if (!collidesForPlayer(this, next, this.x, this.y)) this.current.cells = next;
    }
    softDrop() { if (!collides(this.board, this.current.cells, this.x, this.y + 1)) { this.y += 1; return true; } return false; }
    hardDrop() { while (this.softDrop()) this.score += 2; this.lock(); }
    lock() {
      this.board = mergePiece(this.board, this.current.cells, this.x, this.y, this.current.color);
      const result = clearLines(this.board);
      this.board = result.board;
      if (result.lines) {
        this.combo += 1;
        this.score += [0, 100, 250, 500, 900][result.lines] || 1200;
        this.energy = Math.min(100, this.energy + result.lines * 18 + this.combo * 4);
        if (this.frenzyUntil > Date.now()) this.energy = Math.min(100, this.energy + result.lines * 12);
      } else this.combo = 0;
      this.gravity = false;
      this.spawn();
      this.jammed = false;
      this.reversed = false;
      return result.lines;
    }
  }

  function advancePlayer(player, elapsed, maxSteps = 120) {
    if (!player || !player.alive) return 0;
    player.lastDrop += Math.max(0, Number(elapsed) || 0);
    let steps = 0;
    while (player.alive && player.lastDrop >= player.dropInterval && steps < maxSteps) {
      player.lastDrop -= player.dropInterval;
      if (!player.softDrop()) player.lock();
      steps += 1;
    }
    return steps;
  }

  const api = { SHAPES, createBoard, rotate, rotateCounterClockwise, collides, mergePiece, clearLines, addGarbageLines, canUseSkill, randomShape, Player, advancePlayer };
  if (typeof module !== 'undefined') module.exports = api;
  root.HexGame = api;
})(typeof window !== 'undefined' ? window : globalThis);
