// Real Chromium regression: node check-membership-browser.mjs, then open the printed URL.
// No browser automation/dependencies: real DOM, MutationObserver, WAAPI, and shipped AnimatedRows.
// ?negative=1 changes only the new moved expression back to its pre-fix form.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const nativePath = process.env.HARNESS_ROWS_SOURCE || process.env.DSH_NATIVE_WORKSPACE_CLIENT;
const movedExpression = 'const moved = previous - rowTop(row) + scroll - (priorPlacement?.scrollTop ?? scroll);';

export function pluginSource(negative = false) {
  let source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  if (negative) {
    if (source.split(movedExpression).length !== 2) throw Error('Negative control requires exactly one current membership moved expression');
    source = source.replace(movedExpression, 'const moved = previous - rowTop(row);');
  }
  const exportAnchor = '      dictionaries,\n      inject,';
  const ensureAnchor = '      const ensure = () => {';
  if (source.split(exportAnchor).length !== 2 || source.split(ensureAnchor).length !== 2) throw Error('Plugin fixture injection anchors changed');
  source = source.replace(exportAnchor, '      markReceiptRows,\n' + exportAnchor)
    .replace(ensureAnchor, ensureAnchor + '\n        window.membershipEnsureCount = (window.membershipEnsureCount || 0) + 1;');
  return `window.membershipVariant=${JSON.stringify(negative ? 'negative-offset-only' : 'current')};window.membershipSourceHash=${JSON.stringify(sourceHash)};\n${source}`;
}

export function nativeRowsSource() {
  if (!nativePath) throw new Error('Set HARNESS_ROWS_SOURCE or DSH_NATIVE_WORKSPACE_CLIENT to the installed @deepseek-ai/dsh-client-ui-workspace/lib/client.js before running this fixture.');
  const source = readFileSync(nativePath, 'utf8');
  const start = source.indexOf('const ROW_FADE_MS = 100;');
  const end = source.indexOf('//#endregion', start);
  if (start < 0 || end < 0) throw Error('Shipped AnimatedRows extraction anchors changed');
  const extracted = source.slice(start, end);
  if (!extracted.includes('var AnimatedRows = class extends react.Component') || !extracted.trimEnd().endsWith('};')) throw Error('Incomplete shipped AnimatedRows class');
  return `window.MembershipNativeRows=(()=>{const react={Component:class{constructor(props){this.props=props}},createRef:()=>({current:null})};\n${extracted}\nreturn AnimatedRows;})();`;
}

