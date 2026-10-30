/**
 * Рисование стрелок поверх доски сайта.
 *
 * Оверлей — отдельный <svg> с viewBox "0 0 8 8", прижатый к границам доски.
 * Благодаря такому viewBox вся геометрия считается в «клетках»: толщина
 * стрелки 0.17 — это 17% ширины поля, и всё само масштабируется вместе с доской.
 */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const FILES = 'abcdefgh';

  // Геометрия стрелки в долях клетки.
  const HEAD_LEN = 0.38;
  const HEAD_HALF = 0.26;
  const START_GAP = 0.3; // отступ от центра поля, чтобы не закрывать саму фигуру

  let root = null;
  let svg = null;
  let board = null;
  let orientation = 'white';
  let arrows = [];
  let syncScheduled = false;
  let observer = null;
  let listening = false;

  function ensureRoot() {
    if (root && root.isConnected) return;
    root = document.createElement('div');
    root.className = 'cc-overlay-root';
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 8 8');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.classList.add('cc-overlay-svg');
    root.appendChild(svg);
    document.body.appendChild(root);
  }

  function squareCenter(sq) {
    const file = FILES.indexOf(sq[0]);
    const rank = Number(sq[1]) - 1;
    if (file < 0 || !(rank >= 0 && rank <= 7)) return null;
    // Переводим в визуальные координаты с учётом разворота доски.
    const col = orientation === 'black' ? 7 - file : file;
    const row = orientation === 'black' ? rank : 7 - rank;
    return { x: col + 0.5, y: row + 0.5 };
  }

  function arrowPath(from, to, width) {
    const a = squareCenter(from);
    const b = squareCenter(to);
    if (!a || !b) return null;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.1) return null;

    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;

    const start = { x: a.x + ux * START_GAP, y: a.y + uy * START_GAP };
    const headLen = Math.min(HEAD_LEN, (len - START_GAP) * 0.6);
    const baseDist = len - START_GAP - headLen;
    const base = { x: start.x + ux * baseDist, y: start.y + uy * baseDist };
    const w = width / 2;

    const pts = [
      [start.x + px * w, start.y + py * w],
      [base.x + px * w, base.y + py * w],
      [base.x + px * HEAD_HALF, base.y + py * HEAD_HALF],
      [b.x, b.y],
      [base.x - px * HEAD_HALF, base.y - py * HEAD_HALF],
      [base.x - px * w, base.y - py * w],
      [start.x - px * w, start.y - py * w],
    ];
    return `M${pts.map(([x, y]) => `${round(x)},${round(y)}`).join('L')}Z`;
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  function render() {
    ensureRoot();
    svg.textContent = '';
    if (!arrows.length) return;

    for (const arrow of arrows) {
      const d = arrowPath(arrow.from, arrow.to, arrow.width ?? 0.15);
      if (!d) continue;

      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', arrow.color || '#19a974');
      path.setAttribute('fill-opacity', String(arrow.opacity ?? 0.85));
      path.setAttribute('stroke', 'rgba(0,0,0,0.35)');
      path.setAttribute('stroke-width', '0.015');
      if (arrow.dashed) path.setAttribute('stroke-dasharray', '0.12 0.09');
      svg.appendChild(path);
    }

    // Подписи рисуем после всех стрелок, чтобы они не оказались под ними.
    for (const arrow of arrows) {
      if (!arrow.label) continue;
      const c = squareCenter(arrow.to);
      if (!c) continue;
      appendLabel(c, arrow);
    }
  }

  function appendLabel(center, arrow) {
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', String(round(center.x)));
    text.setAttribute('y', String(round(center.y + 0.42)));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '0.26');
    text.setAttribute('font-family', 'ui-sans-serif, system-ui, sans-serif');
    text.setAttribute('font-weight', '700');
    text.setAttribute('fill', '#fff');
    text.setAttribute('stroke', 'rgba(0,0,0,0.75)');
    text.setAttribute('stroke-width', '0.07');
    text.setAttribute('paint-order', 'stroke fill');
    text.textContent = arrow.label;
    svg.appendChild(text);
  }

  function sync() {
    syncScheduled = false;
    if (!root || !arrows.length) return;
    if (!board?.isConnected) {
      clear();
      return;
    }
    const rect = board.getBoundingClientRect();
    if (rect.width < 40) {
      root.style.display = 'none';
      return;
    }
    root.style.display = 'block';
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(sync);
  }

  function startListening() {
    if (listening) return;
    listening = true;
    window.addEventListener('scroll', scheduleSync, { passive: true, capture: true });
    window.addEventListener('resize', scheduleSync, { passive: true });
    observer = new ResizeObserver(scheduleSync);
    if (board) observer.observe(board);
    // Страховка от перерисовок страницы, которые не дают ни scroll, ни resize.
    setInterval(scheduleSync, 400);
  }

  function clear() {
    arrows = [];
    if (svg) svg.textContent = '';
    if (root) root.style.display = 'none';
  }

  globalThis.CC_OVERLAY = {
    setBoard(nextBoard, nextOrientation) {
      const changed = nextBoard !== board;
      board = nextBoard;
      orientation = nextOrientation || 'white';
      if (changed) {
        observer?.disconnect();
        if (board) observer?.observe(board);
      }
      startListening();
      if (arrows.length) {
        render();
        scheduleSync();
      }
    },

    draw(nextArrows) {
      arrows = Array.isArray(nextArrows) ? nextArrows : [];
      if (!arrows.length) {
        clear();
        return;
      }
      render();
      sync();
    },

    clear,
  };
})();
