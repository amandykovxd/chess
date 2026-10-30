/**
 * Тонкая обёртка над Stockfish WASM, говорящая на UCI.
 *
 * Сборка stockfish-19-lite-single.js рассчитана на запуск прямо как Web Worker:
 * она сама заводит onmessage и принимает UCI-команды строками. Файл .wasm
 * находится рядом — путь движок выводит из своего собственного URL.
 */

const SEARCH_GRACE_MS = 20000; // запас сверх movetime, после которого считаем поиск зависшим

export class UciEngine {
  /** @param {string} scriptUrl абсолютный URL скрипта движка (chrome.runtime.getURL) */
  constructor(scriptUrl) {
    this.scriptUrl = scriptUrl;
    this.worker = null;
    /** @type {Record<string, {type:string, default?:string, min?:number, max?:number, vars?:string[]}>} */
    this.options = {};
    this.ready = false;
    this.appliedOptions = new Map();

    this._lineHandlers = new Set();
    this._queued = null;   // последний запрос побеждает
    this._draining = false;
    this._searching = false;
  }

  async start() {
    if (this.worker) return;

    this.worker = new Worker(this.scriptUrl);
    this.worker.onmessage = (ev) => {
      const data = ev.data;
      const line = typeof data === 'string' ? data : data?.text ?? '';
      if (!line) return;
      for (const h of [...this._lineHandlers]) {
        try { h(line); } catch (e) { console.error('[uci] handler failed', e); }
      }
    };
    this.worker.onerror = (ev) => {
      const err = new Error(`Ошибка воркера движка: ${ev.message || 'неизвестно'}`);
      for (const h of [...this._lineHandlers]) {
        try { h(`__error__ ${err.message}`); } catch { /* ignore */ }
      }
      console.error('[uci]', err);
    };

    await this._handshake();
    this.ready = true;
  }

  /** Отправляет `uci`, собирает список опций, ждёт `uciok`. */
  _handshake() {
    return this._collect({
      send: 'uci',
      until: (line) => line.trim() === 'uciok',
      onLine: (line) => {
        if (line.startsWith('option name ')) {
          const opt = parseOptionLine(line);
          if (opt) this.options[opt.name] = opt.spec;
        } else if (line.startsWith('id name ')) {
          this.id = line.slice('id name '.length).trim();
        }
      },
      timeoutMs: 60000,
      what: 'инициализация движка',
    });
  }

  post(cmd) {
    if (!this.worker) throw new Error('Движок не запущен');
    this.worker.postMessage(cmd);
  }

  /** Ждёт `readyok` — гарантия, что все setoption применены. */
  isReady() {
    return this._collect({
      send: 'isready',
      until: (line) => line.trim() === 'readyok',
      timeoutMs: 30000,
      what: 'isready',
    });
  }

  /** Выставляет опции, пропуская те, что уже имеют нужное значение. */
  async applyOptions(options) {
    let changed = false;
    for (const [name, value] of Object.entries(options)) {
      if (!(name in this.options)) continue;          // движок такой опции не знает
      if (this.appliedOptions.get(name) === String(value)) continue;
      this.post(`setoption name ${name} value ${value}`);
      this.appliedOptions.set(name, String(value));
      changed = true;
    }
    if (changed) await this.isReady();
    return changed;
  }

  /**
   * Запрашивает анализ. Если во время поиска придёт новый запрос, текущий
   * прерывается (`stop`), и считается только самый свежий — так доска не
   * «отстаёт» от движка при быстрой перемотке партии.
   *
   * @param {{fen:string, multipv:number, movetimeMs:number, depthCap:number|null,
   *          options:Record<string,string>, token:any,
   *          onPartial?:(lines:any[], meta:any)=>void}} req
   * @returns {Promise<{bestmove:string|null, ponder:string|null, lines:any[], superseded:boolean}>}
   */
  request(req) {
    return new Promise((resolve, reject) => {
      // Предыдущий запрос, ещё не начавший считаться, просто выбрасываем.
      if (this._queued) this._queued.resolve({ bestmove: null, ponder: null, lines: [], superseded: true });
      this._queued = { req, resolve, reject };
      if (this._searching) this.post('stop');
      if (!this._draining) this._drain();
    });
  }

  async _drain() {
    this._draining = true;
    try {
      while (this._queued) {
        const { req, resolve, reject } = this._queued;
        this._queued = null;
        try {
          const result = await this._search(req);
          resolve({ ...result, superseded: Boolean(this._queued) });
        } catch (err) {
          reject(err);
        }
      }
    } finally {
      this._draining = false;
    }
  }

