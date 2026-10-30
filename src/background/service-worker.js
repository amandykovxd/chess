/**
 * Service worker: диспетчер. Сам ничего не считает и не трогает DOM.
 *
 *   content script  ──снимок доски──▶  SW  ──FEN + настройки──▶  offscreen (Stockfish)
 *   content script  ◀────стрелки────   SW  ◀─────варианты──────   offscreen
 *   side panel      ◀──состояние───    SW  ◀──изменения настроек──  side panel
 *
 * В Manifest V3 этот скрипт выгружается через ~30 секунд простоя, поэтому
 * вся долгоживущая информация лежит либо в chrome.storage, либо приходит
 * вместе с сообщением (например, tabId возвращается из offscreen обратно).
 */
import '../common/protocol.js';

const { MSG, DEFAULTS, SETTINGS_KEY } = globalThis.CC;

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

const ARROW_COLORS = ['#19a974', '#2f7fd1', '#d9801f', '#8e6bd1', '#c0483c'];
const MAX_BEST_COLOR = '#b14ad6';

let settingsCache = null;
let offscreenReady = null;
let requestSeq = Math.floor(Date.now() % 1e6);

/** Последнее состояние по вкладке. Теряется при выгрузке SW — восстанавливается запросом снимка. */
const tabs = new Map();
let engineStatus = { state: 'idle' };

// ---------------------------------------------------------------- установка

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanel();
  warmUpEngine();
});
chrome.runtime.onStartup.addListener(() => {
  enableSidePanel();
});

function enableSidePanel() {
  chrome.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[sw] side panel behavior', err));
}
enableSidePanel();

// Клик по иконке открывает панель; setPanelBehavior делает это сам,
// но на части сборок Chrome обработчик всё равно нужен как резерв.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    /* панель уже открыта поведением по умолчанию */
  }
});

// ---------------------------------------------------------------- настройки

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = { ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) };
  return settingsCache;
}

async function patchSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  settingsCache = next;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    settingsCache = { ...DEFAULTS, ...(changes[SETTINGS_KEY].newValue || {}) };
  }
});

// ---------------------------------------------------------------- offscreen

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;

  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    if (existing.length === 0) {
      const justification = 'Запуск шахматного движка Stockfish в WebAssembly-воркере.';
      // DOM_SCRAPING — запасная причина на случай сборки Chrome, не знающей WORKERS.
      let lastError = null;
      for (const reason of ['WORKERS', 'DOM_SCRAPING']) {
        try {
          await chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: [reason], justification });
          lastError = null;
          break;
        } catch (err) {
          // Документ мог быть создан параллельным вызовом — это не ошибка.
          if (/single offscreen document|already exists/i.test(String(err?.message))) {
            lastError = null;
            break;
          }
          lastError = err;
        }
      }
      if (lastError) throw lastError;
    }
    return true;
  })();

  try {
    return await offscreenReady;
  } catch (err) {
    offscreenReady = null;
    throw err;
  }
}

/**
 * Поднимает движок и запоминает его состояние.
 *
 * Статус движка нельзя держать только на broadcast'ах: service worker
 * выгружается и теряет память, а offscreen-документ продолжает жить и
 * ничего повторно не присылает. Поэтому состояние всегда перезапрашиваем
 * ответом на ENGINE_START — для уже готового движка это дешёвый вызов.
 */
async function warmUpEngine({ notify = true } = {}) {
  try {
    await ensureOffscreen();
    const res = await sendWithRetry(MSG.ENGINE_START, {});
    if (res?.ok) {
      engineStatus = { state: 'ready', engineId: res.engineId, limits: res.limits };
    } else {
      engineStatus = { state: 'error', message: res?.error || 'движок не ответил' };
    }
  } catch (err) {
    engineStatus = { state: 'error', message: String(err?.message || err) };
    console.warn('[sw] движок не прогрелся', err);
  }
  if (notify) pushState();
  return engineStatus;
}

/**
 * Сразу после createDocument страница ещё не успела повесить обработчик
 * сообщений, и первый же вызов падает с «Could not establish connection».
 */
async function sendWithRetry(type, payload, attempts = 4) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', type, payload });
    } catch (err) {
      lastError = err;
      if (!/establish connection|Receiving end does not exist/i.test(String(err?.message))) throw err;
      await delay(150 * (i + 1));
    }
  }
  throw lastError;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Полный перезапуск: закрываем offscreen-документ и поднимаем движок заново. */
async function restartEngine() {
  offscreenReady = null;
  engineStatus = { state: 'loading', message: 'перезапуск…' };
  pushState();
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Документа могло и не быть — это нормально.
  }
  return warmUpEngine();
}

async function sendToOffscreen(type, payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', type, payload });
}

