/**
 * Хост движка. Живёт в offscreen-документе, общается с service worker'ом
 * сообщениями и ничего не знает ни про вкладки, ни про вёрстку сайтов.
 */
import '../common/protocol.js';
import { UciEngine } from './uci.js';
import { resolvePosition, uciLineToSan } from './position.js';
import { strengthPlan, parseEloLimits, FALLBACK_LIMITS } from '../common/strength.js';
import { Chess } from '../vendor/chess.js';

const { MSG } = globalThis.CC;
const ENGINE_URL = chrome.runtime.getURL('src/engine/stockfish-19-lite-single.js');

let engine = null;
let startPromise = null;
let eloLimits = { ...FALLBACK_LIMITS };
/** Идентификатор самого свежего запроса: результаты старых запросов отбрасываем. */
let currentRequestId = 0;
/** Чаще этого промежуточные варианты наружу не отдаём. */
const PARTIAL_THROTTLE_MS = 150;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return undefined;

  switch (msg.type) {
    case MSG.ENGINE_START:
      ensureEngine().then(
        () => sendResponse({ ok: true, engineId: engine.id, limits: eloLimits }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
      );
      return true;

    case MSG.ENGINE_ANALYZE:
      handleAnalyze(msg.payload).then(
        () => sendResponse({ ok: true }),
        (err) => {
          broadcast(MSG.ENGINE_ERROR, { requestId: msg.payload?.requestId, error: String(err?.message || err) });
          sendResponse({ ok: false, error: String(err?.message || err) });
        },
      );
      return true;

    case MSG.ENGINE_STOP:
      currentRequestId++;
      try { engine?.post('stop'); } catch { /* движок мог ещё не запуститься */ }
      sendResponse({ ok: true });
      return false;

    default:
      return undefined;
  }
});

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ target: 'sw', type, payload }).catch(() => {
    // Service worker мог быть выгружен — он сам перезапросит состояние.
  });
}

async function ensureEngine() {
  if (engine?.ready) return engine;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    broadcast(MSG.ENGINE_STATUS, { state: 'loading', message: 'Загрузка Stockfish…' });
    const next = new UciEngine(ENGINE_URL);
    await next.start();
    engine = next;
    eloLimits = parseEloLimits(next.options);
    // Однопоточная сборка: Threads всё равно 1, а хеш ускоряет перебор.
    await next.applyOptions({ Threads: '1', Hash: '64', UCI_ShowWDL: 'false' });
    broadcast(MSG.ENGINE_STATUS, {
      state: 'ready',
      engineId: next.id || 'Stockfish',
      limits: eloLimits,
      options: Object.keys(next.options),
    });
    return next;
  })();

  try {
    return await startPromise;
  } catch (err) {
    startPromise = null;
    engine = null;
    broadcast(MSG.ENGINE_STATUS, { state: 'error', message: String(err?.message || err) });
    throw err;
  } finally {
    if (engine) startPromise = null;
  }
}

/**
 * @param {{requestId:number, snapshot:object|null, fen:string|null, settings:object}} payload
 */
