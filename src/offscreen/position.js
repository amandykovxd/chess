/**
 * Превращение «снимка доски», собранного content script'ом, в корректный FEN.
 *
 * Два источника, от точного к приблизительному:
 *   1. Список ходов партии — переигрываем от начальной позиции и получаем
 *      безупречный FEN: с правом рокировки, взятием на проходе и счётчиками.
 *   2. Расстановка фигур — если списка ходов нет (задачи, расстановка вручную,
 *      изменившаяся вёрстка сайта). Права рокировки тогда приходится оценивать.
 */
import { Chess, validateFen } from '../vendor/chess.js';

const START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

/**
 * @param {{pieces:Record<string,string>|null, moves:string[]|null,
 *          turnHint:'w'|'b'|null, lastMove:{from:string,to:string}|null,
 *          turnOverride:'w'|'b'|null}} snap
 * @returns {{fen:string, source:'movelist'|'pieces', exact:boolean,
 *            turn:'w'|'b', warnings:string[], gameOver:string|null}|
 *           {error:string}}
 */
export function resolvePosition(snap) {
  const warnings = [];

  // --- Источник 1: переигровка списка ходов ---
  if (Array.isArray(snap.moves)) {
    const replay = replayMoves(snap.moves);
    if (replay.ok) {
      const matches = !snap.pieces || boardMatchesPieces(replay.game, snap.pieces);
      if (matches) {
        // Ручная смена очереди хода имеет приоритет даже над точным FEN:
        // пользователь мог захотеть посмотреть «а что если ход соперника».
        const fen = snap.turnOverride && snap.turnOverride !== replay.game.turn()
          ? withTurn(replay.game.fen(), snap.turnOverride, warnings)
          : replay.game.fen();
        return finalize(fen, 'movelist', true, warnings);
      }
      warnings.push('Список ходов не совпал с расстановкой на доске — позиция собрана по фигурам.');
    } else if (snap.moves.length) {
      warnings.push(`Не удалось разобрать список ходов (${replay.error}) — позиция собрана по фигурам.`);
    }
  }

  // --- Источник 2: расстановка фигур ---
  if (!snap.pieces || Object.keys(snap.pieces).length === 0) {
    return { error: 'Не удалось прочитать доску на странице.' };
  }
  return fromPieces(snap, warnings);
}

function replayMoves(moves) {
  const game = new Chess();
  for (const san of moves) {
    if (!san) continue;
    try {
      game.move(san);
    } catch {
      return { ok: false, error: `ход «${san}»` };
    }
  }
  return { ok: true, game };
}

function fromPieces(snap, warnings) {
  const placement = placementFromPieces(snap.pieces);
  const turn = snap.turnOverride || snap.turnHint || 'w';
  if (!snap.turnOverride && !snap.turnHint) {
    warnings.push('Очередь хода определить не удалось — считаем, что ход белых. Переключите вручную, если не так.');
  }

  const castling = estimateCastling(snap.pieces);
  if (castling !== '-' && !piecesLookLikeStart(snap.pieces)) {
    warnings.push('Права на рокировку определены приблизительно (по положению короля и ладей).');
  }
  const ep = estimateEnPassant(snap.pieces, snap.lastMove, turn);
  const fullmove = Array.isArray(snap.moves) ? Math.floor(snap.moves.length / 2) + 1 : 1;

  const candidates = [
    `${placement} ${turn} ${castling} ${ep} 0 ${fullmove}`,
    `${placement} ${turn} ${castling} - 0 ${fullmove}`,
    `${placement} ${turn} - - 0 ${fullmove}`,
    `${placement} ${turn === 'w' ? 'b' : 'w'} - - 0 ${fullmove}`,
  ];

  for (let i = 0; i < candidates.length; i++) {
    const fen = candidates[i];
    if (!validateFen(fen).ok) continue;
    // Король стороны, которая НЕ ходит, не может стоять под шахом: такую позицию
    // validateFen пропускает, а движок на ней выдаёт мусор.
    if (idleKingInCheck(fen)) continue;
    try {
      const game = new Chess(fen);
      // Позиция должна быть играбельной: иначе движку нечего считать.
      if (!game.moves().length && !game.isGameOver()) continue;
      if (i === 3) warnings.push('Очередь хода исправлена автоматически: при указанной стороне позиция была невозможна.');
      return finalize(fen, 'pieces', false, warnings);
    } catch {
      /* пробуем следующий вариант */
    }
  }
  return { error: 'Позиция на доске некорректна с точки зрения правил — возможно, идёт анимация хода.' };
}

