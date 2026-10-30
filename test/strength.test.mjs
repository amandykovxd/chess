import test from 'node:test';
import assert from 'node:assert/strict';
import { strengthPlan, parseEloLimits, formatElo, FALLBACK_LIMITS } from '../src/common/strength.js';

const LIMITS = { eloMin: 1320, eloMax: 3190 };

test('максимум снимает ограничение силы', () => {
  const plan = strengthPlan(3200, LIMITS);
  assert.equal(plan.mode, 'max');
  assert.equal(plan.options.UCI_LimitStrength, 'false');
  assert.equal(plan.depthCap, null);
});

test('рабочий диапазон движка использует UCI_Elo', () => {
  const plan = strengthPlan(1600, LIMITS);
  assert.equal(plan.mode, 'elo');
  assert.equal(plan.options.UCI_LimitStrength, 'true');
  assert.equal(plan.options.UCI_Elo, '1600');
});

test('ниже минимума движка слабая игра имитируется', () => {
  const plan = strengthPlan(700, LIMITS);
  assert.equal(plan.mode, 'weak');
  assert.equal(plan.options.UCI_LimitStrength, 'false');
  assert.ok(Number(plan.options['Skill Level']) <= 7);
  assert.ok(plan.depthCap >= 1 && plan.depthCap <= 6);
});

test('сила не убывает при росте рейтинга', () => {
  let prevSkill = -1;
  for (let elo = 500; elo < LIMITS.eloMin; elo += 50) {
    const skill = Number(strengthPlan(elo, LIMITS).options['Skill Level']);
    assert.ok(skill >= prevSkill, `Skill Level упал на ${elo} Эло`);
    prevSkill = skill;
  }
  let prevElo = -1;
  for (let elo = LIMITS.eloMin; elo < 3190; elo += 50) {
    const value = Number(strengthPlan(elo, LIMITS).options.UCI_Elo);
    assert.ok(value >= prevElo, `UCI_Elo упал на ${elo}`);
    prevElo = value;
  }
});

test('границы берутся из ответа движка, иначе запасные', () => {
  assert.deepEqual(parseEloLimits({ UCI_Elo: { type: 'spin', min: 1400, max: 3000 } }), { eloMin: 1400, eloMax: 3000 });
  assert.deepEqual(parseEloLimits({}), FALLBACK_LIMITS);
  assert.deepEqual(parseEloLimits(null), FALLBACK_LIMITS);
});

test('потолок подписывается как МАКС', () => {
  assert.equal(formatElo(3200, LIMITS), 'МАКС');
  assert.equal(formatElo(1600, LIMITS), '1600');
});