// ---------------------------------------------------------------- сообщения

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? null;

  switch (msg?.type) {
    case MSG.CONTENT_READY:
      ensureTab(tabId, { site: msg.payload?.site, url: sender.tab?.url });
      warmUpEngine();
      sendResponse({ ok: true });
      return false;

    case MSG.BOARD_UPDATE:
      onBoardUpdate(tabId, msg.payload).catch((err) => console.error('[sw] board update', err));
      sendResponse({ ok: true });
      return false;

    case MSG.PANEL_READY:
      onPanelReady().then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;

    case MSG.PATCH_SETTINGS:
      onPatchSettings(msg.payload).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;

    case MSG.REQUEST_ANALYSIS:
      analyzeActiveTab({ force: true }).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
      );
      return true;

    case MSG.ANALYZE_FEN:
      analyzeFen(msg.payload?.fen).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
      );
      return true;

    case MSG.OVERRIDE_TURN:
      onOverrideTurn(msg.payload?.turn).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
      );
      return true;

    case MSG.RESTART_ENGINE:
      restartEngine().then(
        (status) => sendResponse({ ok: status.state === 'ready', status }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
      );
      return true;

    case MSG.STOP_ANALYSIS:
      sendToOffscreen(MSG.ENGINE_STOP, {}).catch(() => {});
      sendResponse({ ok: true });
      return false;

    // --- из offscreen ---
    case MSG.ENGINE_STATUS:
      engineStatus = msg.payload;
      pushState();
      return false;

    case MSG.ENGINE_PARTIAL:
    case MSG.ENGINE_RESULT:
      onEngineOutput(msg.type, msg.payload).catch((err) => console.error('[sw] engine output', err));
      return false;

    case MSG.ENGINE_ERROR:
      onEngineError(msg.payload);
      return false;

    default:
      return undefined;
  }
});

// ---------------------------------------------------------------- вкладки

function ensureTab(tabId, extra = {}) {
  if (tabId == null) return null;
  const prev = tabs.get(tabId) || { tabId, snapshot: null, result: null, error: null, turnOverride: null };
  const next = { ...prev, ...extra };
  tabs.set(tabId, next);
  return next;
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  pushState();
  refreshSnapshot(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    const tab = tabs.get(tabId);
    if (tab) tabs.set(tabId, { ...tab, snapshot: null, result: null, error: null, turnOverride: null });
  }
});

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

function refreshSnapshot(tabId) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: MSG.PING }).catch(() => {
    // На странице без content script'а (не chess.com / не lichess) это норма.
  });
}

// ---------------------------------------------------------------- логика

async function onBoardUpdate(tabId, payload) {
  const tab = ensureTab(tabId, { snapshot: payload.snapshot, site: payload.site });
  if (!tab) return;

  const current = await activeTabId();
  if (tabId !== current) return; // считаем только для вкладки, которую видит панель

  pushState();
  const settings = await getSettings();
  if (!settings.autoAnalyze && !payload.force) return;
  if (!shouldAnalyzeTurn(payload.snapshot?.turnHint, settings.analyzeFor)) {
    await clearArrows(tabId);
    return;
  }
  await startAnalysis(tabId);
}

function shouldAnalyzeTurn(turnHint, analyzeFor) {
  if (analyzeFor === 'both' || !turnHint) return true;
  return (analyzeFor === 'white' && turnHint === 'w') || (analyzeFor === 'black' && turnHint === 'b');
}

async function startAnalysis(tabId, overrides = {}) {
  const tab = tabs.get(tabId);
  if (!tab?.snapshot) return;
  const settings = await getSettings();
  const requestId = ++requestSeq;
  tabs.set(tabId, { ...tab, requestId, error: null });

  await sendToOffscreen(MSG.ENGINE_ANALYZE, {
    requestId,
    tabId,
    snapshot: { ...tab.snapshot, turnOverride: tab.turnOverride ?? null },
    fen: null,
    settings,
    ...overrides,
  });
}

async function analyzeActiveTab({ force = false } = {}) {
  const tabId = await activeTabId();
  if (tabId == null) throw new Error('Нет активной вкладки.');
  const tab = tabs.get(tabId);
  if (!tab?.snapshot) {
    refreshSnapshot(tabId);
    throw new Error('Доска на странице не найдена. Откройте партию или задачу на chess.com / lichess.org.');
  }
  if (force) await startAnalysis(tabId);
}

async function analyzeFen(fen) {
  if (!fen || !fen.trim()) throw new Error('Пустой FEN.');
  const tabId = await activeTabId();
  const settings = await getSettings();
  const requestId = ++requestSeq;
  if (tabId != null) ensureTab(tabId, { requestId, error: null });
  await sendToOffscreen(MSG.ENGINE_ANALYZE, { requestId, tabId, snapshot: null, fen: fen.trim(), settings });
}

async function onPatchSettings(rawPatch) {
  const patch = rawPatch || {};
  const settings = await patchSettings(patch);
  const tabId = await activeTabId();
  if (tabId != null) {
    const tab = tabs.get(tabId);
    // Изменение силы / времени / числа вариантов требует пересчёта.
    const needsRecount = ['elo', 'movetimeMs', 'multipv', 'compareBest'].some((k) => k in patch);
    if (!settings.showArrows) await clearArrows(tabId);
    else if (needsRecount && tab?.snapshot && settings.autoAnalyze) await startAnalysis(tabId);
    else if (tab?.result) await drawFromResult(tabId, tab.result, settings);
  }
  pushState({ settings });
  return { ok: true, settings };
}

