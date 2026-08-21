const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createBoard,
  mergePiece,
  clearLines,
  addGarbageLines,
  canUseSkill,
  Player,
  advancePlayer,
} = require('./game.js');

const board = createBoard(4, 4);
board[3] = [1, 1, 1, 0];

const merged = mergePiece(board, [[1, 1]], 2, 2);
assert.equal(merged[2][2], 1, 'piece should merge into the board');

const cleared = clearLines(board);
assert.equal(cleared.lines, 0, 'incomplete rows should remain');

const full = createBoard(4, 4);
full[3] = [1, 1, 1, 1];
const result = clearLines(full);
assert.equal(result.lines, 1, 'full rows should clear');
assert.equal(result.board[3].every(cell => cell === 0), true, 'cleared row should be empty');

const garbage = addGarbageLines(createBoard(4, 4), 1, 1);
assert.equal(garbage[3].filter(Boolean).length, 3, 'garbage row leaves one hole');
assert.equal(canUseSkill(100, 80), true, 'skill is available at enough energy');
assert.equal(canUseSkill(50, 80), false, 'skill is unavailable without enough energy');

console.log('game rules tests passed');

test('advances a player through elapsed time after a hidden tab resumes', () => {
  const player = new Player('test', 'cyan');
  player.dropInterval = 100;
  const startY = player.y;
  const steps = advancePlayer(player, 250);
  assert.equal(steps, 2);
  assert.equal(player.y, startY + 2);
});
