/**
 * Боковая панель: весь пользовательский интерфейс.
 * Своего состояния почти не держит — отображает то, что присылает service worker.
 */
import '../common/protocol.js';
import { PRESETS, strengthPlan, formatElo, FALLBACK_LIMITS } from '../common/strength.js';

const { MSG, DEFAULTS } = globalThis.CC;

const $ = (id) => document.getElementById(id);

const els = {
  statusDot: $('statusDot'),
  engineLine: $('engineLine'),
  eloSlider: $('eloSlider'),
  eloValue: $('eloValue'),
  presets: $('presets'),
  planHint: $('planHint'),
  turnBadge: $('turnBadge'),
  evalFill: $('evalFill'),
  evalText: $('evalText'),
  bestMove: $('bestMove'),
  bestSub: $('bestSub'),
  lines: $('lines'),
  analyzeBtn: $('analyzeBtn'),
  stopBtn: $('stopBtn'),
  searchMeta: $('searchMeta'),
  movetime: $('movetime'),
  movetimeValue: $('movetimeValue'),
  multipv: $('multipv'),
  multipvValue: $('multipvValue'),
  arrowCount: $('arrowCount'),
  arrowCountValue: $('arrowCountValue'),
  analyzeFor: $('analyzeFor'),
  autoAnalyze: $('autoAnalyze'),
  showArrows: $('showArrows'),
  compareBest: $('compareBest'),
  sourceBadge: $('sourceBadge'),
  turnSwitch: $('turnSwitch'),
  fenBox: $('fenBox'),
  fenAnalyzeBtn: $('fenAnalyzeBtn'),
  fenCopyBtn: $('fenCopyBtn'),
  notes: $('notes'),
};

const RANK_COLORS = ['#19a974', '#2f7fd1', '#d9801f', '#8e6bd1', '#c0483c'];

let settings = { ...DEFAULTS };
let limits = { ...FALLBACK_LIMITS };
/** Пока пользователь тащит ползунок, не перетираем его значение приходящим состоянием. */
let dragging = false;
/** FEN не перезаписываем, если пользователь правит его руками. */
let fenDirty = false;

// ─────────────────────────────── отправка

function send(type, payload) {
  return chrome.runtime.sendMessage({ target: 'sw', type, payload }).catch((err) => {
    console.warn('[panel]', type, err);
    return null;
  });
}

const patchTimers = new Map();
/** Ползунки шлют события десятками — настройки отправляем не чаще раза в 220 мс. */
function patch(key, value, delay = 220) {
  settings = { ...settings, [key]: value };
  clearTimeout(patchTimers.get(key));
  patchTimers.set(
    key,
    setTimeout(() => send(MSG.PATCH_SETTINGS, { [key]: value }), delay),
  );
}

// ─────────────────────────────── элементы управления

function buildPresets() {
  els.presets.textContent = '';
  for (const preset of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = preset.label;
    btn.title = preset.hint;
    btn.dataset.elo = String(preset.elo);
    btn.addEventListener('click', () => {
      els.eloSlider.value = String(preset.elo);
      renderStrength(preset.elo);
      patch('elo', preset.elo, 0);
    });
    els.presets.appendChild(btn);
  }
}

function renderStrength(elo) {
  els.eloValue.textContent = formatElo(elo, limits);
  const plan = strengthPlan(Number(elo), limits);
  const modeText = {
    max: 'Полная сила движка — объективно лучший ход.',
    elo: 'Движок намеренно играет на заданном уровне.',
    weak: 'Ниже собственного минимума движка — слабая игра имитируется.',
  }[plan.mode];
  els.planHint.textContent = `${modeText} (${plan.note})`;

  for (const btn of els.presets.children) {
    btn.classList.toggle('on', Number(btn.dataset.elo) === Number(elo));
  }
}

els.eloSlider.addEventListener('pointerdown', () => { dragging = true; });
els.eloSlider.addEventListener('pointerup', () => { dragging = false; });
els.eloSlider.addEventListener('input', () => {
  const elo = Number(els.eloSlider.value);
  renderStrength(elo);
  patch('elo', elo);
});

els.movetime.addEventListener('input', () => {
  const ms = Number(els.movetime.value);
  els.movetimeValue.textContent = `${(ms / 1000).toFixed(1)} с`;
  patch('movetimeMs', ms);
});

els.multipv.addEventListener('input', () => {
  const n = Number(els.multipv.value);
  els.multipvValue.textContent = String(n);
  // Стрелок не может быть больше, чем посчитано вариантов.
  if (Number(els.arrowCount.value) > n) {
    els.arrowCount.value = String(n);
    els.arrowCountValue.textContent = String(n);
    patch('arrowCount', n, 0);
  }
  els.arrowCount.max = String(n);
  patch('multipv', n);
});

