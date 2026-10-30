import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePosition, uciLineToSan } from '../src/offscreen/position.js';

const START = {
  a1: 'wR', b1: 'wN', c1: 'wB', d1: 'wQ', e1: 'wK', f1: 'wB', g1: 'wN', h1: 'wR',
  a2: 'wP', b2: 'wP', c2: 'wP', d2: 'wP', e2: 'wP', f2: 'wP', g2: 'wP', h2: 'wP',
  a7: 'bP', b7: 'bP', c7: 'bP', d7: 'bP', e7: 'bP', f7: 'bP', g7: 'bP', h7: 'bP',
  a8: 'bR', b8: 'bN', c8: 'bB', d8: 'bQ', e8: 'bK', f8: 'bB', g8: 'bN', h8: 'bR',
};

test('список ходов даёт точный FEN', () => {
  const r = resolvePosition({ moves: ['e4', 'e5', 'Nf3', 'Nc6'], pieces: null, turnHint: 'w' });
  assert.equal(r.fen, 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
  assert.equal(r.source, 'movelist');
  assert.equal(r.exact, true);
});

test('пустой список ходов — начальная позиция', () => {
  const r = resolvePosition({ moves: [], pieces: START, turnHint: 'w' });
  assert.equal(r.fen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.equal(r.source, 'movelist');
});

test('расхождение списка ходов с доской — откат на расстановку', () => {
  const r = resolvePosition({ moves: ['e4', 'e5'], pieces: START, turnHint: 'w' });
  assert.equal(r.source, 'pieces');
  assert.ok(r.warnings.some((w) => w.includes('не совпал')));
});

test('неразобранный ход в списке — откат на расстановку', () => {
  const r = resolvePosition({ moves: ['e4', 'Qz9'], pieces: START, turnHint: 'w' });
  assert.equal(r.source, 'pieces');
  assert.ok(r.warnings.some((w) => w.includes('Не удалось разобрать')));
});

test('ручная смена очереди хода перекрывает даже точный FEN', () => {
  const r = resolvePosition({ moves: ['e4'], pieces: null, turnHint: null, turnOverride: 'w' });
  assert.equal(r.turn, 'w');
  assert.ok(r.warnings.some((w) => w.includes('вручную')));
});

test('права рокировки выводятся из положения короля и ладей', () => {
  const pieces = { ...START, g1: 'wR' };
  delete pieces.h1;
  const r = resolvePosition({ moves: null, pieces, turnHint: 'w' });
  assert.equal(r.fen.split(' ')[2], 'Qkq');
});

test('король не на месте — рокировок нет', () => {
  const pieces = { d1: 'wK', e8: 'bK', a1: 'wR' };
  const r = resolvePosition({ moves: null, pieces, turnHint: 'w' });
  assert.equal(r.fen.split(' ')[2], '-');
});

test('поле взятия на проходе выводится из двойного хода пешки', () => {
  const pieces = { e1: 'wK', e8: 'bK', d4: 'bP', e4: 'wP' };
  const r = resolvePosition({ moves: null, pieces, turnHint: 'b', lastMove: { from: 'e2', to: 'e4' } });
  assert.equal(r.fen.split(' ')[3], 'e3');
});

test('взятие на проходе недоступно той стороне, что его и сделала', () => {
  const pieces = { e1: 'wK', e8: 'bK', d4: 'bP', e4: 'wP' };
  const r = resolvePosition({ moves: null, pieces, turnHint: 'w', lastMove: { from: 'e2', to: 'e4' } });
  assert.equal(r.fen.split(' ')[3], '-');
});

test('невозможная очередь хода исправляется: король не ходящей стороны под шахом', () => {
  const pieces = { e1: 'wK', e8: 'bK', e7: 'wR' };
  const r = resolvePosition({ moves: null, pieces, turnHint: 'w' });
  assert.equal(r.turn, 'b');
  assert.ok(r.warnings.some((w) => w.includes('исправлена')));
});

test('пустая доска — понятная ошибка, а не исключение', () => {
  assert.ok(resolvePosition({ moves: null, pieces: {} }).error);
});

test('окончание партии распознаётся', () => {
  const r = resolvePosition({ moves: ['f3', 'e5', 'g4', 'Qh4'], pieces: null, turnHint: 'w' });
  assert.match(r.gameOver, /Мат/);
});

test('UCI переводится в нотацию, включая превращение', () => {
  const { san } = uciLineToSan('8/P6k/8/8/8/8/8/K7 w - - 0 1', ['a7a8q']);
  assert.deepEqual(san, ['a8=Q']);
});

test('невозможный ход обрезает вариант, а не ломает его', () => {
  const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const { san } = uciLineToSan(start, ['e2e4', 'e7e5', 'e2e4']);
  assert.deepEqual(san, ['e4', 'e5']);
});
