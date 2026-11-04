// Isolated real-browser sorting/WAAPI regression. No production data or credentials.
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const baseline = process.env.ACTIVITY_BASELINE;
const out = resolve('evidence/activity-sort-20261103');
mkdirSync(out, { recursive: true });
const sources = { current: readFileSync(new URL('./client.js', import.meta.url), 'utf8') };
if (baseline) sources.baseline = readFileSync(baseline, 'utf8');
function browserSuite() {
  const api = window.activityApi;
  const css = document.createElement('style'); css.textContent = api.ungroupedCss(); document.head.append(css);
  const host = document.querySelector('#fixture');
  const records = [];
  const originalAnimate = Element.prototype.animate;
  Element.prototype.animate = function(frames, options) {
    const animation = originalAnimate.call(this, frames, options);
    records.push({ target: this, frames, options, animation }); return animation;
  };
  const frame = () => new Promise(resolveFrame => setTimeout(resolveFrame, 20));
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const results = [];
  let stop;
  let checks = 0;
  const assert = (ok, message) => { checks++; if (!ok) throw Error(message); };
  const near = (a, b, message) => assert(Math.abs(a - b) < .6, `${message}: ${a} / ${b}`);
  const suite = async (name, run) => {
    try { await run(); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: String(error.stack || error) }); }
  };
  function setup(pinned = []) {
    stop?.(); for (const record of records) record.animation.cancel(); records.length = 0;
    host.innerHTML = '<div role="tree" id="list"></div>';
    const list = host.firstElementChild;
    const rows = {};
    const times = { a: 10, b: 20, c: 30, d: 40 };
    const blanks = new Set();
    const listeners = new Set();
    for (const id of Object.keys(times)) {
      const group = document.createElement('section');
      group.innerHTML = `<div><div data-row-key="workspace:${id}" class="nativeRow" aria-expanded="true">独立对话</div></div><div><div class="rowWrapper"><div class="nativeRow" data-row-key="session:${id}">${id}${pinned.includes(id) ? '<span class="pinIndicator"> 📌</span>' : ''}</div></div></div>`;
      list.append(group); rows[id] = group.querySelector('[data-row-key^="session:"]');
    }
    document.dispatchEvent(new Event('pointerdown'));
    stop = api.markReceiptRows({ ids: new Set(Object.keys(times)), untitled: '独立对话',
      pinRanks: new Map(pinned.map((id, i) => [id, i])), activityOf: id => times[id], isBlank: id => blanks.has(id),
      sessionList: { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } } });
    const notify = async () => { for (const fn of listeners) fn(); await drain(); };
    const ys = () => Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.getBoundingClientRect().top]));
    const ordered = () => Object.keys(rows).sort((a, b) => rows[a].getBoundingClientRect().top - rows[b].getBoundingClientRect().top).join(',');
    const moves = () => records.filter(r => r.animation.playState !== 'idle');
    finish(moves()); records.length = 0;
    return { rows, times, blanks, notify, ys, ordered, moves };
  }
  const pauseAt = (moves, time) => { for (const r of moves) { r.animation.pause(); r.animation.currentTime = time; } };
  const finish = moves => { for (const r of moves) { r.animation.finish(); r.animation.onfinish?.(); } };
  async function checkMove(f, before, expected) {
    const moves = f.moves();
    assert(moves.length > 0, 'activity reorder must animate');
    pauseAt(moves, 0);
    for (const id of Object.keys(before)) near(f.ys()[id], before[id], `${id} continuous at start`);
    for (const r of moves) { assert(r.options.duration === 200, '200ms duration'); assert(r.options.easing === 'ease-out', 'native easing'); }
    pauseAt(moves, 100);
    const halfway = f.ys();
    finish(moves);
    assert(f.ordered() === expected, `final visual order ${f.ordered()} expected ${expected}`);
    const end = f.ys();
    for (const id of Object.keys(before)) {
      assert(halfway[id] >= Math.min(before[id], end[id]) - .6 && halfway[id] <= Math.max(before[id], end[id]) + .6, `${id} stays inside movement path`);
    }
    return { before, halfway, end, animations: moves.length };
  }
  async function run() {
    await suite('ordinary activity across rooms', async () => {
      const f = setup(); await frame(); await frame();
      assert(f.ordered() === 'd,c,b,a', 'initial latest first');
      const before = f.ys(); f.times.a = 50; await f.notify();
      const geometry = await checkMove(f, before, 'a,d,c,b'); results.push({ name: 'ordinary geometry', ...geometry, pass: true });
      const count = records.length; f.times.a = 60; await f.notify();
      assert(records.length === count, 'activity with unchanged rank does not restart animation');
      for (let i = 0; i < 50; i++) await f.notify();
      assert(records.length === count, 'unchanged notifications never replay motion');
    });
    await suite('pinned activity keeps the pin partition', async () => {
      const f = setup(['a', 'b']); await frame(); await frame();
      assert(f.ordered() === 'b,a,d,c', 'pins use activity, not pin operation order');
      let before = f.ys(); f.times.c = 100; await f.notify(); await checkMove(f, before, 'b,a,c,d');
      before = f.ys(); f.times.a = 200; await f.notify(); await checkMove(f, before, 'a,b,c,d');
    });
    await suite('interrupt activity glide from its painted position', async () => {
      const f = setup(['a', 'b']); await frame(); await frame();
      f.times.a = 100; await f.notify(); const first = f.moves(); pauseAt(first, 80);
      const before = f.ys(); f.times.b = 200; await f.notify(); const next = f.moves();
      assert(first.every(r => r.animation.playState === 'idle'), 'superseded glides are retired');
      assert(next.length > 0, 'reverse activity starts a new glide'); pauseAt(next, 0);
      for (const id of Object.keys(before)) near(f.ys()[id], before[id], `${id} reversal continuity`);
      finish(next); assert(f.ordered() === 'b,a,d,c', 'reversal final order');
    });
    await suite('visible blank stays above pins then joins ordinary recency', async () => {
      const f = setup(['a', 'b']); f.blanks.add('d'); await f.notify(); await frame(); finish(f.moves());
      assert(f.ordered() === 'd,b,a,c', 'blank before all pins');
      const before = f.ys(); f.blanks.delete('d'); f.times.d = 100; await f.notify(); await checkMove(f, before, 'b,a,d,c');
    });
    await suite('reduced motion updates order and baseline without replay', async () => {
      const match = window.matchMedia;
      window.matchMedia = () => ({ matches: true });
      try {
        const f = setup(); await frame(); f.times.a = 100; await f.notify();
        assert(records.length === 0, 'reduced motion has no glides'); assert(f.ordered() === 'a,d,c,b', 'order still updates');
        window.matchMedia = match; await f.notify(); assert(records.length === 0, 'reenabling motion does not replay');
      } finally { window.matchMedia = match; }
    });
    stop?.();
    const result = { variant: window.activityVariant, sourceHash: window.activityHash, checks, pass: results.every(r => r.pass), results };
    window.activityResult = result; document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
    await fetch('/result?variant=' + window.activityVariant, { method: 'POST', body: JSON.stringify(result) });
  }
  run().catch(error => { document.querySelector('#result').textContent = String(error.stack); });
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const variant = url.searchParams.get('variant') === 'baseline' ? 'baseline' : 'current';
  if (url.pathname === '/result' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c); req.on('end', () => { writeFileSync(`${out}/browser-${variant}.json`, body); res.end('ok'); }); return;
  }
  const source = sources[variant];
  if (!source) { res.statusCode = 404; res.end('baseline not configured'); return; }
  const injected = source.replace('      dictionaries,\n      inject,', '      markReceiptRows,\n      dictionaries,\n      inject,');
  const hash = createHash('sha256').update(source).digest('hex');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html data-chat-sessions-flatten><head><style>body{background:#22262b;color:#eee;font:16px sans-serif}#fixture{width:320px}#list{position:relative;display:flex;flex-direction:column}.nativeRow{height:32px;box-sizing:border-box;padding:6px}.rowWrapper{flex-shrink:0}pre{white-space:pre-wrap;font-size:12px}</style></head><body><h2>Activity ordering / real WAAPI</h2><div id="fixture"></div><pre id="result">Running</pre><script>window.activityVariant=${JSON.stringify(variant)};window.activityHash=${JSON.stringify(hash)};window.__ModuleLoader__={load(entry){window.activityApi=entry.factory(id=>id==='react/jsx-runtime'?{jsx(){},jsxs(){}}:{})}};</script><script>${injected.replaceAll('</script', '<\\/script')}</script><script>(${browserSuite.toString()})();</script></body></html>`);
});
server.listen(63971, '127.0.0.1', () => console.log('http://127.0.0.1:63971/?variant=current'));
