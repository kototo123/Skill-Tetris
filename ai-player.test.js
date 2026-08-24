const test = require('node:test');
const assert = require('node:assert/strict');
const { Player, createBoard, collides } = require('./game.js');
const { chooseBestPlacement, playBestMove, aiStep, createAiContext, stateFromPlayer, applyStateToPlayer } = require('./ai-player.js');

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

test('locks the selected target column and stops horizontal movement once reached', () => {
  const player = new Player('AI', 'pink');
  player.board = createBoard();
  player.current = { name: 'I', color: 'cyan', cells: [[1, 1, 1, 1]] };
  player.x = 0;
  player.y = 18;
  const context = createAiContext();
  context.reactionCooldown = 0;
  context.target = { cells: cloneCells(player.current.cells), x: 6, y: 19 };
  context.targetFresh = true;
  context.dropCooldown = 99;

  const first = aiStep(player, () => 0.5, context);
  assert.equal(first.action, 'move');
  assert.equal(player.x, 1);

  player.x = 6;
  player.y = 10;
  const second = aiStep(player, () => 0.5, context);
  assert.equal(second.action, 'wait');
  assert.equal(player.x, 6);
  assert.equal(player.y, 10);
});

test('throttles soft drops instead of dropping every ai tick', () => {
  const player = new Player('AI', 'pink');
  player.board = createBoard();
  player.current = { name: 'I', color: 'cyan', cells: [[1, 1, 1, 1]] };
  player.x = 3;
  player.y = 5;
  const context = createAiContext();
  context.reactionCooldown = 0;
  context.target = { cells: cloneCells(player.current.cells), x: 3, y: 19 };
  context.targetFresh = true;
  context.dropCooldown = 2;

  const first = aiStep(player, () => 0.5, context);
  assert.equal(first.action, 'wait');
  assert.equal(player.y, 5);
  const second = aiStep(player, () => 0.5, context);
  assert.equal(second.action, 'wait');
  assert.equal(player.y, 5);
  const third = aiStep(player, () => 0.5, context);
  assert.equal(third.action, 'drop');
  assert.equal(player.y, 6);
});

test('force drop and offset attacks affect the ai piece instead of being ignored', () => {
  const forced = new Player('AI', 'pink');
  forced.board = createBoard();
  forced.current = { name: 'I', color: 'cyan', cells: [[1, 1, 1, 1]] };
  forced.x = 3;
  forced.y = 5;
  forced.forceDrop = true;
  assert.equal(aiStep(forced, () => 0.5, createAiContext()).action, 'forceDrop');
  assert.equal(forced.board.flat().some(Boolean), true);

  const shifted = new Player('AI', 'pink');
  shifted.board = createBoard();
  shifted.current = { name: 'I', color: 'cyan', cells: [[1, 1, 1, 1]] };
  shifted.x = 2;
  shifted.y = 5;
  shifted.offset = 2;
  assert.equal(aiStep(shifted, () => 0.5, createAiContext()).action, 'offset');
  assert.equal(shifted.x, 4);
});

function cloneCells(cells) { return cells.map(row => row.slice()); }