// Stringified into the page; its references are browser globals, never Node shims.
export function membershipBrowser() {
  let api = window.membershipApi;
  const css = document.createElement('style');
  css.textContent = api.ungroupedCss();
  document.head.append(css);
  const host = document.querySelector('#fixture');
  const output = document.querySelector('#result');
  const HEADER = 'data-chat-sessions-cluster-header';
  const times = [0, 50, 100, 150, 199, 200];
  const EPS = 0.35;
  const cases = [
    { name: 'remove-top', operation: 'remove', position: 'top' },
    { name: 'remove-middle', operation: 'remove', position: 'middle' },
    { name: 'remove-partial-clamp', operation: 'remove', position: 'partial' },
    { name: 'remove-full-clamp', operation: 'remove', position: 'full' },
    { name: 'add-scroll-held', operation: 'add', position: 'full' },
    { name: 'add-external-bottom-anchor', operation: 'add', position: 'full', anchorAfter: true },
    { name: 'user-scroll-before-remove', operation: 'remove', position: 'top', userScroll: 'full' },
    { name: 'user-scroll-before-add', operation: 'add', position: 'top', userScroll: 'middle' },
  ];
  const animationRecords = [];
  const originalAnimate = Element.prototype.animate;
  let phase = 'setup';
  let active;
  let running = false;
  // Instrument creation, preserving the real Animation and real browser rendering.
  Element.prototype.animate = function (frames, options) {
    const animation = originalAnimate.call(this, frames, options);
    animationRecords.push({ animation, target: this, phase, frames, options });
    return animation;
  };
  const isTranslation = (animation) => (animation.effect?.getKeyframes() || []).some(frame => typeof frame.transform === 'string' && frame.transform.startsWith('translate'));
  const frame = () => new Promise(resolveFrame => {
    let done = false;
    let raf;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      resolveFrame();
    };
    const timer = setTimeout(finish, 50);
    raf = requestAnimationFrame(finish);
  });
  const drainMicrotasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const settle = async () => { await drainMicrotasks(); await frame(); await frame(); await drainMicrotasks(); };
  const rect = element => {
    const r = element.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, height: r.height };
  };
  const live = () => document.getAnimations().filter(a => a.effect?.target && host.contains(a.effect.target));
  const rowKeys = list => [...list.querySelectorAll('[data-row-key]')]
    .filter(row => !row.hasAttribute(HEADER)).map(row => row.dataset.rowKey);
  const yMap = elements => Object.fromEntries(elements.map(el => [el.dataset.rowKey, rect(el).top]));
  const getTranslate = element => {
    const transform = getComputedStyle(element).transform;
    return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
  };
  function makeRow(key, label) {
    const row = document.createElement('div');
    row.className = 'nativeRow';
    row.dataset.rowKey = key;
    row.setAttribute('role', 'treeitem');
    row.textContent = label;
    return row;
  }
  function blankShell() {
    const shell = document.createElement('div');
    shell.id = 'blank-shell';
    shell.append(makeRow('session:blank', '新会话 · blank'));
    return shell;
  }
  async function finishOwnedAnimations() {
    // WAAPI cancellation alone leaves the plugin's rowMotions registry behind.
    // Let each real owner receive its finish event before replacing fixture DOM.
    for (const a of live()) a.finish();
    await settle();
  }
  async function stop() {
    if (!active) return;
    await finishOwnedAnimations();
    active.stopMarker();
    active.native.componentWillUnmount();
    host.replaceChildren();
    active = null;
  }
  async function setup(spec) {
    await stop();
    // Each case gets the same real source, with a fresh module closure. The full
    // application normally owns module lifetime; a marker-only stop does not.
    api = window.membershipFactory(window.membershipRequire);
    window.membershipApi = api;
    phase = 'setup';
    animationRecords.length = 0;
    host.innerHTML = '<div id="native-stage"><div id="membership-list" role="tree" aria-label="Synthetic membership list"><section class="ordinary"><div class="workspace-space"></div><div><div class="nativeRow" data-row-key="workspace:foreign" role="treeitem" aria-expanded="true"><span class="slot"><svg width="16"></svg></span><span class="slot"><svg width="16"></svg></span><span><span>Ordinary workspace peer</span></span><span><button>+</button></span></div></div></section><section id="receipt-group"><div><div class="nativeRow" data-row-key="workspace:receipt" role="treeitem" aria-expanded="true"><span class="slot"></span><span class="slot"><svg width="16"></svg></span><span><span>Receipt workspace</span></span><span><button>+</button></span></div></div></section></div><div id="native-exits" aria-hidden="true"></div></div>';
    const list = host.querySelector('#membership-list');
    const group = host.querySelector('#receipt-group');
    for (let i = 1; i <= 3; i++) {
      const shell = document.createElement('div');
      shell.append(makeRow('session:retained-' + i, 'Retained conversation ' + i));
      group.append(shell);
    }
    if (spec.operation === 'remove') group.append(blankShell());
    const state = { rooms: new Map([['receipt', {}]]), untitled: '独立对话',
      clusterView: { collapsed: false, pending: false, error: '' },
      createStandalone: async () => {}, isBlank: id => id === 'blank' };
    const stopMarker = api.markReceiptRows(state);
    const native = new window.MembershipNativeRows({ rowKeys: rowKeys(list), resetKey: 'stable', ready: true });
    native.armed = true;
    native.list.current = list;
    native.overlay.current = host.querySelector('#native-exits');
    active = { list, group, native, stopMarker };
    list.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    await finishOwnedAnimations();
    const max = () => list.scrollHeight - list.clientHeight;
    const position = name => name === 'top' ? 0 : name === 'middle' ? Math.max(0, max() - 100) : name === 'partial' ? Math.max(0, max() - 18) : max();
    list.scrollTop = position(spec.position);
    await settle(); // Deliver the real browser scroll event before committing membership.
    const initialScroll = list.scrollTop;
    let scrollEvents = 0;
    const countScroll = () => { scrollEvents++; };
    list.addEventListener('scroll', countScroll);
    const ensureBeforeUserScroll = window.membershipEnsureCount;
    if (spec.userScroll) {
      list.scrollTop = position(spec.userScroll);
      await settle();
    }
    list.removeEventListener('scroll', countScroll);
    const header = list.querySelector('[' + HEADER + ']');
    const peer = list.querySelector('[data-row-key="workspace:foreign"]');
    const retained = [...list.querySelectorAll('[data-row-key^="session:retained-"]')];
    return { ...active, header, peer, retained, initialScroll, scrollEvents,
      scrollEnsureDelta: window.membershipEnsureCount - ensureBeforeUserScroll };
  }
  async function runCase(spec, options) {
    const f = await setup(spec);
    const errors = [];
    let assertions = 0;
    const check = (condition, message, data) => {
      assertions++;
      if (!condition) errors.push({ message, ...(data ? { data } : {}) });
    };
    const close = (a, b, message) => check(Math.abs(a - b) <= EPS, message, { actual: a, expected: b });
    const tracked = [f.peer, f.header, ...f.retained];
    const before = yMap(tracked);
    const scrollBefore = f.list.scrollTop;
    const oldMax = f.list.scrollHeight - f.list.clientHeight;
    const previous = f.native.props;
    const nextKeys = spec.operation === 'remove' ? previous.rowKeys.filter(k => k !== 'session:blank') : [...previous.rowKeys, 'session:blank'];
    f.native.props = { ...previous, rowKeys: nextKeys };
    const snapshot = f.native.getSnapshotBeforeUpdate(previous);
    check(snapshot !== null, 'real native getSnapshotBeforeUpdate must capture the membership commit');
    const ensureBeforeCommit = window.membershipEnsureCount;
    if (spec.operation === 'remove') f.group.querySelector('#blank-shell').remove();
    else f.group.append(blankShell());
    if (spec.anchorAfter) f.list.scrollTop = f.list.scrollHeight - f.list.clientHeight;
    phase = 'native';
    f.native.componentDidUpdate(previous, undefined, snapshot);
    // Age every native movement equally. A correction that restarts at 0 must fail the clock check.
    const nativeOrigin = document.timeline.currentTime - options.nativeAge;
    const nativeClocks = new Map();
    for (const [target, animation] of f.native.movements) {
      if (isTranslation(animation)) animation.startTime = nativeOrigin;
      nativeClocks.set(target, { animation, startTime: animation.startTime, currentTime: animation.currentTime,
        duration: animation.effect.getTiming().duration, easing: animation.effect.getTiming().easing });
    }
    phase = 'marker';
    await drainMicrotasks();
    const scrollAfter = f.list.scrollTop;
    const newMax = f.list.scrollHeight - f.list.clientHeight;
    const afterAnimations = live();
    const translations = element => afterAnimations.filter(a => a.effect.target === element && isTranslation(a));
    const clockEvidence = [];
    for (const element of tracked) {
      const source = nativeClocks.get(element);
      const motions = translations(element);
      check(motions.length <= 1, element.dataset.rowKey + ': exactly one owner for transform', { count: motions.length });
      if (!source || !isTranslation(source.animation) || motions.length === 0) continue;
      const replacement = motions[0];
      const evidence = { key: element.dataset.rowKey, originalStart: source.startTime, originalCurrent: source.currentTime,
        finalStart: replacement.startTime, finalCurrent: replacement.currentTime, sameAnimation: source.animation === replacement };
      clockEvidence.push(evidence);
      if (typeof source.startTime === 'number') close(replacement.startTime, source.startTime, element.dataset.rowKey + ': native startTime inherited');
      else if (typeof source.currentTime === 'number') close(replacement.currentTime, source.currentTime, element.dataset.rowKey + ': pending native currentTime inherited');
      close(replacement.effect.getTiming().duration, source.duration, element.dataset.rowKey + ': native duration retained');
      check(replacement.effect.getTiming().easing === source.easing, element.dataset.rowKey + ': native easing retained');
    }
    const nativePeer = nativeClocks.get(f.peer);
    const headerMotion = translations(f.header)[0];
    if (nativePeer && headerMotion && isTranslation(nativePeer.animation)) {
      close(headerMotion.startTime, nativePeer.startTime, 'header and native peer use the same commit clock');
    }
    // All sampling remains real WAAPI. Set hold times synchronously; no mock rects/styles or native implementation edits.
    function seek(time) {
      for (const animation of afterAnimations) {
        animation.pause();
        animation.currentTime = time;
      }
      void f.list.offsetHeight;
    }
    seek(200);
    const final = yMap(tracked);
    const finalScroll = f.list.scrollTop;
    const samples = [];
    for (const time of times) {
      seek(time);
      const positions = yMap(tracked);
      const translates = Object.fromEntries(tracked.map(el => [el.dataset.rowKey, getTranslate(el)]));
      const progress = headerMotion?.effect.getComputedTiming().progress ?? nativePeer?.animation.effect.getComputedTiming().progress ?? null;
      samples.push({ time, scroll: f.list.scrollTop, positions, translates, progress });
      close(f.list.scrollTop, scrollAfter, 'sampling must not introduce an extra scroll clamp at ' + time);
      for (const element of tracked) {
        const key = element.dataset.rowKey;
        if (time === 0) close(positions[key], before[key], key + ': start at commit-before viewport position');
        if (time === 200) close(positions[key], final[key], key + ': finish at the actual layout');
        const lo = Math.min(before[key], final[key]) - EPS;
        const hi = Math.max(before[key], final[key]) + EPS;
        check(positions[key] >= lo && positions[key] <= hi, key + ': no invented or reversed viewport travel at ' + time, { y: positions[key], before: before[key], final: final[key] });
        if (time === 199) close(positions[key], final[key], key + ': native completion by 199ms');
        if (Math.abs(before[key] - final[key]) <= EPS) close(positions[key], before[key], key + ': full compensation leaves the row stationary at ' + time);
      }
      if (progress !== null) {
        for (const element of tracked) {
          const key = element.dataset.rowKey;
          const expected = before[key] + (final[key] - before[key]) * progress;
          close(positions[key], expected, key + ': follows native eased progress at ' + time);
        }
      }
    }
    check(window.membershipEnsureCount > ensureBeforeCommit, 'real MutationObserver must run markReceiptRows after the native commit');
    check(f.list.clientHeight === 400, 'the role=tree is itself the 400px scroller');
    if (spec.position === 'full' && !spec.userScroll) close(scrollBefore, oldMax, 'commit begins at the real bottom');
    if (spec.name === 'remove-full-clamp' || spec.anchorAfter || spec.name === 'user-scroll-before-remove') {
      close(scrollAfter, newMax, 'the commit ends at the real bottom');
      for (const row of f.retained) close(final[row.dataset.rowKey], before[row.dataset.rowKey], row.dataset.rowKey + ': scroll clamp exactly compensates blank height');
      check(Math.abs(final[f.peer.dataset.rowKey] - before[f.peer.dataset.rowKey]) > 1, 'native peer actually moves in the clamp case');
      check(headerMotion !== undefined, 'header must retain/rebuild its scroll-only motion');
      check(nativePeer !== undefined, 'native AnimatedRows must own the moving ordinary peer');
    }
    if (spec.name === 'remove-partial-clamp') check(scrollBefore - scrollAfter > 0 && scrollBefore - scrollAfter < 36, 'partial clamp must be nonzero and smaller than one blank row', { scrollBefore, scrollAfter });
    if (spec.name === 'remove-top' || spec.name === 'remove-middle' || spec.name === 'add-scroll-held' || spec.name === 'user-scroll-before-add') close(scrollAfter, scrollBefore, 'non-clamped membership keeps the real scrollTop');
    if (spec.userScroll) {
      check(f.scrollEvents > 0, 'precommit user scroll must dispatch a real browser scroll event');
      check(f.scrollEnsureDelta === 0, 'scroll event updates only the baseline; it must not run the marker', { delta: f.scrollEnsureDelta });
    }
    const result = { name: spec.name, ok: errors.length === 0, assertions, errors, operation: spec.operation,
      initialScroll: f.initialScroll, scrollEvents: f.scrollEvents, scrollEnsureDelta: f.scrollEnsureDelta,
      scrollBefore, scrollAfter, finalScroll, oldMax, newMax, scrollDelta: scrollAfter - scrollBefore,
      before, final, nativeAge: options.nativeAge, clockEvidence, markerPasses: window.membershipEnsureCount - ensureBeforeCommit,
      animationOwners: animationRecords.filter(r => r.phase !== 'setup').map(r => ({ key: r.target.dataset.rowKey || 'exit-clone', phase: r.phase,
        frames: r.frames, options: r.options, playState: r.animation.playState })), samples };
    await stop();
    return result;
  }
  window.runMembershipCases = async function (options = {}) {
    if (running) throw Error('Membership fixture is already running');
    running = true;
    const config = { nativeAge: 37, throwOnFailure: true, ...options };
    const selected = config.names ? cases.filter(spec => config.names.includes(spec.name)) : cases;
    const results = [];
    try {
      for (const spec of selected) {
        try { results.push(await runCase(spec, config)); }
        catch (error) { results.push({ name: spec.name, ok: false, errors: [{ message: error.message, stack: error.stack }] }); await stop(); }
      }
      const report = { ok: selected.length > 0 && results.every(result => result.ok), variant: window.membershipVariant,
        sourceHash: window.membershipSourceHash, nativeSource: 'shipped AnimatedRows; render is never called',
        browser: navigator.userAgent, passed: results.filter(result => result.ok).length, total: selected.length, results };
      window.membershipResults = report;
      output.textContent = JSON.stringify(report, null, 2);
      if (!report.ok && config.throwOnFailure) throw Error('Membership regression failed: ' + results.filter(result => !result.ok).map(result => result.name + ': ' + result.errors[0]?.message).join('; ') + ' (full evidence: window.membershipResults)');
      return report;
    } finally { await stop(); running = false; phase = 'idle'; }
  };
  document.querySelector('#run').onclick = () => window.runMembershipCases().catch(error => { output.textContent = error.message + '\n' + output.textContent; });
}

