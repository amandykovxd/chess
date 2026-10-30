/**
 * Перевод «желаемого рейтинга» в конкретные настройки Stockfish.
 *
 * Stockfish умеет ограничивать себя сам (UCI_LimitStrength + UCI_Elo), но его
 * нижняя граница ~1320 Эло. Ниже неё силу приходится эмулировать через
 * «Skill Level» и малую глубину поиска — так же, как это делает lichess.
 */

export const PRESETS = [
  { elo: 700, label: 'Новичок', hint: '~700 — учится ходить' },
  { elo: 1000, label: 'Любитель', hint: '~1000 — зевает фигуры' },
  { elo: 1300, label: 'Уверенный', hint: '~1300 — видит тактику в 1 ход' },
  { elo: 1600, label: 'Клубный', hint: '~1600 — крепкая игра' },
  { elo: 2000, label: 'Сильный', hint: '~2000 — уровень КМС' },
  { elo: 2400, label: 'Мастер', hint: '~2400 — уровень IM/GM' },
  { elo: 2800, label: 'Гроссмейстер', hint: '~2800 — уровень топ-10' },
  { elo: 3200, label: 'Максимум', hint: 'без ограничений — полная сила' },
];

/** Границы, пока движок не сообщил свои настоящие. Уточняются после `uci`. */
export const FALLBACK_LIMITS = { eloMin: 1320, eloMax: 3190 };

/**
 * @param {number} elo желаемый рейтинг из UI (500..3200)
 * @param {{eloMin:number, eloMax:number}|null} limits реальные границы UCI_Elo движка
 * @returns {{mode:'max'|'elo'|'weak', options:Record<string,string>, depthCap:number|null, note:string, approxElo:number}}
 */
export function strengthPlan(elo, limits) {
  const { eloMin, eloMax } = limits || FALLBACK_LIMITS;

  // «Максимум»: любое значение выше потолка движка снимает ограничение вовсе.
  if (elo >= Math.min(3200, eloMax)) {
    return {
      mode: 'max',
      options: { UCI_LimitStrength: 'false', 'Skill Level': '20' },
      depthCap: null,
      note: 'полная сила, без ограничений',
      approxElo: eloMax,
    };
  }

  // Рабочий диапазон самого движка.
  if (elo >= eloMin) {
    const value = Math.round(clamp(elo, eloMin, eloMax));
    return {
      mode: 'elo',
      options: { UCI_LimitStrength: 'true', UCI_Elo: String(value), 'Skill Level': '20' },
      depthCap: null,
      note: `UCI_Elo = ${value}`,
      approxElo: value,
    };
  }

  // Ниже собственного минимума движка: имитируем слабую игру.
  const t = clamp((elo - 500) / Math.max(1, eloMin - 500), 0, 1); // 0..1
  const skill = Math.round(t * 7);                                 // 0..7
  const depthCap = Math.max(1, Math.round(1 + t * 5));             // 1..6
  return {
    mode: 'weak',
    options: { UCI_LimitStrength: 'false', 'Skill Level': String(skill) },
    depthCap,
    note: `Skill Level ${skill}, глубина ≤ ${depthCap}`,
    approxElo: Math.round(elo),
  };
}

/** Разбирает строки `option name ... type spin ... min N max M` из ответа на `uci`. */
export function parseEloLimits(uciOptions) {
  const opt = uciOptions?.UCI_Elo;
  if (!opt || opt.type !== 'spin') return { ...FALLBACK_LIMITS };
  return {
    eloMin: Number.isFinite(opt.min) ? opt.min : FALLBACK_LIMITS.eloMin,
    eloMax: Number.isFinite(opt.max) ? opt.max : FALLBACK_LIMITS.eloMax,
  };
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Подпись для ползунка: 3200 показываем как «МАКС». */
export function formatElo(elo, limits) {
  const eloMax = Math.min(3200, (limits || FALLBACK_LIMITS).eloMax);
  return elo >= eloMax ? 'МАКС' : String(Math.round(elo));
}
