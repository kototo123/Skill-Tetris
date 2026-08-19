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
      this.next = randomShape();
      this.x = 3;
      this.y = -1;
      this.energy = 20;
      this.score = 0;
      this.combo = 0;
      this.alive = true;
      this.shield = false;
      this.jammed = false;
      this.dropInterval = 760;
      this.lastDrop = 0;
    }

    spawn() {
      this.current = this.next;
      this.next = randomShape();
      this.x = Math.floor((10 - this.current.cells[0].length) / 2);
      this.y = -1;
      if (collides(this.board, this.current.cells, this.x, this.y)) this.alive = false;
    }

    move(dx) { if (!collides(this.board, this.current.cells, this.x + dx, this.y)) this.x += dx; }
    rotate() {
      if (this.jammed) return;
      const next = rotate(this.current.cells);
      if (!collides(this.board, next, this.x, this.y)) this.current.cells = next;
    }
    rotateReverse() {
      if (this.jammed) return;
      const next = rotateCounterClockwise(this.current.cells);
      if (!collides(this.board, next, this.x, this.y)) this.current.cells = next;
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
      } else this.combo = 0;
      this.spawn();
      this.jammed = false;
      this.reversed = false;
      return result.lines;
    }
  }

  const api = { SHAPES, createBoard, rotate, rotateCounterClockwise, collides, mergePiece, clearLines, addGarbageLines, canUseSkill, randomShape, Player };
  if (typeof module !== 'undefined') module.exports = api;
  root.HexGame = api;
})(typeof window !== 'undefined' ? window : globalThis);
