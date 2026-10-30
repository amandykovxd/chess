/**
 * Проверки сборки расширения: манифест, проводка сообщений, разметка панели.
 * Ошибки такого рода Chrome показывает только при загрузке расширения,
 * поэтому дешевле ловить их здесь.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

test('все файлы из манифеста существуют', () => {
  const declared = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap((c) => [...c.js, ...(c.css || [])]),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const file of declared) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `нет файла ${file}`);
  }
});

test('default_locale не объявлен без папки _locales', () => {
  if (manifest.default_locale) {
    assert.ok(fs.existsSync(path.join(ROOT, '_locales', manifest.default_locale, 'messages.json')));
  }
});

test('CSP разрешает WebAssembly и Worker', () => {
  const csp = manifest.content_security_policy?.extension_pages || '';
  assert.match(csp, /'wasm-unsafe-eval'/);
  assert.match(csp, /worker-src 'self'/);
});

test('файл движка и его wasm названы согласованно', () => {
  // Сборка Stockfish выводит путь к .wasm заменой расширения в своём URL.
  const js = 'src/engine/stockfish-19-lite-single.js';
  assert.ok(fs.existsSync(path.join(ROOT, js)));
  assert.ok(fs.existsSync(path.join(ROOT, js.replace(/\.js$/, '.wasm'))));
  assert.ok(read('src/offscreen/offscreen.js').includes(js));
});

test('движок не использует eval — иначе CSP расширения его заблокирует', () => {
  const engine = read('src/engine/stockfish-19-lite-single.js');
  assert.equal(engine.includes('new Function('), false);
});

const SOURCES = [
  'src/background/service-worker.js',
  'src/offscreen/offscreen.js',
  'src/content/content.js',
  'src/panel/panel.js',
];

test('все имена сообщений объявлены в протоколе и используются', () => {
  const declared = new Set([...read('src/common/protocol.js').matchAll(/^\s{4}([A-Z_]+):/gm)].map((m) => m[1]));
  assert.ok(declared.size >= 15, 'список MSG не разобран');

  const all = SOURCES.map(read).join('\n');
  for (const m of all.matchAll(/MSG\.([A-Z_]+)/g)) {
    assert.ok(declared.has(m[1]), `MSG.${m[1]} не объявлен в protocol.js`);
  }
  for (const name of declared) {
    assert.ok(all.includes(`MSG.${name}`), `MSG.${name} объявлен, но не используется`);
  }
});

test('id в panel.html и panel.js совпадают', () => {
  const htmlIds = new Set([...read('src/panel/panel.html').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = [...read('src/panel/panel.js').matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  for (const id of jsIds) assert.ok(htmlIds.has(id), `panel.js ждёт #${id}, которого нет в разметке`);
  for (const id of htmlIds) assert.ok(jsIds.includes(id), `#${id} в разметке не используется кодом`);
});

test('относительные импорты внутри src разрешаются', () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });

  for (const file of walk(path.join(ROOT, 'src'))) {
    if (!file.endsWith('.js')) continue;
    if (file.includes(`${path.sep}vendor${path.sep}`) || file.includes(`${path.sep}engine${path.sep}`)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'|^import\s+'([^']+)'/gm)) {
      const spec = m[1] || m[2];
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      assert.ok(fs.existsSync(target), `${path.relative(ROOT, file)}: импорт '${spec}' не разрешается`);
    }
  }
});