els.arrowCount.addEventListener('input', () => {
  const n = Number(els.arrowCount.value);
  els.arrowCountValue.textContent = String(n);
  patch('arrowCount', n);
});

els.analyzeFor.addEventListener('change', () => patch('analyzeFor', els.analyzeFor.value, 0));

for (const key of ['autoAnalyze', 'showArrows', 'compareBest']) {
  els[key].addEventListener('change', () => patch(key, els[key].checked, 0));
}

els.analyzeBtn.addEventListener('click', async () => {
  els.analyzeBtn.disabled = true;
  const res = await send(MSG.REQUEST_ANALYSIS, {});
  els.analyzeBtn.disabled = false;
  if (res && res.ok === false) showNotes([{ text: res.error, kind: 'error' }]);
});

els.stopBtn.addEventListener('click', () => send(MSG.STOP_ANALYSIS, {}));

els.turnSwitch.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-turn]');
  if (!btn) return;
  for (const b of els.turnSwitch.children) b.classList.toggle('on', b === btn);
  const turn = btn.dataset.turn;
  send(MSG.OVERRIDE_TURN, { turn: turn === 'auto' ? null : turn });
});

els.fenBox.addEventListener('input', () => { fenDirty = true; });
els.fenBox.addEventListener('blur', () => {
  if (!els.fenBox.value.trim()) fenDirty = false;
});

els.fenAnalyzeBtn.addEventListener('click', async () => {
  const res = await send(MSG.ANALYZE_FEN, { fen: els.fenBox.value });
  fenDirty = false;
  if (res && res.ok === false) showNotes([{ text: res.error, kind: 'error' }]);
});

els.fenCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.fenBox.value);
    els.fenCopyBtn.textContent = 'Скопировано';
    setTimeout(() => { els.fenCopyBtn.textContent = 'Копировать'; }, 1200);
  } catch {
    els.fenCopyBtn.textContent = 'Не вышло';
    setTimeout(() => { els.fenCopyBtn.textContent = 'Копировать'; }, 1200);
  }
});

// ─────────────────────────────── отрисовка состояния

function applySettings(next) {
  settings = { ...DEFAULTS, ...next };
  if (!dragging) {
    els.eloSlider.value = String(settings.elo);
    renderStrength(settings.elo);
  }
  els.movetime.value = String(settings.movetimeMs);
  els.movetimeValue.textContent = `${(settings.movetimeMs / 1000).toFixed(1)} с`;
  els.multipv.value = String(settings.multipv);
  els.multipvValue.textContent = String(settings.multipv);
  els.arrowCount.max = String(settings.multipv);
  els.arrowCount.value = String(Math.min(settings.arrowCount, settings.multipv));
  els.arrowCountValue.textContent = els.arrowCount.value;
  els.analyzeFor.value = settings.analyzeFor;
  els.autoAnalyze.checked = settings.autoAnalyze;
  els.showArrows.checked = settings.showArrows;
  els.compareBest.checked = settings.compareBest;
}

function applyEngine(engine) {
  const state = engine?.state || 'idle';
  els.statusDot.dataset.state = state;
  els.engineLine.dataset.state = state;
  if (engine?.limits) {
    limits = engine.limits;
    if (!dragging) renderStrength(Number(els.eloSlider.value));
  }
  els.engineLine.textContent = {
    idle: 'движок не запущен — нажмите, чтобы запустить',
    loading: engine?.message || 'движок загружается…',
    ready: `${engine?.engineId || 'Stockfish'} · Эло ${limits.eloMin}–${limits.eloMax}`,
    error: `${engine?.message || 'движок не запустился'} — нажмите, чтобы перезапустить`,
  }[state];
}

els.engineLine.addEventListener('click', async () => {
  els.engineLine.textContent = 'перезапуск движка…';
  els.statusDot.dataset.state = 'loading';
  const res = await send(MSG.RESTART_ENGINE, {});
  if (res?.status) applyEngine(res.status);
  else if (res?.error) applyEngine({ state: 'error', message: res.error });
});

