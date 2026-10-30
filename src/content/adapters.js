/**
 * Адаптеры к вёрстке конкретных сайтов.
 *
 * Задача адаптера — отдать «снимок» доски:
 *   { pieces: {'e2': 'wP', ...}, orientation: 'white'|'black',
 *     moves: ['e4','e5',...] | null, lastMove: {from,to} | null, turnFromClock: 'w'|'b'|null }
 *
 * Расстановка фигур читается всегда, список ходов — когда получится. Список
 * ходов даёт точный FEN (рокировки, взятие на проходе), поэтому он в приоритете,
 * но вёрстка сайтов меняется, и расстановка остаётся надёжным запасным путём.
 */
(() => {
  const FILES = 'abcdefgh';

  const ROLE_LETTER = {
    pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K',
    p: 'P', n: 'N', b: 'B', r: 'R', q: 'Q', k: 'K',
  };

  function square(fileIdx, rankIdx) {
    if (fileIdx < 0 || fileIdx > 7 || rankIdx < 0 || rankIdx > 7) return null;
    return FILES[fileIdx] + (rankIdx + 1);
  }

  /** Визуальные координаты (столбец/строка сверху-слева) → имя поля. */
  function visualToSquare(col, row, orientation) {
    const c = Math.round(col);
    const r = Math.round(row);
    return orientation === 'black' ? square(7 - c, r) : square(c, 7 - r);
  }

  /** Разбирает `transform: translate(100%, 200%)` или `translate(56px, 112px)`. */
  function parseTranslate(el, squareSizePx) {
    const t = el.style?.transform || '';
    const m = /translate(?:3d)?\(\s*(-?[\d.]+)(px|%)?\s*,\s*(-?[\d.]+)(px|%)?/.exec(t);
    if (!m) return null;
    const x = Number(m[1]);
    const y = Number(m[3]);
    const unit = m[2] || m[4] || 'px';
    if (unit === '%') return { col: x / 100, row: y / 100 };
    if (!squareSizePx) return null;
    return { col: x / squareSizePx, row: y / squareSizePx };
  }

  /** Из нескольких досок на странице берём самую большую — она и есть основная. */
  function largest(nodes, hasContent) {
    let best = null;
    let bestWidth = 0;
    for (const el of nodes) {
      if (hasContent && !hasContent(el)) continue;
      const w = el.getBoundingClientRect().width;
      if (w > bestWidth) {
        best = el;
        bestWidth = w;
      }
    }
    return bestWidth >= 80 ? best : null;
  }

  /** Склеивает текст хода, подставляя букву фигуры из data-figurine вместо иконки. */
  function sanFromNode(root) {
    let out = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const fig = child.getAttribute('data-figurine');
          if (fig) out += fig;
          else walk(child);
        }
      }
    };
    walk(root);
    return cleanSan(out);
  }

  /** Убирает номера ходов, оценки и значки, оставляя чистую нотацию. */
  function cleanSan(raw) {
    return String(raw)
      .replace(/\s+/g, '')
      .replace(/^\d+\.+/, '')
      .replace(/[!?]+/g, '')
      .replace(/[^KQRBNOa-h1-8x=+#-]/g, '');
  }

  /** Обрезает список ходов по выделенному (текущему) ходу — так работает перемотка партии. */
  function sliceToActive(nodes, isActive) {
    const list = [...nodes];
    const idx = list.findIndex(isActive);
    return idx >= 0 ? list.slice(0, idx + 1) : list;
  }

  // ------------------------------------------------------------ chess.com

  const chesscom = {
    id: 'chess.com',
    label: 'Chess.com',
    matches: () => /(^|\.)chess\.com$/.test(location.hostname),

    findBoard() {
      const nodes = document.querySelectorAll('wc-chess-board, chess-board, .board, .board-component');
      return largest(nodes, (el) => el.querySelector('.piece'));
    },

    orientation(board) {
      return board.classList.contains('flipped') ? 'black' : 'white';
    },

    readPieces(board) {
      const pieces = {};
      const squareSize = board.getBoundingClientRect().width / 8;
      const orientation = this.orientation(board);

      for (const el of board.querySelectorAll('.piece')) {
        // Фигура «в руке» при перетаскивании — позиция у неё промежуточная.
        if (el.classList.contains('dragging')) continue;

        let code = null;
        let sq = null;
        for (const cls of el.classList) {
          const piece = /^([wb])([pnbrqk])$/.exec(cls);
          if (piece) {
            code = piece[1] + piece[2].toUpperCase();
            continue;
          }
          const pos = /^square-([1-8])([1-8])$/.exec(cls);
          if (pos) sq = square(Number(pos[1]) - 1, Number(pos[2]) - 1);
        }
        if (!sq) {
          const v = parseTranslate(el, squareSize);
          if (v) sq = visualToSquare(v.col, v.row, orientation);
        }
        if (code && sq) pieces[sq] = code;
      }
      return pieces;
    },

    readMoves() {
      const containers = [
        'wc-simple-move-list',
        'wc-vertical-move-list',
        'wc-horizontal-move-list',
        '.move-list',
        '.vertical-move-list',
      ];
      for (const sel of containers) {
        const root = document.querySelector(sel);
        if (!root) continue;
        const nodes = [...root.querySelectorAll('.node')].filter((n) => !n.closest('.variation, .line'));
        if (!nodes.length) continue;
        const active = sliceToActive(nodes, (n) => n.classList.contains('selected'));
        const moves = active
          .map((n) => sanFromNode(n.querySelector('.node-highlight-content') || n))
          .filter(Boolean);
        if (moves.length) return moves;
      }
      return null;
    },

    /** Поля последнего хода подсвечены; занятое из них — куда пошли, пустое — откуда. */
    lastMove(board, pieces) {
      const squares = [];
      for (const el of board.querySelectorAll('.highlight')) {
        for (const cls of el.classList) {
          const pos = /^square-([1-8])([1-8])$/.exec(cls);
          if (pos) squares.push(square(Number(pos[1]) - 1, Number(pos[2]) - 1));
        }
      }
      return pickFromTo(squares, pieces);
    },

    turnFromClock(orientation) {
      const bottom = document.querySelector('.clock-bottom.clock-player-turn');
      const top = document.querySelector('.clock-top.clock-player-turn');
      const bottomColor = orientation === 'black' ? 'b' : 'w';
      if (bottom) return bottomColor;
      if (top) return bottomColor === 'w' ? 'b' : 'w';
      return null;
    },
  };

  // -------------------------------------------------------------- lichess

  const lichess = {
    id: 'lichess',
    label: 'Lichess',
    matches: () => /(^|\.)lichess\.org$/.test(location.hostname),

    findBoard() {
      return largest(document.querySelectorAll('cg-board'), (el) => el.querySelector('piece'));
    },

    orientation(board) {
      const wrap = board.closest('.cg-wrap');
      return wrap?.classList.contains('orientation-black') ? 'black' : 'white';
    },

    readPieces(board) {
      const pieces = {};
      const squareSize = board.getBoundingClientRect().width / 8;
      const orientation = this.orientation(board);

      for (const el of board.querySelectorAll('piece')) {
        // ghost — «тень» перетаскиваемой фигуры, fading — доигрывающая анимация взятия.
        if (el.classList.contains('ghost') || el.classList.contains('fading')) continue;

        let color = null;
        let role = null;
        for (const cls of el.classList) {
          if (cls === 'white' || cls === 'black') color = cls[0];
          else if (ROLE_LETTER[cls]) role = ROLE_LETTER[cls];
        }
        if (!color || !role) continue;

        const v = parseTranslate(el, squareSize) || { col: 0, row: 0 };
        const sq = visualToSquare(v.col, v.row, orientation);
        if (sq) pieces[sq] = color + role;
      }
      return pieces;
    },

    readMoves() {
      const groups = [
        'l4x kwdb',
        'rm6 kwdb',
        '.tview2-column move',
        '.tview2 move',
        '.replay move',
      ];
      for (const sel of groups) {
        const nodes = [...document.querySelectorAll(sel)].filter(
          (n) => !n.closest('lines, line, interrupt'),
        );
        if (!nodes.length) continue;
        const active = sliceToActive(nodes, (n) => n.classList.contains('active'));
        const moves = active.map((n) => sanFromNode(n)).filter(Boolean);
        if (moves.length) return moves;
      }
      return null;
    },

    lastMove(board, pieces) {
      const squareSize = board.getBoundingClientRect().width / 8;
      const orientation = this.orientation(board);
      const squares = [];
      for (const el of board.querySelectorAll('square.last-move')) {
        const v = parseTranslate(el, squareSize) || { col: 0, row: 0 };
        const sq = visualToSquare(v.col, v.row, orientation);
        if (sq) squares.push(sq);
      }
      return pickFromTo(squares, pieces);
    },

    turnFromClock(orientation) {
      const bottomColor = orientation === 'black' ? 'b' : 'w';
      if (document.querySelector('.rclock-bottom .time.running, .rclock-bottom.running')) return bottomColor;
      if (document.querySelector('.rclock-top .time.running, .rclock-top.running')) {
        return bottomColor === 'w' ? 'b' : 'w';
      }
      return null;
    },
  };

  function pickFromTo(squares, pieces) {
    const uniq = [...new Set(squares.filter(Boolean))];
    if (uniq.length !== 2) return null;
    const [a, b] = uniq;
    const aOccupied = Boolean(pieces[a]);
    const bOccupied = Boolean(pieces[b]);
    if (aOccupied === bOccupied) return null; // рокировка или неоднозначность — лучше ничего
    return aOccupied ? { from: b, to: a } : { from: a, to: b };
  }

  const ADAPTERS = [chesscom, lichess];

  globalThis.CC_ADAPTERS = {
    FILES,
    square,
    visualToSquare,

    /** Адаптер под текущий домен, либо null. */
    current() {
      return ADAPTERS.find((a) => a.matches()) || null;
    },

    /** Полный снимок доски или null, если доски на странице нет. */
    snapshot(adapter) {
      const board = adapter.findBoard();
      if (!board) return null;

      const orientation = adapter.orientation(board);
      const pieces = adapter.readPieces(board);
      if (Object.keys(pieces).length < 2) return null; // на доске нет даже двух королей

      return {
        board,
        site: adapter.id,
        orientation,
        pieces,
        moves: adapter.readMoves(),
        lastMove: adapter.lastMove(board, pieces),
        turnFromClock: adapter.turnFromClock(orientation),
      };
    },
  };
})();