  async _search(req) {
    await this.applyOptions({ MultiPV: String(Math.max(1, req.multipv)), ...req.options });

    const lines = new Map();
    let meta = { depth: 0, nodes: 0, nps: 0, timeMs: 0 };

    const go = buildGoCommand(req);
    this._searching = true;

    try {
      const result = await this._collect({
        send: [`position fen ${req.fen}`, go],
        until: (line) => line.startsWith('bestmove'),
        onLine: (line) => {
          if (line.startsWith('__error__')) throw new Error(line.slice(10));
          if (!line.startsWith('info ')) return;
          const info = parseInfoLine(line);
          if (!info) return;
          if (info.depth) meta = { ...meta, ...pick(info, ['depth', 'seldepth', 'nodes', 'nps', 'timeMs', 'hashfull']) };
          if (info.pv?.length && info.score) {
            lines.set(info.multipv, { ...info, rank: info.multipv });
            req.onPartial?.(sortLines(lines), meta);
          }
          // Пришёл более свежий запрос — обрываем текущий поиск.
          if (this._queued) this.post('stop');
        },
        timeoutMs: (req.movetimeMs || 1000) + SEARCH_GRACE_MS,
        what: 'поиск хода',
      });

      const m = /^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/.exec(result.lastLine || '');
      const bestmove = m && m[1] !== '(none)' ? m[1] : null;
      return { bestmove, ponder: m?.[2] ?? null, lines: sortLines(lines), meta };
    } finally {
      this._searching = false;
    }
  }

  /** Отправляет команды и слушает строки до срабатывания `until`. */
  _collect({ send, until, onLine, timeoutMs, what }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`Таймаут: ${what}`)));
      }, timeoutMs);

      const handler = (line) => {
        if (settled) return;
        try {
          onLine?.(line);
        } catch (err) {
          finish(() => reject(err));
          return;
        }
        if (until(line)) finish(() => resolve({ lastLine: line }));
      };

      const finish = (done) => {
        settled = true;
        clearTimeout(timer);
        this._lineHandlers.delete(handler);
        done();
      };

      this._lineHandlers.add(handler);
      try {
        for (const cmd of Array.isArray(send) ? send : [send]) this.post(cmd);
      } catch (err) {
        finish(() => reject(err));
      }
    });
  }

  quit() {
    try { this.post('quit'); } catch { /* ignore */ }
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.appliedOptions.clear();
  }
}

function buildGoCommand(req) {
  const parts = ['go'];
  if (req.depthCap) {
    // В режиме имитации слабой игры глубина — главный ограничитель,
    // но время всё равно страхует от зависания на сложной позиции.
    parts.push('depth', String(req.depthCap));
    parts.push('movetime', String(Math.min(req.movetimeMs || 1000, 1500)));
  } else {
    parts.push('movetime', String(Math.max(50, req.movetimeMs || 1000)));
  }
  return parts.join(' ');
}

function sortLines(map) {
  return [...map.values()].sort((a, b) => a.rank - b.rank);
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** `option name UCI_Elo type spin default 1320 min 1320 max 3190` */
export function parseOptionLine(line) {
  const m = /^option name (.+?) type (\w+)(.*)$/.exec(line.trim());
  if (!m) return null;
  const [, name, type, rest] = m;
  const spec = { type };
  const def = /\bdefault\s+(.*?)(?=\s+(?:min|max|var)\s|$)/.exec(rest);
  if (def) spec.default = def[1].trim();
  const min = /\bmin\s+(-?\d+)/.exec(rest);
  if (min) spec.min = Number(min[1]);
  const max = /\bmax\s+(-?\d+)/.exec(rest);
  if (max) spec.max = Number(max[1]);
  const vars = [...rest.matchAll(/\bvar\s+(\S+)/g)].map((v) => v[1]);
  if (vars.length) spec.vars = vars;
  return { name, spec };
}

/**
 * `info depth 18 multipv 1 score cp 24 nodes 1234 nps 900000 time 300 pv e2e4 e7e5`
 * Оценка в UCI — всегда с точки зрения той стороны, чей ход.
 */
export function parseInfoLine(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'info') return null;

  const out = { multipv: 1, bound: null };
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case 'depth': out.depth = Number(tokens[++i]); break;
      case 'seldepth': out.seldepth = Number(tokens[++i]); break;
      case 'multipv': out.multipv = Number(tokens[++i]); break;
      case 'nodes': out.nodes = Number(tokens[++i]); break;
      case 'nps': out.nps = Number(tokens[++i]); break;
      case 'hashfull': out.hashfull = Number(tokens[++i]); break;
      case 'time': out.timeMs = Number(tokens[++i]); break;
      case 'score': {
        const kind = tokens[++i];
        const value = Number(tokens[++i]);
        out.score = kind === 'mate' ? { mate: value } : { cp: value };
        break;
      }
      case 'upperbound': out.bound = 'upper'; break;
      case 'lowerbound': out.bound = 'lower'; break;
      case 'pv': out.pv = tokens.slice(i + 1); i = tokens.length; break;
      default: break;
    }
  }
  return out;
}