async function handleAnalyze(payload) {
  const { requestId, settings, tabId = null } = payload;
  currentRequestId = requestId;

  const sf = await ensureEngine();
  if (requestId !== currentRequestId) return;

  const resolved = payload.fen
    ? resolveRawFen(payload.fen)
    : resolvePosition(payload.snapshot || {});

  if (resolved.error) {
    broadcast(MSG.ENGINE_ERROR, { requestId, tabId, error: resolved.error });
    return;
  }
  if (resolved.gameOver) {
    broadcast(MSG.ENGINE_RESULT, {
      requestId,
      tabId,
      ...positionMeta(resolved),
      lines: [],
      best: null,
      plan: null,
      meta: null,
      engineId: sf.id,
      limits: eloLimits,
    });
    return;
  }

  const plan = strengthPlan(Number(settings.elo), eloLimits);
  const multipv = clampInt(settings.multipv, 1, 5);
  let lastPartialAt = 0;

  const search = await sf.request({
    fen: resolved.fen,
    multipv,
    movetimeMs: clampInt(settings.movetimeMs, 100, 20000),
    depthCap: plan.depthCap,
    options: plan.options,
    onPartial: (lines, meta) => {
      if (requestId !== currentRequestId) return;
      const now = Date.now();
      if (now - lastPartialAt < PARTIAL_THROTTLE_MS) return;
      lastPartialAt = now;
      broadcast(MSG.ENGINE_PARTIAL, {
        requestId,
        tabId,
        ...positionMeta(resolved),
        lines: formatLines(resolved.fen, lines, resolved.turn),
        meta,
        plan: { mode: plan.mode, note: plan.note, approxElo: plan.approxElo },
        engineId: sf.id,
        limits: eloLimits,
      });
    },
  });

  if (search.superseded || requestId !== currentRequestId) return;

  const lines = formatLines(resolved.fen, search.lines, resolved.turn);
  const best = describeMove(resolved.fen, search.bestmove);

  // При ограниченной силе движок намеренно играет не лучший ход.
  // По желанию считаем ещё и объективно сильнейший — для сравнения.
  let maxBest = null;
  if (settings.compareBest && plan.mode !== 'max') {
    const fullPlan = strengthPlan(3200, eloLimits);
    const full = await sf.request({
      fen: resolved.fen,
      multipv: 1,
      movetimeMs: clampInt(settings.movetimeMs, 100, 20000),
      depthCap: null,
      options: fullPlan.options,
    });
    if (!full.superseded && requestId === currentRequestId) {
      maxBest = describeMove(resolved.fen, full.bestmove);
      if (maxBest && full.lines[0]) maxBest.scoreText = scoreText(full.lines[0].score, resolved.turn);
    }
  }

  broadcast(MSG.ENGINE_RESULT, {
    requestId,
    tabId,
    ...positionMeta(resolved),
    lines,
    best,
    maxBest,
    sameAsBest: Boolean(maxBest && best && maxBest.uci === best.uci),
    meta: search.meta,
    plan: { mode: plan.mode, note: plan.note, approxElo: plan.approxElo },
    engineId: sf.id,
    limits: eloLimits,
  });
}

function positionMeta(resolved) {
  return {
    fen: resolved.fen,
    turn: resolved.turn,
    source: resolved.source,
    exact: resolved.exact,
    warnings: resolved.warnings || [],
    gameOver: resolved.gameOver || null,
  };
}

function resolveRawFen(fen) {
  try {
    const game = new Chess(fen.trim());
    return {
      fen: game.fen(),
      turn: game.turn(),
      source: 'manual',
      exact: true,
      warnings: [],
      gameOver: game.isGameOver() ? 'Партия в этой позиции окончена.' : null,
    };
  } catch (err) {
    return { error: `FEN не разобран: ${err.message}` };
  }
}

function formatLines(fen, lines, turn) {
  return lines.map((line) => {
    const { san, detail } = uciLineToSan(fen, line.pv || []);
    const head = detail[0] || null;
    return {
      rank: line.rank,
      uci: line.pv?.[0] || null,
      from: head?.from || null,
      to: head?.to || null,
      san: head?.san || line.pv?.[0] || '—',
      sanLine: san,
      depth: line.depth || 0,
      scoreText: scoreText(line.score, turn),
      whiteCp: whitePovCp(line.score, turn),
      mate: line.score?.mate ?? null,
    };
  });
}

function describeMove(fen, uci) {
  if (!uci) return null;
  const { detail } = uciLineToSan(fen, [uci]);
  const head = detail[0];
  return {
    uci,
    from: head?.from || uci.slice(0, 2),
    to: head?.to || uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : null,
    san: head?.san || uci,
  };
}

/** Оценка UCI идёт от лица того, чей ход. Приводим к привычному «плюс = за белых». */
function whitePovCp(score, turn) {
  if (!score) return null;
  const sign = turn === 'b' ? -1 : 1;
  if (score.mate !== undefined) return sign * score.mate > 0 ? 10000 : -10000;
  return sign * score.cp;
}

function scoreText(score, turn) {
  if (!score) return '—';
  const sign = turn === 'b' ? -1 : 1;
  if (score.mate !== undefined) {
    const n = sign * score.mate;
    return `${n > 0 ? '#' : '-#'}${Math.abs(score.mate)}`;
  }
  const pawns = (sign * score.cp) / 100;
  return `${pawns > 0 ? '+' : pawns < 0 ? '−' : ''}${Math.abs(pawns).toFixed(2)}`;
}

function clampInt(value, lo, hi) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// Движок поднимаем сразу: к моменту первого хода он уже будет готов.
ensureEngine().catch((err) => console.error('[offscreen] движок не запустился', err));