function render(state) {
  if (state.settings) applySettings(state.settings);
  applyEngine(state.engine);

  const notes = [];
  const result = state.result;

  if (!state.hasBoard && !result) {
    let text;
    if (!state.supportedSite) {
      text = 'Текущая вкладка — не chess.com и не lichess.org. Откройте партию или задачу на одном из этих сайтов.';
    } else if (!state.site) {
      // Chrome не внедряет content script в уже открытые вкладки при установке расширения.
      text = 'Сайт поддерживается, но скрипт в страницу не внедрён. Обновите вкладку (F5) — после установки расширения это нужно сделать один раз.';
    } else {
      text = 'Доска на странице не найдена. Откройте партию, задачу или анализ — на главной странице доски нет.';
    }
    notes.push({ text, kind: 'info' });
  }
  if (state.error) notes.push({ text: state.error, kind: 'error' });

  if (!result) {
    renderEmpty();
    showNotes(notes);
    return;
  }

  // --- очередь хода и источник позиции ---
  els.turnBadge.textContent = result.turn === 'w' ? 'ход белых' : 'ход чёрных';
  els.sourceBadge.textContent = {
    movelist: 'точно: по списку ходов',
    pieces: 'оценка: по расстановке',
    manual: 'FEN вручную',
  }[result.source] || '—';

  if (!fenDirty) els.fenBox.value = result.fen || '';

  for (const b of els.turnSwitch.children) {
    b.classList.toggle('on', b.dataset.turn === (state.turnOverride || 'auto'));
  }

  // --- оценка ---
  const top = result.lines?.[0] || null;
  const cp = top?.whiteCp ?? null;
  els.evalFill.style.width = `${winPercent(cp)}%`;
  els.evalText.textContent = top?.scoreText || (result.gameOver ? '—' : '…');

  // --- рекомендация ---
  if (result.gameOver) {
    els.bestMove.textContent = '—';
    els.bestSub.textContent = result.gameOver;
  } else if (result.best) {
    els.bestMove.textContent = result.best.san;
    const bits = [`${result.best.from}→${result.best.to}`];
    if (result.plan) bits.push(result.plan.mode === 'max' ? 'полная сила' : `≈${result.plan.approxElo} Эло`);
    if (result.maxBest && !result.sameAsBest) {
      bits.push(`лучший: ${result.maxBest.san}${result.maxBest.scoreText ? ` (${result.maxBest.scoreText})` : ''}`);
    } else if (result.maxBest && result.sameAsBest) {
      bits.push('совпадает с лучшим');
    }
    els.bestSub.textContent = bits.join(' · ');
  } else if (top) {
    // Промежуточный результат: окончательный ход движок ещё не назвал.
    els.bestMove.textContent = top.san;
    els.bestSub.textContent = 'считает…';
  } else {
    els.bestMove.textContent = '…';
    els.bestSub.textContent = 'движок думает';
  }

  renderLines(result);

  const meta = result.meta;
  els.searchMeta.textContent = meta
    ? `глубина ${meta.depth || 0}${meta.seldepth ? `/${meta.seldepth}` : ''} · ${formatNodes(meta.nodes)} узлов · ${meta.timeMs || 0} мс`
    : '';

  for (const w of result.warnings || []) notes.push({ text: w, kind: 'warn' });
  showNotes(notes);
}

function renderEmpty() {
  els.turnBadge.textContent = '—';
  els.sourceBadge.textContent = '—';
  els.evalFill.style.width = '50%';
  els.evalText.textContent = '—';
  els.bestMove.textContent = '—';
  els.bestSub.textContent = 'нет данных';
  els.lines.textContent = '';
  els.searchMeta.textContent = '';
}

function renderLines(result) {
  els.lines.textContent = '';
  const chosen = result.best?.uci || null;

  for (const line of result.lines || []) {
    const li = document.createElement('li');

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = RANK_COLORS[(line.rank - 1) % RANK_COLORS.length];
    li.appendChild(swatch);

    const score = document.createElement('span');
    score.className = 'score';
    score.textContent = line.scoreText;
    li.appendChild(score);

    const pv = document.createElement('span');
    pv.className = 'pv';
    const head = document.createElement('b');
    // Помечаем ход, который движок реально выбрал на заданной силе.
    head.textContent = line.uci === chosen ? `${line.san} ◀` : line.san;
    pv.appendChild(head);
    pv.append(` ${(line.sanLine || []).slice(1).join(' ')}`);
    pv.title = (line.sanLine || []).join(' ');
    li.appendChild(pv);

    els.lines.appendChild(li);
  }
}

function showNotes(notes) {
  els.notes.textContent = '';
  for (const note of notes) {
    if (!note.text) continue;
    const li = document.createElement('li');
    if (note.kind === 'error') li.className = 'error';
    else if (note.kind === 'info') li.className = 'info';
    li.textContent = note.text;
    els.notes.appendChild(li);
  }
}

/** Сантипешки → доля шкалы. Логистическая кривая: ±3 пешки уже почти упор. */
function winPercent(cp) {
  if (cp == null) return 50;
  if (cp >= 10000) return 100;
  if (cp <= -10000) return 0;
  return 100 / (1 + Math.exp(-cp / 320));
}

function formatNodes(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} млн`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} тыс.`;
  return String(n);
}

// ─────────────────────────────── приём состояния

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'panel') return;
  if (msg.type === MSG.STATE_UPDATE) render(msg.payload);
});

buildPresets();
applySettings(DEFAULTS);

send(MSG.PANEL_READY, {}).then((res) => {
  if (res?.state) render(res.state);
});
