const test = require('node:test');
const assert = require('node:assert/strict');
const { Player, createBoard, collides } = require('./game.js');
const { chooseBestPlacement, playBestMove, stateFromPlayer, applyStateToPlayer } = require('./ai-player.js');

test('chooses a legal supported landing', () => {
  const player = new Player('AI', 'pink');
  player.board = createBoard();
  player.current = { name: 'T', color: 'purple', cells: [[0, 1, 0], [1, 1, 1]] };
  player.x = 3;
  player.y = -1;
  const placement = chooseBestPlacement(player, () => 0.5);
  assert.equal(collides(player.board, placement.cells, placement.x, placement.y), false);
  assert.equal(collides(player.board, placement.cells, placement.x, placement.y + 1), true);
});

test('prefers completing a line over leaving the gap open', () => {
  const player = new Player('AI', 'pink');
  player.board = createBoard();
  player.board[19] = Array(10).fill('blue');
  player.board[19][4] = 0;
  player.current = { name: 'dot', color: 'cyan', cells: [[1]] };
  player.x = 3;
  player.y = -1;
  const placement = chooseBestPlacement(player, () => 0.5);
  assert.equal(placement.x, 4);
});

test('returns no placement when every landing would lock cells above the board', () => {
  const player = new Player('AI', 'pink');
  player.board = createBoard();
  player.board[0] = Array(10).fill('blue');
  player.board[0][9] = 0;
  player.board[1][9] = 'blue';
  player.current = { name: 'O', color: 'yellow', cells: [[1, 1], [1, 1]] };

  assert.equal(chooseBestPlacement(player, () => 0.5), null);
});

test('plays the selected move and serializes authoritative bot state', () => {
  const player = new Player('AI', 'pink');
  const previousName = player.current.name;
  const placement = playBestMove(player, () => 0.5);
  assert.ok(placement);
  assert.notEqual(player.current.name + player.y, previousName + '-1');
  const state = stateFromPlayer(player, 7);
  assert.equal(state.stateSeq, 7);
  assert.equal(Array.isArray(state.board), true);
  const restored = new Player('restored', 'pink');
  applyStateToPlayer(restored, { ...state, jammed: true, blockedColumn: 1, blockedUntil: Date.now() + 1000 });
  assert.deepEqual(restored.board, state.board);
  assert.equal(restored.jammed, true);
  assert.equal(restored.blockedColumn, 1);
});
