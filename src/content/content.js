/**
 * Content script: следит за доской на странице и отправляет её снимки в
 * service worker, а обратно получает стрелки для отрисовки.
 *
 * Весь шахматный «интеллект» живёт в offscreen-документе; здесь только DOM.
 */
(() => {
  const { MSG } = globalThis.CC;
  const Adapters = globalThis.CC_ADAPTERS;
  const Overlay = globalThis.CC_OVERLAY;

  const adapter = Adapters.current();
  if (!adapter) return;

  /** Пауза после последней мутации: за это время успевают доиграть анимации хода. */
  const SETTLE_MS = 180;
  /** Страховочная проверка на случай перерисовок, которые MutationObserver не поймал. */
  const POLL_MS = 1200;
  /**
   * Сайты меняют DOM почти непрерывно (часы, подсветки, чат), поэтому «тихой»
   * паузы можно и не дождаться. Дольше этого времени снимок не задерживаем.
   */
  const MAX_DEFER_MS = 600;

  let lastSignature = null;
  let lastPieces = null;
  let settleTimer = null;
  let deferredSince = 0;
  let currentBoard = null;

  // ------------------------------------------------------- сбор состояния

  function buildSnapshot() {
    const snap = Adapters.snapshot(adapter);
    if (!snap) return null;

    const { board, ...rest } = snap;
    currentBoard = board;
    Overlay.setBoard(board, rest.orientation);

    return {
      ...rest,
      turnHint: resolveTurn(rest),
    };
  }

  /**
   * Очередь хода по степени надёжности:
   *   1. длина списка ходов (точно, если список прочитан);
   *   2. работающие часы игрока;
   *   3. сравнение с предыдущим снимком — ходила одна сторона, значит теперь другая.
   */
  function resolveTurn(snap) {
    if (Array.isArray(snap.moves)) return snap.moves.length % 2 === 0 ? 'w' : 'b';
    if (snap.turnFromClock) return snap.turnFromClock;
    const moved = colorThatMoved(lastPieces, snap.pieces);
    if (moved) return moved === 'w' ? 'b' : 'w';
    return null;
  }

  function colorThatMoved(before, after) {
    if (!before) return null;
    const colors = new Set();
    for (const [sq, code] of Object.entries(after)) {
      if (before[sq] !== code) colors.add(code[0]);
    }
    // Если «появились» фигуры обоих цветов, это не один ход — перемотка или новая партия.
    return colors.size === 1 ? [...colors][0] : null;
  }

  function signatureOf(snap) {
    const squares = Object.keys(snap.pieces).sort();
    return [
      snap.orientation,
      snap.turnHint || '?',
      Array.isArray(snap.moves) ? snap.moves.length : 'n',
      squares.map((sq) => sq + snap.pieces[sq]).join(''),
    ].join('|');
  }

  function publish({ force = false } = {}) {
    const snap = buildSnapshot();
    if (!snap) {
      lastSignature = null;
      Overlay.clear();
      return;
    }
    const signature = signatureOf(snap);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    lastPieces = snap.pieces;

    chrome.runtime
      .sendMessage({ type: MSG.BOARD_UPDATE, payload: { site: adapter.id, snapshot: snap, force } })
      .catch(() => {
        // Service worker перезапускается — следующий снимок дойдёт.
      });
  }

  function schedulePublish(force) {
    const now = Date.now();
    if (!deferredSince) deferredSince = now;
    if (now - deferredSince >= MAX_DEFER_MS) {
      clearTimeout(settleTimer);
      settleTimer = null;
      deferredSince = 0;
      publish({ force });
      return;
    }
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      deferredSince = 0;
      publish({ force });
    }, SETTLE_MS);
  }

  // ------------------------------------------------------------ наблюдение

  const observer = new MutationObserver(() => schedulePublish(false));
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });

  setInterval(() => publish({ force: false }), POLL_MS);

  // Перемотка партии стрелками клавиатуры меняет доску без мутаций классов доски.
  window.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) schedulePublish(false);
  }, { passive: true });

  // ------------------------------------------------------------- сообщения

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case MSG.DRAW_ARROWS:
        Overlay.draw(msg.payload?.arrows || []);
        sendResponse({ ok: true });
        return false;
      case MSG.CLEAR_ARROWS:
        Overlay.clear();
        sendResponse({ ok: true });
        return false;
      case MSG.PING:
        publish({ force: true });
        sendResponse({ ok: true, site: adapter.id });
        return false;
      default:
        return undefined;
    }
  });

  chrome.runtime
    .sendMessage({ type: MSG.CONTENT_READY, payload: { site: adapter.id } })
    .catch(() => {});

  publish({ force: true });
})();
