import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInfoLine, parseOptionLine } from '../src/offscreen/uci.js';

test('разбор строки info с оценкой и вариантом', () => {
  const info = parseInfoLine('info depth 18 seldepth 24 multipv 2 score cp -34 nodes 120000 nps 900000 time 300 pv e2e4 e7e5 g1f3');
  assert.equal(info.depth, 18);
  assert.equal(info.seldepth, 24);
  assert.equal(info.multipv, 2);
  assert.deepEqual(info.score, { cp: -34 });
  assert.equal(info.nodes, 120000);
  assert.equal(info.timeMs, 300);
  assert.deepEqual(info.pv, ['e2e4', 'e7e5', 'g1f3']);
});

test('мат разбирается отдельно от сантипешек', () => {
  const info = parseInfoLine('info depth 20 multipv 1 score mate -3 pv h7h8q');
  assert.deepEqual(info.score, { mate: -3 });
});

test('multipv по умолчанию 1', () => {
  assert.equal(parseInfoLine('info depth 5 score cp 10 pv e2e4').multipv, 1);
});

test('строки без варианта не ломают разбор', () => {
  const info = parseInfoLine('info depth 1 currmove e2e4 currmovenumber 1');
  assert.equal(info.depth, 1);
  assert.equal(info.pv, undefined);
});

test('границы окна поиска помечаются', () => {
  assert.equal(parseInfoLine('info depth 9 score cp 55 upperbound pv e2e4').bound, 'upper');
});

test('строка не от info игнорируется', () => {
  assert.equal(parseInfoLine('bestmove e2e4 ponder e7e5'), null);
});

test('разбор опции spin с границами', () => {
  const { name, spec } = parseOptionLine('option name UCI_Elo type spin default 1320 min 1320 max 3190');
  assert.equal(name, 'UCI_Elo');
  assert.deepEqual(spec, { type: 'spin', default: '1320', min: 1320, max: 3190 });
});

test('разбор опции check и опции с пробелом в имени', () => {
  assert.deepEqual(parseOptionLine('option name UCI_LimitStrength type check default false'), {
    name: 'UCI_LimitStrength',
    spec: { type: 'check', default: 'false' },
  });
  assert.equal(parseOptionLine('option name Skill Level type spin default 20 min 0 max 20').name, 'Skill Level');
});

test('разбор опции combo со списком значений', () => {
  const { spec } = parseOptionLine('option name Style type combo default Normal var Solid var Normal var Risky');
  assert.deepEqual(spec.vars, ['Solid', 'Normal', 'Risky']);
  assert.equal(spec.default, 'Normal');
});