export function membershipHtml(negative = false) {
  return `<!doctype html><html data-chat-sessions-flatten><meta charset="utf-8"><title>Membership clamp browser regression</title>
<style>
body{margin:0;background:#141820;color:#dbe5ef;font:14px system-ui;--dsw-alias-border-l1:#344354}h1{font-size:16px;margin:16px 20px}button{margin:4px}#fixture{position:absolute;left:20px;top:90px;width:340px;height:400px}#native-stage{height:400px;display:flex;flex-direction:column;min-height:0;position:relative}#membership-list{box-sizing:border-box;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:400px;overflow-y:auto;overflow-anchor:none;scrollbar-gutter:stable;padding:0 0 16px;position:relative;background:#202833}.ordinary{flex:0 0 auto}.workspace-space{height:566px}.nativeRow{height:34px;box-sizing:border-box;flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:0 8px;border-bottom:1px solid #344354}.slot{width:16px;flex:none}.nativeRow button{height:22px;margin:0}#native-exits{position:absolute;inset:0;pointer-events:none;overflow:clip;z-index:5}pre{margin:430px 20px 20px;white-space:pre-wrap;font-size:12px}code{color:#add1ed}
</style><h1>Real membership + scroll clamp · ${negative ? 'negative: offset-only moved expression' : 'current plugin'}</h1><button id="run">Run eight membership cases</button><code>window.runMembershipCases({throwOnFailure:false})</code><div id="fixture"></div><pre id="result">Ready</pre>
<script>window.membershipRequire=id=>id==='react/jsx-runtime'?{jsx(){},jsxs(){}}:{};window.__ModuleLoader__={load(entry){window.membershipFactory=entry.factory;window.membershipApi=entry.factory(window.membershipRequire)}};</script>
<script src="/native-animated-rows.js"></script><script src="/client.js${negative ? '?negative=1' : ''}"></script><script>(${membershipBrowser.toString()})();</script></html>`;
}

// Export the handler as well, so an already running fixture server can reuse its routes.
export function membershipFixtureHandler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    let body;
    let type;
    if (url.pathname === '/client.js') { body = pluginSource(url.searchParams.get('negative') === '1'); type = 'text/javascript'; }
    else if (url.pathname === '/native-animated-rows.js') { body = nativeRowsSource(); type = 'text/javascript'; }
    else if (url.pathname === '/' || url.pathname === '/membership') { body = membershipHtml(url.searchParams.get('negative') === '1'); type = 'text/html; charset=utf-8'; }
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch (error) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(error.stack); }
}

export function createMembershipFixtureServer() { return createServer(membershipFixtureHandler); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createMembershipFixtureServer();
  server.listen(0, '127.0.0.1', () => console.log(`Membership fixture: http://127.0.0.1:${server.address().port}/\nNegative control: http://127.0.0.1:${server.address().port}/?negative=1`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