async function onOverrideTurn(turn) {
  const tabId = await activeTabId();
  if (tabId == null) return;
  const tab = ensureTab(tabId, { turnOverride: turn === 'w' || turn === 'b' ? turn : null });
  if (tab?.snapshot) await startAnalysis(tabId);
  pushState();
}

async function onPanelReady() {
  const settings = await getSettings();
  const tabId = await activeTabId();
  refreshSnapshot(tabId);
  // Ждём статус движка: иначе панель откроется с «не запущен» и так и застрянет.
  await warmUpEngine({ notify: false });
  return { ok: true, state: await buildState(settings) };
}

async function onEngineOutput(type, payload) {
  const tabId = payload.tabId;
  if (tabId != null) {
    const tab = ensureTab(tabId);
    if (tab && tab.requestId && payload.requestId && tab.requestId !== payload.requestId) return; // устаревший ответ
    tabs.set(tabId, { ...(tabs.get(tabId) || { tabId }), result: payload, error: null });
  }

  const settings = await getSettings();
  const final = type === MSG.ENGINE_RESULT;

  if (tabId != null && settings.showArrows) {
    // Промежуточные варианты рисуем тоже — стрелка «догоняет» мысль движка.
    await drawFromResult(tabId, payload, settings);
  }
  pushState({ settings, partial: !final });
}

function onEngineError(payload) {
  const tabId = payload?.tabId;
  if (tabId != null) {
    tabs.set(tabId, { ...(tabs.get(tabId) || { tabId }), error: payload.error, result: null });
    clearArrows(tabId);
  }
  pushState();
}

// ---------------------------------------------------------------- стрелки

async function drawFromResult(tabId, result, settings) {
  if (!shouldAnalyzeTurn(result.turn, settings.analyzeFor)) {
    await clearArrows(tabId);
    return;
  }
  const count = Math.max(1, Math.min(Number(settings.arrowCount) || 1, 5));
  const arrows = [];

  const lines = (result.lines || []).filter((l) => l.from && l.to).slice(0, count);
  lines.forEach((line, i) => {
    arrows.push({
      from: line.from,
      to: line.to,
      color: ARROW_COLORS[i % ARROW_COLORS.length],
      // Первый вариант — толще и заметнее остальных.
      width: i === 0 ? 0.17 : 0.11,
      opacity: i === 0 ? 0.92 : 0.6,
      label: i === 0 ? `${line.san} ${line.scoreText}` : line.san,
    });
  });

  // Ход, который движок реально выбрал на заданной силе, может не совпасть с первым вариантом.
  if (result.best?.from && result.best?.to && !lines.some((l) => l.from === result.best.from && l.to === result.best.to)) {
    arrows.unshift({
      from: result.best.from,
      to: result.best.to,
      color: ARROW_COLORS[0],
      width: 0.17,
      opacity: 0.92,
      label: result.best.san,
    });
  }

  if (result.maxBest?.from && result.maxBest?.to && !result.sameAsBest) {
    arrows.push({
      from: result.maxBest.from,
      to: result.maxBest.to,
      color: MAX_BEST_COLOR,
      width: 0.12,
      opacity: 0.8,
      dashed: true,
      label: `макс: ${result.maxBest.san}`,
    });
  }

  await chrome.tabs
    .sendMessage(tabId, { type: MSG.DRAW_ARROWS, payload: { arrows } })
    .catch(() => {});
}

async function clearArrows(tabId) {
  await chrome.tabs.sendMessage(tabId, { type: MSG.CLEAR_ARROWS }).catch(() => {});
}

// ---------------------------------------------------------------- панель

async function buildState(settings) {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tabId = activeTab?.id ?? null;
  const tab = tabId != null ? tabs.get(tabId) : null;
  return {
    engine: engineStatus,
    settings: settings || (await getSettings()),
    tabId,
    // url приходит только для вкладок, покрытых host_permissions, —
    // то есть его наличие и означает «сайт поддерживается».
    supportedSite: Boolean(activeTab?.url),
    site: tab?.site || null,
    hasBoard: Boolean(tab?.snapshot),
    snapshotInfo: tab?.snapshot
      ? {
          orientation: tab.snapshot.orientation,
          turnHint: tab.snapshot.turnHint,
          moveCount: Array.isArray(tab.snapshot.moves) ? tab.snapshot.moves.length : null,
          hasMoveList: Array.isArray(tab.snapshot.moves),
        }
      : null,
    turnOverride: tab?.turnOverride ?? null,
    result: tab?.result || null,
    error: tab?.error || null,
  };
}

let pushQueued = false;
function pushState(extra = {}) {
  if (pushQueued) return;
  pushQueued = true;
  // Движок присылает уточнения десятки раз в секунду — панели столько не нужно.
  setTimeout(async () => {
    pushQueued = false;
    try {
      const state = await buildState(extra.settings);
      await chrome.runtime.sendMessage({ target: 'panel', type: MSG.STATE_UPDATE, payload: { ...state, ...extra } });
    } catch {
      // Панель закрыта — слушателей нет, это не ошибка.
    }
  }, 60);
}
