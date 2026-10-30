/**
 * Единый протокол обмена сообщениями между частями расширения.
 *
 * Файл намеренно написан так, чтобы работать и как classic script
 * (подключается в content_scripts и выставляет globalThis.CC),
 * и как ES-модуль (side-effect import в service worker / offscreen / panel).
 */
globalThis.CC = Object.freeze({
  MSG: Object.freeze({
    // content script -> service worker
    CONTENT_READY: 'cc:content-ready',
    BOARD_UPDATE: 'cc:board-update',

    // side panel -> service worker
    PANEL_READY: 'cc:panel-ready',
    PATCH_SETTINGS: 'cc:patch-settings',
    REQUEST_ANALYSIS: 'cc:request-analysis',
    ANALYZE_FEN: 'cc:analyze-fen',
    STOP_ANALYSIS: 'cc:stop-analysis',
    OVERRIDE_TURN: 'cc:override-turn',

    // service worker -> offscreen
    ENGINE_START: 'cc:engine-start',
    ENGINE_ANALYZE: 'cc:engine-analyze',
    ENGINE_STOP: 'cc:engine-stop',

    // offscreen -> service worker (broadcast)
    ENGINE_STATUS: 'cc:engine-status',
    ENGINE_PARTIAL: 'cc:engine-partial',
    ENGINE_RESULT: 'cc:engine-result',
    ENGINE_ERROR: 'cc:engine-error',

    // service worker -> content script
    DRAW_ARROWS: 'cc:draw-arrows',
    CLEAR_ARROWS: 'cc:clear-arrows',
    PING: 'cc:ping',

    // service worker -> side panel
    STATE_UPDATE: 'cc:state-update',
  }),

  /** Значения по умолчанию, хранятся в chrome.storage.local под ключом SETTINGS_KEY. */
  DEFAULTS: Object.freeze({
    /** Целевая сила движка в очках Эло. 3200 = «без ограничений». */
    elo: 1600,
    /** Время на обдумывание одного хода, мс. */
    movetimeMs: 1000,
    /** Сколько вариантов считать (MultiPV). */
    multipv: 3,
    /** Автоматически анализировать позицию при каждом изменении доски. */
    autoAnalyze: true,
    /** Рисовать стрелки поверх доски сайта. */
    showArrows: true,
    /** Сколько стрелок рисовать (не больше multipv). */
    arrowCount: 2,
    /** Дополнительно считать ход на максимальной силе для сравнения. */
    compareBest: false,
    /** Анализировать только когда ход за выбранную сторону: 'both' | 'white' | 'black'. */
    analyzeFor: 'both',
  }),

  SETTINGS_KEY: 'cc:settings',

  /** 3200 в UI означает «снять ограничение силы». */
  ELO_UI_MIN: 500,
  ELO_UI_MAX: 3200,
});