/** Стоит ли под шахом король той стороны, чья очередь хода уже прошла. */
function idleKingInCheck(fen) {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  try {
    return new Chess(parts.join(' ')).isCheck();
  } catch {
    return false;
  }
}

function finalize(fen, source, exact, warnings) {
  let game;
  try {
    game = new Chess(fen);
  } catch (err) {
    return { error: `Некорректный FEN: ${err.message}` };
  }
  return {
    fen: game.fen(),
    source,
    exact,
    turn: game.turn(),
    warnings,
    gameOver: describeGameOver(game),
  };
}

function describeGameOver(game) {
  if (!game.isGameOver()) return null;
  if (game.isCheckmate()) return game.turn() === 'w' ? 'Мат. Белые проиграли.' : 'Мат. Чёрные проиграли.';
  if (game.isStalemate()) return 'Пат — ничья.';
  if (game.isInsufficientMaterial()) return 'Недостаточно материала — ничья.';
  if (game.isThreefoldRepetition()) return 'Троекратное повторение — ничья.';
  if (game.isDraw()) return 'Ничья.';
  return 'Партия окончена.';
}

function withTurn(fen, turn, warnings) {
  const parts = fen.split(' ');
  parts[1] = turn;
  parts[3] = '-'; // взятие на проходе после смены очереди хода невозможно
  warnings.push('Очередь хода изменена вручную.');
  return parts.join(' ');
}

/** `{e2:'wP'}` -> `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR` */
function placementFromPieces(pieces) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const square = String.fromCharCode(97 + file) + rank;
      const code = pieces[square];
      if (!code) {
        empty++;
        continue;
      }
      if (empty) {
        row += String(empty);
        empty = 0;
      }
      const letter = code[1];
      row += code[0] === 'w' ? letter.toUpperCase() : letter.toLowerCase();
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  return rows.join('/');
}

function estimateCastling(pieces) {
  let rights = '';
  if (pieces.e1 === 'wK') {
    if (pieces.h1 === 'wR') rights += 'K';
    if (pieces.a1 === 'wR') rights += 'Q';
  }
  if (pieces.e8 === 'bK') {
    if (pieces.h8 === 'bR') rights += 'k';
    if (pieces.a8 === 'bR') rights += 'q';
  }
  return rights || '-';
}

/** Поле взятия на проходе выводим из последнего хода, если им был двойной ход пешки. */
function estimateEnPassant(pieces, lastMove, turn) {
  if (!lastMove?.from || !lastMove?.to) return '-';
  const code = pieces[lastMove.to];
  if (!code || code[1] !== 'P') return '-';
  const fromRank = Number(lastMove.from[1]);
  const toRank = Number(lastMove.to[1]);
  if (lastMove.from[0] !== lastMove.to[0] || Math.abs(toRank - fromRank) !== 2) return '-';
  // Взятие на проходе доступно только тому, чей ход сейчас.
  if (code[0] === 'w' && turn !== 'b') return '-';
  if (code[0] === 'b' && turn !== 'w') return '-';
  return lastMove.to[0] + (fromRank + (toRank > fromRank ? 1 : -1));
}

function piecesLookLikeStart(pieces) {
  return placementFromPieces(pieces) === START_PLACEMENT;
}

function boardMatchesPieces(game, pieces) {
  const expected = new Map();
  for (const row of game.board()) {
    for (const cell of row) {
      if (cell) expected.set(cell.square, cell.color + cell.type.toUpperCase());
    }
  }
  if (expected.size !== Object.keys(pieces).length) return false;
  for (const [square, code] of expected) {
    if (pieces[square] !== code) return false;
  }
  return true;
}

/**
 * Переводит ходы из UCI (`e2e4`, `e7e8q`) в человекочитаемую нотацию.
 * Останавливается на первом невозможном ходе — обрезанный PV всё равно полезен.
 */
export function uciLineToSan(fen, uciMoves, limit = 12) {
  let game;
  try {
    game = new Chess(fen);
  } catch {
    return { san: [], detail: [] };
  }
  const san = [];
  const detail = [];
  for (const uci of uciMoves.slice(0, limit)) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    let move;
    try {
      move = game.move({ from, to, promotion });
    } catch {
      break;
    }
    san.push(move.san);
    detail.push({ uci, from: move.from, to: move.to, san: move.san, piece: move.piece, color: move.color });
  }
  return { san, detail };
}

/** Номер хода и сторона для подписи варианта: «15… Nf3». */
export function moveLabel(fen) {
  const parts = fen.split(' ');
  return { fullmove: Number(parts[5]) || 1, turn: parts[1] === 'b' ? 'b' : 'w' };
}
