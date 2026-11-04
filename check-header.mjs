import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

// Reuse the declared dev dependency; resolve it through the normal package lookup.
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const HEADER = 'data-chat-sessions-cluster-header';
const ACTION = 'data-chat-sessions-cluster-new';
const COLLAPSED = 'data-chat-sessions-cluster-collapsed';

function fixture(options = {}) {
  const dom = new JSDOM(`<html data-chat-sessions-flatten><head></head><body><div role="tree" id="list"><div id="workspace"><div><div data-row-key="workspace:real" class="nativeRow" role="treeitem" aria-expanded="true" draggable="true"><span class="slot folder"><svg width="16"></svg></span><span class="slot chevron"><svg class="arrow arrowOpen"></svg></span><span class="projectText"><span class="title">.dsh</span></span><span class="rowActions"><button class="iconButton" aria-label="工作区操作 .dsh"><svg></svg></button><button class="iconButton" aria-label="在 .dsh 中新建"><svg data-native-new></svg></button></span></div></div></div></div></body></html>`, { url: 'http://localhost', pretendToBeVisual: true });
  let entry;
  dom.window.__ModuleLoader__ = { load(candidate) { entry = candidate; } };
  const context = vm.createContext({ window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), setTimeout, clearTimeout, queueMicrotask, Map, Set, console, ...options });
  vm.runInContext(source.replace('const ensure = () => {', 'const ensure = () => { globalThis.onEnsure?.();').replace('      dictionaries,\n      inject,', '      paintClusterHeader,\n      markReceiptRows,\n      createModeTransition,\n      dictionaries,\n      inject,'), context);
  const api = entry.factory((id) => id === 'react/jsx-runtime' ? { jsx() {}, jsxs() {} } : {});
  const container = dom.window.document.querySelector('#list');
  const template = dom.window.document.querySelector('[data-row-key]');
  const state = { collapsed: false, pending: false, error: '' };
  const paint = (create = async () => {}) => api.paintClusterHeader(container, template, '独立对话', create, state);
  return { dom, api, container, template, state, paint };
}

function modeFixture() {
  const f = fixture();
  const calls = [];
  const rect = (top, height = 32, left = 10) => ({ top, bottom: top + height, left, right: left + 240, width: 240, height });
  f.dom.window.Element.prototype.animate = function(frames, options) {
    const motion = { effect: { target: this, getKeyframes: () => frames }, cancel() { this.cancelled = true; } };
    calls.push({ element: this, frames, options, motion });
    return motion;
  };
  const row = f.dom.window.document.createElement('div');
  row.dataset.rowKey = 'session:mode';
  f.container.append(row);
  const header = f.paint();
  const h = f.container.querySelector(`[${HEADER}]`);
  let y = 332;
  let hidden = false;
  row.getBoundingClientRect = () => hidden ? rect(0, 0) : rect(y);
  h.getBoundingClientRect = () => rect(300);
  const nativeParent = f.dom.window.document.createElement('section');
  f.container.append(nativeParent);
  const coordinator = f.api.createModeTransition();
  const layout = (nested, collapsed = false) => ({ nested, collapsed, rows: [row], header: nested ? null : h,
    anchor: () => nested ? 100 : 332, viewport: () => rect(0, 800) });
  return { ...f, calls, row, h, nativeParent, coordinator, layout,
    position(value, hide = false) { y = value; hidden = hide; },
    close() { coordinator.reset(); f.dom.window.close(); } };
}

test('collapsed mode change reveals at native parent and retracts into the same source parent', () => {
  const f = modeFixture();
  try {
    f.position(0, true);
    f.coordinator.reconcile(f.layout(false, true), true);
    f.coordinator.capture();
    f.nativeParent.append(f.row); f.h.remove(); f.position(120);
    assert.equal(f.coordinator.reconcile(f.layout(true, true), true), true);
    const enter = f.calls.find(c => c.element === f.row);
    assert.equal(enter.frames[0].clipPath, 'inset(0px 0px 52px 0px)');
    assert.equal(enter.frames[0].opacity, 0);
    assert.equal(enter.frames[0].transform, undefined, 'never translate from hidden zero geometry');
    assert.equal(f.row.parentElement, f.nativeParent, 'native tree owns row parent');
    assert.ok(f.calls.some(c => c.element.dataset.chatSessionsModePart === 'header-exit'));
    assert.ok(f.calls.some(c => c.element.dataset.chatSessionsModePart === 'divider-exit'));
    for (const c of [...f.calls]) c.motion.onfinish?.();
    f.coordinator.capture();
    f.container.append(f.h, f.row); f.position(0, true);
    f.coordinator.reconcile(f.layout(false, true), true);
    const exit = f.calls.find(c => c.element.dataset.chatSessionsModePart === 'row-exit');
    assert.ok(exit);
    assert.equal(exit.frames[1].opacity, 0);
    assert.equal(exit.frames[1].transform, 'translate(0px, 0px)', 'retract in the source tree instead of flying towards the destination header');
    assert.equal(exit.frames[1].clipPath, 'inset(0px 0px 52px 0px)');
    assert.ok(f.calls.some(c => c.element === f.h && c.frames[0].opacity === 0));
  } finally { f.close(); }
});

test('expanded mode change glides by viewport delta with eased acceleration and keeps native parent', () => {
  const f = modeFixture();
  try {
    f.coordinator.reconcile(f.layout(false), true); f.coordinator.capture();
    f.nativeParent.append(f.row); f.h.remove(); f.position(120);
    f.coordinator.reconcile(f.layout(true), true);
    const move = f.calls.find(c => c.element === f.row);
    assert.equal(move.frames[0].transform, 'translate(0px, 212px)');
    assert.equal(move.options.duration, 200);
    assert.equal(move.options.easing, 'cubic-bezier(0.4, 0, 0.2, 1)');
    assert.equal(f.row.parentElement, f.nativeParent);
  } finally { f.close(); }
});

test('mode bridge moves surrounding workspace rows from their captured viewport positions both ways', () => {
  const f = modeFixture();
  const peer = f.dom.window.document.createElement('div'); peer.dataset.rowKey = 'workspace:peer'; f.container.append(peer);
  let y = 400;
  peer.getBoundingClientRect = () => ({ top: y, bottom: y + 32, left: 10, right: 250, width: 240, height: 32 });
  const layout = (nested) => ({ ...f.layout(nested, true), peers: () => [peer] });
  try {
    f.coordinator.reconcile(layout(true), true); f.coordinator.capture();
    y = 200; f.position(0, true);
    f.coordinator.reconcile(layout(false), true);
    let move = f.calls.find(c => c.element === peer);
    assert.ok(move, 'foreign workspace must not snap into departing standalone rows');
    assert.equal(move.frames[0].transform, 'translate(0px, 200px)');
    assert.equal(move.options.duration, 200);
    for (const c of [...f.calls]) c.motion.onfinish?.();
    f.coordinator.capture(); y = 400;
    f.coordinator.reconcile(layout(true), true);
    move = f.calls.filter(c => c.element === peer).at(-1);
    assert.equal(move.frames[0].transform, 'translate(0px, -200px)');
  } finally { f.close(); }
});

for (const scroll of [0, 90, 180]) test(`native expansion corrects surrounding row against final viewport at scroll ${scroll}`, () => {
  const f = modeFixture();
  const peer = f.dom.window.document.createElement('div'); peer.dataset.rowKey = 'workspace:peer'; f.container.append(peer);
  let y = 200 - scroll;
  const native = { effect: { getKeyframes: () => [{ transform: 'translate(0,-500px)' }] }, cancel() { this.cancelled = true; } };
  peer.getAnimations = () => native.cancelled ? [] : [native];
  peer.getBoundingClientRect = () => ({ top: y - (native.cancelled ? 0 : 500), bottom: y + 32 - (native.cancelled ? 0 : 500), left: 10, right: 250, width: 240, height: 32 });
  const layout = (correctNative) => ({ ...f.layout(true), peers: () => [peer], correctNative });
  try {
    native.cancelled = true;
    f.coordinator.reconcile(layout(false), true); f.coordinator.capture('tree');
    native.cancelled = false; y += 150;
    f.coordinator.reconcile(layout(true), true);
    assert.equal(native.cancelled, true, 'discard intermediate wrapper displacement');
    const move = f.calls.find(c => c.element === peer);
    assert.ok(move);
    assert.equal(move.frames[0].transform, 'translate(0px, -150px)');
    assert.equal(move.options.easing, 'ease-out');
    assert.equal(f.calls.filter(c => c.element === f.row).length, 0, 'owned entry remains native');
  } finally { f.close(); }
});

test('departing rows clip behind downward peers throughout the shared transition', () => {
  const f = modeFixture();
  const peer = f.dom.window.document.createElement('div'); peer.dataset.rowKey = 'session:foreign'; f.container.append(peer);
  let y = 260;
  peer.getBoundingClientRect = () => ({ top: y, bottom: y + 32, left: 10, right: 250, width: 240, height: 32 });
  try {
    f.coordinator.reconcile({ ...f.layout(false), peers: () => [peer] }, true); f.coordinator.capture();
    y = 380; f.position(0, true); f.h.remove();
    f.coordinator.reconcile({ ...f.layout(true), peers: () => [peer] }, true);
    const move = f.calls.find(c => c.element === peer);
    const exit = f.calls.find(c => c.element.dataset.chatSessionsModePart === 'row-exit');
    assert.ok(move && exit);
    assert.equal(move.options.easing, exit.options.easing);
    assert.equal(move.options.duration, exit.options.duration);
    assert.equal(exit.frames[1].clipPath, 'inset(80px 0px 32px 0px)');
    for (const progress of [0, .1, .25, .5, .75, 1]) {
      const visibleTop = 332 + 80 * progress;
      const movingPeerBottom = 292 + 120 * progress;
      assert.ok(visibleTop >= movingPeerBottom, `no overlap at eased progress ${progress}`);
    }
  } finally { f.close(); }
});

test('correct native peer animation keeps its clock and reduced motion adds none', () => {
  const f = modeFixture();
  const peer = f.dom.window.document.createElement('div'); peer.dataset.rowKey = 'workspace:peer'; f.container.append(peer);
  const native = { currentTime: 0, effect: { getKeyframes: () => [{ transform: 'translate(0,-150px)' }] }, cancel() { this.cancelled = true; } };
  peer.getAnimations = () => [native];
  peer.getBoundingClientRect = () => ({ top: 200, bottom: 232, left: 10, right: 250, width: 240, height: 32 });
  const layout = correctNative => ({ ...f.layout(true), peers: () => [peer], correctNative });
  try {
    f.coordinator.reconcile(layout(false), true); f.coordinator.capture('tree');
    f.coordinator.reconcile(layout(true), true);
    assert.ok(!native.cancelled); assert.equal(native.currentTime, 0); assert.equal(f.calls.length, 0);
    f.coordinator.capture('tree'); f.coordinator.reconcile(layout(true), false);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('root cluster stays unchanged when unrelated native groups reorganize', () => {
  const f = modeFixture();
  try {
    f.coordinator.reconcile(f.layout(false), true); f.coordinator.capture();
    f.nativeParent.append(f.template);
    assert.equal(f.coordinator.reconcile(f.layout(false), true), false);
    assert.equal(f.calls.length, 0);
    assert.equal(f.h.parentElement, f.container);
  } finally { f.close(); }
});

test('mode reversal retires old overlays; reduced motion and disposal leave no decoration', () => {
  const f = modeFixture();
  try {
    f.coordinator.reconcile(f.layout(false), true); f.coordinator.capture();
    f.h.remove(); f.position(100); f.coordinator.reconcile(f.layout(true), true);
    const old = [...f.calls];
    const outgoing = old.find(c => c.element.dataset.chatSessionsModePart === 'header-exit').element;
    outgoing.style.opacity = '0.45'; outgoing.style.clipPath = 'inset(0px 0px 12px 0px)';
    outgoing.getBoundingClientRect = () => ({ top: 292, bottom: 324, left: 0, right: 240, width: 240, height: 32 });
    f.coordinator.capture(); f.container.append(f.h); f.position(332);
    f.coordinator.reconcile(f.layout(false), true);
    const resumed = f.calls.find(c => c.element === f.h);
    assert.equal(resumed.frames[0].opacity, 0.45);
    assert.equal(resumed.frames[0].clipPath, 'inset(0px 0px 12px 0px)');
    assert.equal(resumed.frames[0].transform, 'translate(-10px, -8px)');
    assert.ok(old.every(c => c.motion.cancelled));
    assert.ok(f.dom.window.document.querySelectorAll('[data-chat-sessions-mode-overlay]').length <= 1);
    f.coordinator.capture(); f.h.remove();
    f.coordinator.reconcile(f.layout(true), false);
    assert.equal(f.dom.window.document.querySelectorAll('[data-chat-sessions-mode-overlay]').length, 0);
    f.coordinator.reset();
    assert.ok(f.calls.every(c => c.motion.cancelled));
  } finally { f.close(); }
});

test('marker mode bridge captures keyboard menu selection and preserves native nesting both ways', async () => {
  const f = fixture({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  const doc = f.dom.window.document;
  const calls = [];
  const rect = (top, height = 32) => ({ top, bottom: top + height, left: 0, right: 240, width: 240, height });
  f.dom.window.Element.prototype.animate = function(frames, options) {
    const motion = { cancel() { this.cancelled = true; }, effect: { target: this, getKeyframes: () => frames } };
    calls.push({ element: this, frames, options, motion }); return motion;
  };
  let measureReads = 0;
  f.dom.window.Element.prototype.getBoundingClientRect = function() {
    measureReads++;
    if (this.hasAttribute(HEADER)) return rect(500);
    if (this.dataset.rowKey === 'session:integrated') return this.closest(`[${COLLAPSED}]`) ? rect(0, 0) : rect(160);
    if (this.dataset.rowKey === 'workspace:foreign') return rect(100);
    return rect(0, 800);
  };
  const style = doc.createElement('style'); style.textContent = f.api.ungroupedCss(); doc.head.append(style);
  f.container.style.overflowY = 'auto';
  const group = doc.querySelector('#workspace');
  const session = doc.createElement('div'); session.dataset.rowKey = 'session:integrated'; group.append(session);
  const foreign = doc.createElement('section');
  foreign.innerHTML = '<div><div data-row-key="workspace:foreign">Parent</div></div><div role="group"></div>';
  const nativeChildren = foreign.lastElementChild; f.container.append(foreign);
  const menu = doc.createElement('button'); menu.setAttribute('role', 'menuitemradio'); doc.body.append(menu);
  f.state.collapsed = true;
  const stop = f.api.markReceiptRows({ ids: new Set(['real']), untitled: '独立对话', clusterView: f.state });
  try {
    measureReads = 0;
    session.dispatchEvent(new f.dom.window.Event('pointerdown', { bubbles: true }));
    session.click();
    assert.equal(measureReads, 0, 'ordinary session clicks do not trigger mode geometry snapshots');
    menu.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    nativeChildren.append(group); group.style.setProperty('--dsh-workspace-indent', '12px');
    await new Promise(setImmediate);
    const reveal = calls.find(c => c.element === session && c.frames[0].clipPath);
    assert.ok(reveal, 'marker invokes the bridge, not its ordinary offsetTop glide');
    assert.equal(reveal.frames[0].clipPath, 'inset(0px 0px 60px 0px)');
    assert.equal(group.parentElement, nativeChildren);
    assert.equal(doc.querySelector(`[${HEADER}]`), null);
    for (const call of [...calls]) call.motion.onfinish?.();
    menu.click();
    f.container.append(group); group.style.setProperty('--dsh-workspace-indent', '0px');
    await new Promise(setImmediate);
    assert.equal(group.parentElement, f.container);
    assert.equal(f.dom.window.getComputedStyle(session).display, 'none');
    assert.equal(doc.querySelector(`[${HEADER}]`).getAttribute('aria-expanded'), 'false');
    assert.ok(calls.some(c => c.element.dataset.chatSessionsModePart === 'row-exit'));
    stop();
    assert.equal(doc.querySelector('[data-chat-sessions-mode-overlay]'), null);
  } finally { stop(); f.dom.window.close(); }
});

test('header exit retains the captured viewport when the destination tree is shorter', () => {
  const f = modeFixture();
  try {
    f.position(0, true);
    f.coordinator.reconcile(f.layout(false, true), true); f.coordinator.capture();
    f.h.remove(); f.nativeParent.append(f.row); f.position(120);
    const next = f.layout(true, true);
    next.viewport = () => ({ top: 80, bottom: 180, left: 10, right: 250, width: 240, height: 100 });
    f.coordinator.reconcile(next, true);
    const overlay = f.dom.window.document.querySelector('[data-chat-sessions-mode-overlay]');
    assert.equal(overlay.style.top, '0px');
    assert.equal(overlay.style.height, '800px', 'old title at y300 must remain visible throughout exit');
    const exit = f.calls.find(c => c.element.dataset.chatSessionsModePart === 'header-exit');
    assert.ok(exit?.element.isConnected);
    assert.equal(exit.options.duration, 200);
  } finally { f.close(); }
});

test('collapsed native parent still receives a header exit and reverse entry without opening it', async () => {
  const f = fixture({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  const doc = f.dom.window.document;
  const calls = [];
  const rect = (top, height = 32) => ({ top, bottom: top + height, left: 0, right: 240, width: 240, height });
  f.dom.window.Element.prototype.getBoundingClientRect = function() {
    return this.hasAttribute(HEADER) ? rect(500) : rect(0, 800);
  };
  f.dom.window.Element.prototype.animate = function(frames, options) {
    const motion = { cancel() {}, effect: { target: this, getKeyframes: () => frames } };
    calls.push({ element: this, frames, options, motion }); return motion;
  };
  const group = doc.querySelector('#workspace');
  const parent = doc.createElement('section');
  parent.innerHTML = '<div><div data-row-key="workspace:parent" aria-expanded="false">Parent</div></div>';
  f.container.prepend(parent); f.container.style.overflowY = 'auto';
  let clicks = 0; parent.addEventListener('click', () => clicks++);
  const session = doc.createElement('div'); session.dataset.rowKey = 'session:retained'; group.append(session);
  const menu = doc.createElement('button'); menu.setAttribute('role', 'menuitemradio'); doc.body.append(menu);
  f.state.collapsed = true;
  const stop = f.api.markReceiptRows({ ids: new Set(['real']), untitled: '独立对话', clusterView: f.state });
  try {
    menu.dispatchEvent(new f.dom.window.Event('pointerdown', { bubbles: true }));
    menu.click(); group.remove(); // Native tree unmounts children of a collapsed parent.
    await new Promise(setImmediate);
    assert.equal(doc.querySelector(`[${HEADER}]`), null);
    assert.ok(calls.some(c => c.element.dataset.chatSessionsModePart === 'header-exit'), 'absence is an exit transition, not a reset');
    assert.ok(calls.some(c => c.element.dataset.chatSessionsModePart === 'divider-exit'));
    assert.equal(clicks, 0, 'never auto-expand the real parent');
    for (const c of [...calls]) c.motion.onfinish?.();
    menu.click(); f.container.append(group);
    await new Promise(setImmediate);
    assert.ok(calls.some(c => c.element.hasAttribute(HEADER) && c.frames[0].opacity === 0));
    assert.equal(doc.querySelector(`[${HEADER}]`).getAttribute('aria-expanded'), 'false');
  } finally { stop(); f.dom.window.close(); }
});

test('exit snapshots freeze separate source-parent anchors before React reparents the rows', () => {
  const f = modeFixture();
  const second = f.row.cloneNode(true); second.dataset.rowKey = 'session:other-parent';
  second.getBoundingClientRect = () => ({ top: 420, bottom: 452, left: 10, right: 250, width: 240, height: 32 });
  f.nativeParent.append(f.row, second); f.h.remove(); f.position(120);
  let parentHasChanged = false;
  const sourceLayout = { ...f.layout(true), rows: [f.row, second],
    anchor: row => parentHasChanged ? 900 : row === f.row ? 100 : 400 };
  try {
    f.coordinator.reconcile(sourceLayout, true); f.coordinator.capture();
    parentHasChanged = true; f.container.append(f.row, second, f.h); f.position(0, true);
    f.coordinator.reconcile({ ...f.layout(false, true), rows: [] }, true);
    const exits = f.calls.filter(c => c.element.dataset.chatSessionsModePart === 'row-exit');
    assert.equal(exits.length, 2);
    for (const exit of exits) {
      assert.equal(exit.frames[1].clipPath, 'inset(0px 0px 52px 0px)');
      assert.equal(exit.frames[1].transform, 'translate(0px, 0px)');
    }
  } finally { f.close(); }
});

test('header replaces the native action set with one new-chat action', () => {
  const f = fixture();
  f.paint();
  const header = f.container.querySelector(`[${HEADER}]`);
  assert.equal(header.querySelectorAll('button').length, 1);
  assert.equal(header.querySelector(`[${ACTION}]`).parentElement.className, 'rowActions');
  assert.equal(header.hasAttribute('draggable'), false);
  assert.equal(header.querySelector('.folder svg').getAttribute('viewBox'), '0 0 24 24');
  assert.equal(f.template.querySelectorAll('button').length, 2, 'host row stays intact');
  f.dom.window.close();
});

test('flattened session rows retain the native two-pixel selection gap', () => {
  const f = fixture();
  const doc = f.dom.window.document;
  const style = doc.createElement('style');
  style.textContent = '.nativeGroup > * + * { margin-top: 2px; }' + f.api.ungroupedCss();
  doc.head.appendChild(style);
  const makeGroup = (flattened) => {
    const group = doc.createElement('div');
    group.className = 'nativeGroup';
    group.setAttribute('data-chat-sessions-group', '');
    if (flattened) group.setAttribute('data-chat-sessions-flat', '');
    group.innerHTML = '<div data-row-key="workspace:gap"></div><div><div data-row-key="session:gap-one" aria-selected="true"></div></div><div><div data-row-key="session:gap-two"></div></div>';
    f.container.appendChild(group);
    return group;
  };
  const native = makeGroup(false);
  const flattened = makeGroup(true);
  const expected = f.dom.window.getComputedStyle(native.children[2]).marginTop;
  assert.equal(expected, '2px');
  for (const row of flattened.querySelectorAll('[data-row-key^="session:"]')) {
    assert.equal(f.dom.window.getComputedStyle(row).marginTop, expected, 'promoted row replaces the spacing lost from its display:contents wrapper');
  }
  assert.notEqual(f.dom.window.getComputedStyle(native.querySelector('[data-row-key^="session:"]')).marginTop, '2px', 'ordinary groups retain wrapper spacing without double margins');
  doc.documentElement.removeAttribute('data-chat-sessions-flatten');
  assert.notEqual(f.dom.window.getComputedStyle(flattened.querySelector('[data-row-key^="session:"]')).marginTop, '2px', 'flat-list mode keeps native spacing');
  f.dom.window.close();
});

test('new-chat glyph never comes from a wrapped native menu button', () => {
  const f = fixture();
  const actions = f.template.children[3];
  actions.innerHTML = '<span><button class="iconButton"><svg data-menu><circle cx="4"/><circle cx="8"/><circle cx="12"/></svg></button></span><span><button class="iconButton"><svg data-new-chat/></button></span>';
  f.paint();
  const glyph = f.container.querySelector(`[${ACTION}] svg`);
  assert.equal(glyph.querySelectorAll('circle').length, 0, 'no ellipsis dots');
  assert.equal(glyph.getAttribute('data-chat-sessions-new-chat-icon'), '', 'explicit chat-plus glyph');
  assert.match(glyph.innerHTML, /M12 8v8M8 12h8/, 'plus inside chat bubble');
  f.dom.window.close();
});

test('repainting an unchanged header produces no child-list mutations', () => {
  const f = fixture();
  f.paint();
  const observer = new f.dom.window.MutationObserver(() => {});
  observer.observe(f.container, { childList: true, subtree: true });
  for (let i = 0; i < 5; i++) f.paint();
  assert.equal(observer.takeRecords().length, 0);
  observer.disconnect();
  f.dom.window.close();
});

test('new chat runs once during a pending request, opens the cluster and reports failures', async () => {
  const f = fixture();
  let resolve;
  let calls = 0;
  f.paint(() => { calls++; return new Promise((done) => { resolve = done; }); });
  const header = f.container.querySelector(`[${HEADER}]`);
  header.click();
  const action = header.querySelector(`[${ACTION}]`);
  action.click();
  action.click();
  assert.equal(calls, 1);
  assert.equal(action.disabled, true);
  assert.equal(f.state.collapsed, true, 'new button does not toggle the header');
  resolve();
  await new Promise(setImmediate);
  assert.equal(action.disabled, false);
  assert.equal(f.state.collapsed, false);
  f.paint(async () => { throw new Error('HTTP 500'); });
  action.click();
  await new Promise(setImmediate);
  assert.match(f.container.querySelector('[role=alert]').textContent, /HTTP 500/);
  assert.equal(action.disabled, false);
  f.dom.window.close();
});
test('marker refresh preserves collapse and mode switches leave no stale header', () => {
  const f = fixture();
  const doc = f.dom.window.document;
  doc.documentElement.setAttribute(f.api.FLATTEN_ATTRIBUTE, '');
  const style = doc.createElement('style');
  style.textContent = f.api.ungroupedCss();
  doc.head.appendChild(style);
  const group = doc.querySelector('#workspace');
  const session = doc.createElement('div');
  session.setAttribute('data-row-key', 'session:s1');
  group.appendChild(session);
  const foreign = group.cloneNode(true);
  foreign.id = 'foreign';
  foreign.querySelector('[data-row-key]').setAttribute('data-row-key', 'workspace:foreign');
  foreign.querySelector('[data-row-key^="session:"]').remove();
  f.container.appendChild(foreign);
  const state = { ids: new Set(['real']), untitled: '独立对话', clusterView: f.state };
  let stop = f.api.markReceiptRows(state);
  f.container.querySelector(`[${HEADER}]`).click();
  assert.equal(f.dom.window.getComputedStyle(session).display, 'none');
  assert.notEqual(f.dom.window.getComputedStyle(foreign).display, 'none');
  stop();
  stop = f.api.markReceiptRows(state);
  assert.equal(f.container.querySelector(`[${HEADER}]`).getAttribute('aria-expanded'), 'false');
  assert.equal(f.dom.window.getComputedStyle(session).display, 'none');
  stop();
  group.style.setProperty('--dsh-workspace-indent', '16px');
  stop = f.api.markReceiptRows(state);
  assert.equal(f.container.querySelector(`[${HEADER}]`), null, 'nested tree uses native structure');
  assert.equal(f.container.hasAttribute(COLLAPSED), false);
  stop();
  group.style.removeProperty('--dsh-workspace-indent');
  stop = f.api.markReceiptRows(state);
  assert.ok(f.container.querySelector(`[${HEADER}]`));
  stop();
  f.template.remove();
  foreign.querySelector('[data-row-key]').remove();
  stop = f.api.markReceiptRows(state);
  assert.equal(f.container.querySelector(`[${HEADER}]`), null, 'flat mode removes cluster chrome');
  stop();
  f.dom.window.close();
});

test('apply connects the button to POST and session navigation even when picker primitives are absent', async (t) => {
  for (const scenario of ['success', 'http-error', 'invalid-json', 'navigation-error', 'missing-service']) {
    await t.test(scenario, async () => {
      const requests = [];
      const opened = [];
      const cleanups = [];
      const f = fixture({ fetch: async (url, init) => {
        if (url === '/chat-sessions/config') return { ok: true, json: async () => ({ root: '/chat', untitledWorkspaceTitle: '独立对话' }) };
        if (url === '/chat-sessions/status') return { ok: true, json: async () => ({ workspaces: [{ id: 'real', path: '/chat/.sessions/room' }] }) };
        assert.equal(url, '/chat-sessions/create');
        requests.push(init);
        return { ok: scenario !== 'http-error', status: scenario === 'http-error' ? 500 : 200, json: async () => {
          if (scenario === 'invalid-json') throw new SyntaxError('invalid JSON');
          return { ok: true, sessionId: 'created-session' };
        } };
      } });
      f.dom.window.setInterval = () => 0;
      const foreign = f.template.parentElement.parentElement.cloneNode(true);
      foreign.querySelector('[data-row-key]').setAttribute('data-row-key', 'workspace:foreign');
      f.container.appendChild(foreign);
      const session = f.dom.window.document.createElement('div');
      session.dataset.rowKey = 'session:existing';
      f.template.parentElement.parentElement.append(session);
      f.api.apply({
        get: (name) => name === 'uiWorkspace' && scenario !== 'missing-service' ? { openSession(id) {
          if (scenario === 'navigation-error') throw new Error('navigation failed');
          opened.push(id);
        } } : undefined,
        effect: (run) => { cleanups.push(run()); },
        logger: { warn() {} },
      });
      try {
        await new Promise(setImmediate);
        const button = f.container.querySelector(`[${ACTION}]`);
        assert.ok(button, 'sidebar remains functional without picker primitives');
        button.click();
        button.click();
        await new Promise(setImmediate);
        assert.equal(requests.length, scenario === 'missing-service' ? 0 : 1);
        if (requests.length) {
          assert.equal(requests[0].method, 'POST');
          assert.equal(requests[0].credentials, 'same-origin');
          assert.equal(requests[0].body, '{"reuseBlank":true}');
        }
        assert.equal(button.disabled, false);
        if (scenario === 'success') {
          assert.deepEqual(opened, ['created-session']);
          assert.equal(f.container.querySelector('[role=alert]'), null);
        } else {
          assert.deepEqual(opened, []);
          assert.match(f.container.querySelector('[role=alert]').textContent, /新建会话失败/);
        }
      } finally {
        for (const cleanup of cleanups.reverse()) if (typeof cleanup === 'function') cleanup();
        assert.equal(f.container.querySelector(`[${HEADER}]`), null, 'disposing removes plugin-owned chrome');
        f.dom.window.close();
      }
    });
  }
});

test('apply shares native blank metadata and subscription without guessing the title', async () => {
  let blank = true;
  const listeners = new Set();
  const cleanups = [];
  const f = fixture({ fetch: async (url) => ({ ok: true, json: async () => url.endsWith('/config')
    ? { root: '/chat', untitledWorkspaceTitle: '独立对话' }
    : { workspaces: [{ id: 'real', path: '/chat/.sessions/room' }], pinOrder: [{ sessionId: 'pin', index: 0 }] } }) });
  f.dom.window.setInterval = () => 0;
  const group = f.container.querySelector('#workspace');
  const row = f.dom.window.document.createElement('div');
  row.setAttribute('data-row-key', 'session:blank');
  row.textContent = 'not a localized New Session string';
  const pin = row.cloneNode(true);
  pin.setAttribute('data-row-key', 'session:pin');
  pin.innerHTML = '<span class="pinIndicator"></span>';
  group.append(pin, row);
  const list = {
    getSnapshot: () => ({ byId: { blank: { blank }, pin: { blank: false } } }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  f.api.apply({ get: (key) => key === 'sessions' ? { list, binding: () => ({ session: { getSnapshot: () => ({ blank: false }) } }) } : undefined,
    effect(run) { cleanups.push(run()); }, logger: { warn() {} } });
  try {
    await new Promise(setImmediate);
    assert.ok(+row.style.order < +pin.style.order, 'native list wins over cold retained-session state');
    assert.equal(listeners.size, 1);
    blank = false;
    for (const notify of listeners) notify();
    await new Promise(setImmediate);
    assert.ok(+row.style.order > +pin.style.order, 'metadata-only first submission reorders before the next poll');
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup?.();
    assert.equal(listeners.size, 0);
    f.dom.window.close();
  }
});

test('activity notifications promote an ordinary receipt across rooms without waiting for a poll', async () => {
  let passes = 0;
  const listeners = new Set();
  const cleanups = [];
  const byId = { older: { blank: false, updatedAt: 10 }, newer: { blank: false, updatedAt: 20 } };
  const f = fixture({ onEnsure: () => passes++, fetch: async (url) => ({ ok: true, json: async () => url.endsWith('/config')
    ? { root: '/chat', untitledWorkspaceTitle: '独立对话' }
    : { workspaces: ['real', 'other'].map(id => ({ id, path: `/chat/.sessions/${id}` })) } }) });
  f.dom.window.setInterval = () => 0;
  const group = f.container.querySelector('#workspace');
  const older = f.dom.window.document.createElement('div');
  older.dataset.rowKey = 'session:older';
  group.append(older);
  const other = group.cloneNode(true);
  other.querySelector('[data-row-key^="workspace:"]').dataset.rowKey = 'workspace:other';
  const newer = other.querySelector('[data-row-key^="session:"]');
  newer.dataset.rowKey = 'session:newer';
  f.container.append(other);
  const list = { getSnapshot: () => ({ byId }), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  f.api.apply({ get: key => key === 'sessions' ? { list } : undefined,
    effect(run) { cleanups.push(run()); }, logger: { warn() {} } });
  try {
    await new Promise(setImmediate);
    assert.ok(+newer.style.order < +older.style.order, 'latest activity wins across receipt wrappers');
    byId.older.updatedAt = 30;
    for (const notify of listeners) notify();
    await new Promise(setImmediate);
    assert.ok(+older.style.order < +newer.style.order, 'existing nonblank conversation moves immediately');
    passes = 0;
    byId.older.running = true;
    for (let i = 0; i < 50; i++) for (const notify of listeners) notify();
    await new Promise(setImmediate);
    assert.equal(passes, 0, 'unchanged activity does not rescan for token/running notifications');
  } finally { for (const cleanup of cleanups.reverse()) cleanup?.(); f.dom.window.close(); }
});

test('metadata notifications with unchanged visible blank state do not rescan the sidebar', async () => {
  let blank = true;
  let passes = 0;
  let notify;
  const f = fixture({ onEnsure: () => passes++ });
  const row = f.dom.window.document.createElement('div');
  row.setAttribute('data-row-key', 'session:tracked');
  f.container.querySelector('#workspace').append(row);
  const stop = f.api.markReceiptRows({ rooms: new Map([['real', {}]]), isBlank: () => blank,
    sessionList: { subscribe(fn) { notify = fn; return () => { notify = null; }; } } });
  try {
    await new Promise(setImmediate);
    passes = 0;
    for (let turn = 0; turn < 50; turn++) {
      notify();
      await Promise.resolve();
    }
    assert.equal(passes, 0, 'running/title/projection notifications need no marker work');
    blank = false;
    notify();
    await new Promise(setImmediate);
    assert.equal(passes, 1, 'first submission still updates the order immediately');
    assert.equal(row.style.order, '100');
  } finally { stop(); f.dom.window.close(); }
});

test('unchanged status polls keep existing observers and subscription', async () => {
  let poll;
  let subscriptions = 0;
  let stops = 0;
  let passes = 0;
  let pinIndex = 0;
  const cleanups = [];
  const f = fixture({ onEnsure: () => passes++, fetch: async (url) => ({ ok: true, json: async () => url.endsWith('/config')
    ? { root: '/chat', untitledWorkspaceTitle: '独立对话' }
    : { workspaces: [{ id: 'real', path: '/chat/.sessions/room' }], pinOrder: [{ sessionId: 'pin', index: pinIndex }] } }) });
  f.dom.window.setInterval = (fn) => { poll = fn; return 0; };
  const list = { getSnapshot: () => ({ byId: {} }), subscribe() { subscriptions++; return () => stops++; } };
  f.api.apply({ get: (key) => key === 'sessions' ? { list } : undefined,
    effect(run) { cleanups.push(run()); }, logger: { warn() {} } });
  try {
    await new Promise(setImmediate);
    passes = 0;
    for (let i = 0; i < 10; i++) { poll(); await new Promise(setImmediate); }
    assert.equal(subscriptions, 1, 'unchanged receipt facts do not reconstruct marker');
    assert.equal(stops, 0);
    assert.equal(passes, 0);
    pinIndex = 1;
    poll(); await new Promise(setImmediate);
    assert.equal(subscriptions, 2, 'changed pin order is still reconciled');
    assert.equal(stops, 1);
  } finally { for (const cleanup of cleanups.reverse()) cleanup?.(); f.dom.window.close(); }
});

test('activity-only status polls keep the marker and its in-flight motion owner', async () => {
  let poll;
  let updatedAt = 10;
  let subscriptions = 0;
  let stops = 0;
  const cleanups = [];
  const f = fixture({ fetch: async url => ({ ok: true, json: async () => url.endsWith('/config')
    ? { root: '/chat' }
    : { workspaces: [{ id: 'real', path: '/chat/.sessions/real', updatedAt }] } }) });
  f.dom.window.setInterval = fn => { poll = fn; return 0; };
  const list = { getSnapshot: () => ({ byId: {} }), subscribe() { subscriptions++; return () => stops++; } };
  f.api.apply({ get: key => key === 'sessions' ? { list } : undefined,
    effect(run) { cleanups.push(run()); }, logger: { warn() {} } });
  try {
    await new Promise(setImmediate);
    updatedAt = 20;
    poll();
    await new Promise(setImmediate);
    assert.equal(subscriptions, 1, 'activity-only diagnostics cannot reconstruct the marker');
    assert.equal(stops, 0);
  } finally { for (const cleanup of cleanups.reverse()) cleanup?.(); f.dom.window.close(); }
});

test('diagnostic animation frames drain after a bounded burst and stop on disposal', async () => {
  const frames = new Map();
  let next = 1;
  const cleanups = [];
  const f = fixture({ performance: { now: () => 1000 },
    requestAnimationFrame(fn) { const id = next++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    fetch: async (url) => ({ ok: true, json: async () => url.endsWith('/config')
      ? { root: '/chat', untitledWorkspaceTitle: '独立对话' }
      : { workspaces: [{ id: 'real', path: '/chat/.sessions/room' }] } }) });
  f.dom.window.setInterval = () => 0;
  f.api.apply({ get: () => undefined, effect(run) { cleanups.push(run()); }, logger: { warn() {} } });
  try {
    await new Promise(setImmediate);
    for (let tick = 0; tick < 80 && frames.size; tick++) {
      const pending = [...frames.values()]; frames.clear();
      for (const fn of pending) fn();
    }
    assert.equal(frames.size, 0, 'idle page must not keep scanning layout every frame');
    f.template.dispatchEvent(new f.dom.window.Event('pointerdown', { bubbles: true }));
    assert.ok(frames.size > 0, 'click diagnostics remain available');
    for (const cleanup of cleanups.reverse()) cleanup?.(); cleanups.length = 0;
    assert.equal(frames.size, 0, 'dispose cancels outstanding diagnostic frames');
    f.template.dispatchEvent(new f.dom.window.Event('pointerdown', { bubbles: true }));
    assert.equal(frames.size, 0, 'dispose removes diagnostic input listener');
  } finally { for (const cleanup of cleanups.reverse()) cleanup?.(); f.dom.window.close(); }
});

test('header CSS keeps native sizing and exposes the only action on hover or focus', () => {
  const f = fixture();
  const css = f.api.ungroupedCss();
  assert.ok(css.includes(`[${HEADER}]:hover [${ACTION}]`));
  assert.ok(css.includes(`[${HEADER}]:focus-within [${ACTION}]`));
  assert.ok(!css.includes('min-height:48px'));
  assert.ok(!css.includes('padding:0 12px'));
  f.dom.window.close();
});

test('cluster fold reveals from the header in 200ms and cleans interrupted exits', () => {
  const f = fixture();
  const doc = f.dom.window.document;
  const group = doc.querySelector('#workspace');
  group.setAttribute('data-chat-sessions-group', '');
  const row = doc.createElement('div');
  row.setAttribute('data-row-key', 'session:motion');
  group.appendChild(row);
  const survivor = doc.createElement('div');
  survivor.setAttribute('data-row-key', 'workspace:below');
  f.container.appendChild(survivor);
  const calls = [];
  f.dom.window.Element.prototype.animate = function (frames, options) {
    const animation = { onfinish: null, cancelled: false, cancel() { this.cancelled = true; } };
    calls.push({ element: this, frames, options, animation });
    return animation;
  };
  f.dom.window.Element.prototype.getBoundingClientRect = function () {
    const collapsed = f.container.hasAttribute(COLLAPSED);
    const hidden = collapsed && this === row;
    const top = this === f.container ? 0 : this === survivor ? (collapsed ? 68 : 100) : this.hasAttribute(HEADER) ? 0 : 34;
    return { left: 0, top, right: 240, bottom: hidden ? top : top + 34, width: 240, height: hidden ? 0 : 34 };
  };
  f.paint();
  const header = f.container.querySelector(`[${HEADER}]`);
  header.click();
  const exit = calls.find((call) => call.frames.at(-1).clipPath);
  assert.ok(exit, 'collapse retracts content toward the header');
  assert.equal(exit.options.duration, 200);
  assert.equal(exit.frames.at(-1).clipPath, 'inset(0px 0px 34px 0px)');
  assert.equal(exit.frames[0].opacity, 1);
  assert.equal(exit.frames.at(-1).opacity, 0, 'fade-out shares the retraction animation');
  assert.equal(exit.options.easing, 'ease-out');
  const glide = calls.find((call) => call.element === survivor);
  assert.equal(glide.options.duration, 200);
  assert.equal(glide.frames[0].transform, 'translate(0px, 32px)');
  assert.equal(exit.element.hasAttribute('data-row-key'), false);
  assert.ok(exit.element.closest('[aria-hidden="true"]'));
  assert.equal(exit.element.style.position, 'absolute', 'the animated clone is positioned inside the fixed exit layer');
  const exitLayer = exit.element.closest('[data-chat-sessions-fold-exits]');
  assert.ok(exitLayer, 'the animated clone belongs to the fold exit layer');
  assert.equal(exitLayer.style.position, 'fixed', 'fold exits stay anchored to the source viewport when bottom scroll clamping changes scrollTop');
  assert.equal(exitLayer.style.top, '0px', 'the exit layer uses the viewport as its coordinate origin');
  assert.equal(exitLayer.style.overflow, 'clip', 'the exit layer remains clipped to the source viewport');
  assert.equal(f.container.hasAttribute(COLLAPSED), true, 'real rows settle immediately like native rows');
  f.paint();
  assert.equal(exit.animation.cancelled, false, 'ordinary repaint does not restart animation');
  header.click();
  assert.equal(exit.animation.cancelled, true, 'rapid reversal cancels previous exit');
  assert.equal(exit.element.isConnected, false);
  const enter = calls.find((call) => call.element === row && call.frames[0].clipPath);
  assert.ok(enter, 'expand reveals real rows from the header edge');
  assert.equal(enter.options.duration, 200);
  assert.equal(enter.frames[0].clipPath, 'inset(0px 0px 34px 0px)');
  assert.equal(enter.frames.at(-1).clipPath, 'inset(0px 0px 0px 0px)');
  assert.equal(enter.frames.at(-1).opacity, 1);
  enter.animation.onfinish();
  assert.equal(enter.animation.cancelled, true);
  f.dom.window.close();
});

test('multi-row reveal shares one header boundary and resumes interrupted clipping', () => {
  const f = fixture();
  const doc = f.dom.window.document;
  const style = doc.createElement('style');
  style.textContent = f.api.ungroupedCss();
  doc.head.appendChild(style);
  const group = doc.querySelector('#workspace');
  group.setAttribute('data-chat-sessions-group', '');
  const rows = [0, 1, 2].map((i) => {
    const row = doc.createElement('div');
    row.setAttribute('data-row-key', `session:reveal-${i}`);
    group.appendChild(row);
    return row;
  });
  const calls = [];
  f.dom.window.Element.prototype.animate = function (frames, options) {
    const animation = { cancel() { this.cancelled = true; } };
    calls.push({ element: this, frames, options, animation });
    return animation;
  };
  f.dom.window.Element.prototype.getBoundingClientRect = function () {
    const i = rows.indexOf(this);
    const top = i < 0 ? 0 : 34 + 34 * i;
    const height = i >= 0 && f.container.hasAttribute(COLLAPSED) ? 0 : 34;
    return { top, bottom: top + height, left: 0, right: 240, width: 240, height };
  };
  f.paint();
  const header = f.container.querySelector(`[${HEADER}]`);
  header.click();
  const exits = calls.filter((c) => c.frames.at(-1).clipPath);
  assert.equal(exits.length, 3);
  assert.deepEqual(exits.map((c) => c.frames.at(-1).clipPath), [34, 68, 102].map((n) => `inset(0px 0px ${n}px 0px)`));
  assert.deepEqual(exits.map((c) => c.frames[0].clipPath), [-68, -34, 0].map((n) => `inset(0px 0px ${n}px 0px)`));
  // Simulate a browser-computed frame halfway through collapse before reversal.
  exits[0].element.style.clipPath = 'inset(0px 0px 17px 0px)';
  exits[0].element.style.opacity = '0.45';
  calls.length = 0;
  header.click();
  const enter = calls.find((c) => c.element === rows[0]);
  assert.equal(enter.frames[0].clipPath, 'inset(0px 0px 17px 0px)');
  assert.equal(enter.frames[0].opacity, 0.45);
  assert.equal(enter.frames.at(-1).opacity, 1);
  assert.ok(exits.every((c) => c.animation.cancelled && !c.element.isConnected));
  // Reverse the in-flight expansion; do not flash a fully revealed row first.
  rows[0].style.clipPath = 'inset(0px 0px 9px 0px)';
  rows[0].style.opacity = '0.7';
  calls.length = 0;
  header.click();
  const reversed = calls.find((c) => c.frames[0].clipPath);
  assert.equal(reversed.frames[0].clipPath, 'inset(0px 0px 9px 0px)');
  assert.equal(reversed.frames[0].opacity, 0.7);
  assert.equal(reversed.frames.at(-1).opacity, 0);
  f.dom.window.close();
});

test('marker teardown cancels fold overlays and animations', () => {
  const f = fixture();
  const doc = f.dom.window.document;
  doc.documentElement.setAttribute(f.api.FLATTEN_ATTRIBUTE, '');
  const style = doc.createElement('style');
  style.textContent = f.api.ungroupedCss();
  doc.head.appendChild(style);
  const row = doc.createElement('div');
  row.setAttribute('data-row-key', 'session:cleanup');
  doc.querySelector('#workspace').appendChild(row);
  const animations = [];
  f.dom.window.Element.prototype.animate = () => {
    const animation = { cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  };
  f.dom.window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 240, bottom: 32, width: 240, height: 32 });
  const stop = f.api.markReceiptRows({ ids: new Set(['real']), untitled: '独立对话', clusterView: f.state });
  f.container.querySelector(`[${HEADER}]`).click();
  assert.ok(animations.length > 0);
  assert.ok(doc.querySelector('[data-chat-sessions-fold-exits]'));
  stop();
  assert.equal(doc.querySelector('[data-chat-sessions-fold-exits]'), null);
  assert.ok(animations.every((animation) => animation.cancelled));
  f.dom.window.close();
});

test('cluster fold honours reduced motion', () => {
  const f = fixture();
  f.dom.window.matchMedia = () => ({ matches: true });
  let calls = 0;
  f.dom.window.Element.prototype.animate = () => { calls++; };
  f.paint();
  f.container.querySelector(`[${HEADER}]`).click();
  assert.equal(f.state.collapsed, true);
  assert.equal(calls, 0);
  f.dom.window.close();
});

test('blank session hover preview anchors without a copy label and follows reused cards', async () => {
  let resized;
  let disconnected = false;
  const observed = new Set();
  const f = fixture({ ResizeObserver: class {
    constructor(callback) { resized = callback; }
    observe(node) { observed.add(node); }
    disconnect() { disconnected = true; observed.clear(); }
  } });
  const doc = f.dom.window.document;
  doc.documentElement.setAttribute(f.api.FLATTEN_ATTRIBUTE, '');
  const group = doc.querySelector('#workspace');
  const row = doc.createElement('div');
  row.setAttribute('data-row-key', 'session:blank');
  group.appendChild(row);
  row.getBoundingClientRect = () => ({ left: 16, right: 260, top: 300, bottom: 332, width: 244, height: 32 });
  const row2 = row.cloneNode();
  row2.setAttribute('data-row-key', 'session:existing');
  group.appendChild(row2);
  row2.getBoundingClientRect = () => ({ left: 16, right: 260, top: 380, bottom: 412, width: 244, height: 32 });
  const stop = f.api.markReceiptRows({ ids: new Set(['real']), untitled: '独立对话', clusterView: f.state });
  const over = (target) => target.dispatchEvent(new f.dom.window.MouseEvent('pointerover', { bubbles: true, clientX: 60, clientY: 310 }));
  const flush = async () => { await new Promise((done) => f.dom.window.requestAnimationFrame(() => f.dom.window.requestAnimationFrame(done))); };
  const card = doc.createElement('div');
  card.style.cssText = 'position:fixed;left:0px;top:0px';
  card.getBoundingClientRect = () => ({ left: parseFloat(card.style.left) || 0, top: parseFloat(card.style.top) || 0, width: 250, height: 110, right: 250, bottom: 110 });
  card.innerHTML = '<div class="native_hoverContent"><div>新会话</div><div>空闲</div></div>';
  over(row);
  doc.body.appendChild(card);
  await flush();
  assert.equal(card.style.left, '268px', 'blank preview is positioned at the row right edge');
  assert.equal(card.style.top, '300px');
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', '复制标题');
  over(row2);
  card.style.left = '0px'; card.style.top = '0px';
  await flush();
  assert.equal(card.style.top, '380px', 'reused preview follows the current hovered row');
  card.style.left = '0px'; card.style.top = '0px';
  await flush();
  assert.equal(card.style.left, '268px', 'native style rewrites are corrected');
  const viewport = { width: f.dom.window.innerWidth, height: f.dom.window.innerHeight };
  Object.defineProperty(f.dom.window, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(f.dom.window, 'innerHeight', { configurable: true, value: 563 });
  row2.getBoundingClientRect = () => ({ left: 16, right: 260, top: 484, bottom: 516, width: 244, height: 32 });
  card.getBoundingClientRect = () => ({ left: parseFloat(card.style.left) || 0, top: parseFloat(card.style.top) || 0, width: 244, height: 96, right: 244, bottom: 96 });
  card.style.left = '0px'; card.style.top = '0px';
  await flush();
  assert.equal(card.style.top, '459px', 'the preview keeps the native eight-pixel bottom clearance in the reproduced 563px viewport');
  assert.equal(card.style.left, '268px', 'the ordinary row-adjacent horizontal position stays unchanged when it fits');
  Object.defineProperty(f.dom.window, 'innerHeight', { configurable: true, value: 500 });
  f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));
  await flush();
  assert.equal(card.style.top, '396px', 'an already re-anchored preview follows a smaller viewport without another hover');
  Object.defineProperty(f.dom.window, 'innerHeight', { configurable: true, value: 563 });
  card.getBoundingClientRect = () => ({ left: parseFloat(card.style.left) || 0, top: parseFloat(card.style.top) || 0, width: 244, height: 132, right: 244, bottom: 132 });
  assert.ok(observed.has(card), 'only an eligible re-anchored preview is size-observed');
  resized([{ target: card }]);
  await flush();
  assert.equal(card.style.top, '423px', 'a taller native preview keeps its bottom edge inside the viewport');
  card.getBoundingClientRect = () => ({ left: parseFloat(card.style.left) || 0, top: parseFloat(card.style.top) || 0, width: 244, height: 96, right: 244, bottom: 96 });
  Object.defineProperty(f.dom.window, 'innerWidth', { configurable: true, value: 500 });
  f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));
  await flush();
  assert.equal(card.style.left, '248px', 'the preview remains inside a narrower viewport');
  Object.defineProperty(f.dom.window, 'innerWidth', { configurable: true, value: viewport.width });
  Object.defineProperty(f.dom.window, 'innerHeight', { configurable: true, value: viewport.height });
  row2.getBoundingClientRect = () => ({ left: 16, right: 260, top: 380, bottom: 412, width: 244, height: 32 });
  card.getBoundingClientRect = () => ({ left: parseFloat(card.style.left) || 0, top: parseFloat(card.style.top) || 0, width: 250, height: 110, right: 250, bottom: 110 });
  card.style.left = '0px'; card.style.top = '0px';
  await flush();
  const copy = doc.createElement('button');
  copy.setAttribute('aria-label', '复制');
  doc.body.appendChild(copy);
  over(row2);
  await flush();
  assert.equal(copy.style.left, '', 'ordinary copy controls stay in flow');
  card.style.left = '500px'; card.style.top = '25px';
  await flush();
  assert.equal(card.style.top, '25px', 'a correctly placed native card is left unchanged');
  const replacement = doc.createElement('div');
  replacement.style.cssText = 'position:fixed;left:0px;top:0px';
  replacement.getBoundingClientRect = () => ({ left: parseFloat(replacement.style.left) || 0, top: parseFloat(replacement.style.top) || 0, width: 250, height: 110, right: 250, bottom: 110 });
  replacement.innerHTML = '<div class="native_hoverContent">另一个会话</div>';
  doc.body.appendChild(replacement);
  await flush();
  assert.ok(observed.has(replacement));
  assert.equal(observed.has(card), false, 'switching cards releases the previous size observation');
  card.style.left = '0px'; card.style.top = '0px';
  await flush();
  assert.equal(card.style.left, '0px', 'an old popup callback cannot re-anchor or re-observe a replaced card');
  assert.equal(observed.has(card), false);
  replacement.remove();
  const foreign = doc.createElement('div');
  foreign.setAttribute('data-row-key', 'session:foreign');
  f.container.appendChild(foreign);
  over(foreign);
  card.style.left = '0px'; card.style.top = '0px';
  await flush();
  assert.equal(card.style.left, '0px', 'native workspace cards are outside the flattened cluster correction');
  stop();
  assert.equal(disconnected, true, 'teardown disconnects the shared preview size observer');
  assert.equal(observed.size, 0);
  f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));
  card.style.left = '0px'; card.style.top = '0px';
  await flush();
  assert.equal(card.style.left, '0px', 'teardown cancels correction work');
  f.dom.window.close();
});

// Exercise real marker passes against staged native commits; geometry is deterministic here.
function motionFixture() {
  const f = fixture({ performance, fetch: async () => ({ ok: true }) });
  const doc = f.dom.window.document;
  const style = doc.createElement('style');
  style.textContent = f.api.ungroupedCss();
  doc.head.appendChild(style);
  const group = doc.querySelector('#workspace');
  const row = doc.createElement('div');
  row.setAttribute('data-row-key', 'session:old');
  group.appendChild(row);
  let y = 100;
  Object.defineProperty(row, 'offsetTop', { get: () => y + (f.container.querySelector(`[${HEADER}]`) ? 34 : 0) });
  row.getBoundingClientRect = () => ({ left: 0, top: row.offsetTop, width: 240, height: 32 });
  const calls = [];
  const active = [];
  f.dom.window.Element.prototype.animate = function (frames, options) {
    const animation = { effect: { target: this, getKeyframes: () => frames }, cancel() { this.cancelled = true; }, playState: 'running' };
    active.push(animation);
    calls.push({ element: this, frames, options, animation });
    return animation;
  };
  doc.getAnimations = () => active.filter((a) => !a.cancelled);
  f.dom.window.Element.prototype.getAnimations = function () { return doc.getAnimations().filter((a) => a.effect.target === this); };
  doc.dispatchEvent(new f.dom.window.Event('pointerdown'));
  const state = { ids: new Set(['real']), untitled: '独立对话', clusterView: f.state };
  let stop = f.api.markReceiptRows(state);
  const pass = () => { stop(); stop = f.api.markReceiptRows(state); };
  return { ...f, doc, group, row, calls, active, state, pass, move: (next) => { y = next; }, close: () => { stop(); f.dom.window.close(); } };
}

test('retained archived receipts do not leave a cluster header when native filtering removes all sessions', () => {
  const f = motionFixture();
  try {
    f.row.remove(); f.pass();
    assert.equal(f.container.querySelector(`[${HEADER}]`), null);
    assert.equal(f.container.hasAttribute('data-chat-sessions-cluster-divider'), false);
    f.group.append(f.row); f.pass();
    assert.ok(f.container.querySelector(`[${HEADER}]`), 'native archived filter showing the row restores cluster controls');
  } finally { f.close(); }
});

for (const scrollTop of [0, 90, 180]) {
  test(`native parent remount preserves entry and survivor clocks at scroll ${scrollTop}`, () => {
    const f = motionFixture();
    try {
      const parent = f.doc.createElement('section');
      parent.innerHTML = '<div><div data-row-key="workspace:parent" aria-expanded="true">Parent</div></div><div role="group"></div>';
      f.container.append(parent);
      const children = parent.lastElementChild;
      f.group.style.setProperty('--dsh-workspace-indent', '12px');
      children.append(f.group); f.pass();
      f.container.scrollTop = scrollTop;
      // Native recreates receipt wrappers when a parent reopens. The previous
      // absolute baseline must not become an entry translation from above.
      const replacement = f.group.cloneNode(true);
      replacement.style.removeProperty('display');
      const row = replacement.querySelector('[data-row-key="session:old"]');
      Object.defineProperty(row, 'offsetTop', { value: 400 });
      f.group.replaceWith(replacement);
      const entry = row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: 'ease-out' });
      const survivor = row.animate([{ transform: 'translate(0px, -68px)', opacity: 0.4 }, { transform: 'translate(0, 0)', opacity: 1 }], { duration: 200, easing: 'ease-out' });
      entry.currentTime = 34; survivor.currentTime = 71;
      f.calls.length = 0; f.pass();
      assert.ok(!entry.cancelled && !survivor.cancelled, 'native entry/FLIP must retain ownership through wrapper marking');
      assert.equal(entry.currentTime, 34); assert.equal(survivor.currentTime, 71);
      assert.equal(f.calls.length, 0, 'no second offsetTop glide overlays native expansion');
      assert.equal(replacement.parentElement, children);
    } finally { f.close(); }
  });
}

test('native parent collapse and expansion through the observer keep native animations', async () => {
  const f = motionFixture();
  try {
    const parent = f.doc.createElement('section');
    parent.innerHTML = '<div><div data-row-key="workspace:parent" aria-expanded="true">Parent</div></div><div role="group"></div>';
    f.container.append(parent);
    const children = parent.lastElementChild;
    f.group.style.setProperty('--dsh-workspace-indent', '12px');
    children.append(f.group);
    await new Promise(setImmediate);
    f.calls.length = 0;
    const template = f.group.cloneNode(true);
    f.group.remove(); parent.firstElementChild.firstElementChild.setAttribute('aria-expanded', 'false');
    await new Promise(setImmediate);
    assert.equal(f.doc.querySelector('[data-chat-sessions-mode-overlay]'), null);
    const row = template.querySelector('[data-row-key="session:old"]');
    template.style.removeProperty('display');
    Object.defineProperty(row, 'offsetTop', { value: 400 });
    children.append(template); parent.firstElementChild.firstElementChild.setAttribute('aria-expanded', 'true');
    const entry = row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: 'ease-out' });
    entry.startTime = 700; entry.currentTime = 20;
    f.calls.length = 0;
    await new Promise(setImmediate);
    assert.ok(!entry.cancelled);
    assert.equal(entry.startTime, 700); assert.equal(entry.currentTime, 20);
    assert.equal(f.calls.length, 0);
    assert.equal(f.doc.querySelector('[data-chat-sessions-mode-overlay]'), null);
    assert.equal(template.parentElement, children);
  } finally { f.close(); }
});

test('native parent input captures peers before remount and corrects only their oversized FLIP', async () => {
  const f = motionFixture();
  try {
    const parent = f.doc.createElement('section');
    parent.innerHTML = '<div><div data-row-key="workspace:parent" aria-expanded="true">Parent</div></div><div role="group"></div>';
    const peerGroup = f.doc.createElement('section');
    peerGroup.innerHTML = '<div><div data-row-key="workspace:peer">Following workspace</div></div>';
    f.container.append(parent, peerGroup);
    const children = parent.lastElementChild, heading = parent.firstElementChild.firstElementChild;
    const peer = peerGroup.firstElementChild.firstElementChild;
    let y = 250, native;
    peer.getBoundingClientRect = () => { const top = y - (native && !native.cancelled ? 500 : 0); return { top, bottom: top + 32, left: 0, right: 240, width: 240, height: 32 }; };
    f.group.style.setProperty('--dsh-workspace-indent', '12px'); children.append(f.group);
    await new Promise(setImmediate);
    const restored = f.group.cloneNode(true);
    f.group.remove(); heading.setAttribute('aria-expanded', 'false');
    await new Promise(setImmediate);
    heading.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    y = 400; restored.style.removeProperty('display'); children.append(restored); heading.setAttribute('aria-expanded', 'true');
    const row = restored.querySelector('[data-row-key="session:old"]');
    const entry = row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
    native = peer.animate([{ transform: 'translate(0px, -500px)' }, { transform: 'translate(0, 0)' }], { duration: 200 });
    f.calls.length = 0;
    await new Promise(setImmediate);
    assert.equal(native.cancelled, true);
    assert.ok(!entry.cancelled);
    const move = f.calls.find(c => c.element === peer);
    assert.equal(move.frames[0].transform, 'translate(0px, -150px)');
    assert.equal(f.calls.length, 1);
    assert.equal(f.doc.querySelector('[data-chat-sessions-mode-overlay]'), null);
    assert.equal(restored.parentElement, children);
    const correction = move.animation;
    const reversed = peer.animate([{ transform: 'translate(0px, 80px)' }, { transform: 'translate(0, 0)' }], { duration: 200 });
    reversed.currentTime = 12;
    peer.append(f.doc.createTextNode(' native reverse'));
    await new Promise(setImmediate);
    assert.equal(correction.cancelled, true, 'next native commit supersedes the peer correction');
    assert.ok(!reversed.cancelled); assert.equal(reversed.currentTime, 12);
  } finally { f.close(); }
});

test('nested receipt remount without native animation never flies from an old baseline', () => {
  const f = motionFixture();
  try {
    f.group.style.setProperty('--dsh-workspace-indent', '12px'); f.pass();
    f.group.style.removeProperty('display'); f.move(400); f.calls.length = 0;
    f.pass();
    assert.equal(f.calls.length, 0, 'a native tree remount is not a plugin reorder');
    f.state.pinRanks = new Map([['old', 0]]);
    const pin = f.doc.createElement('span'); pin.className = 'pinIndicator'; f.row.append(pin);
    f.move(368); f.pass();
    assert.equal(f.calls.filter(c => c.element === f.row).length, 1, 'actual plugin pin order still glides inside the tree');
  } finally { f.close(); }
});

test('unchanged marker passes do not measure unused row rectangles', () => {
  const f = motionFixture();
  let reads = 0;
  const rect = f.row.getBoundingClientRect;
  f.row.getBoundingClientRect = () => { reads++; return rect(); };
  try {
    for (let i = 0; i < 20; i++) f.pass();
    assert.equal(reads, 0, 'final-layout motion must not collect discarded before rectangles');
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('cluster header joins native keyed position snapshots with a stable distinct identity', () => {
  const f = motionFixture();
  try {
    const header = f.container.querySelector(`[${HEADER}]`);
    const key = header.getAttribute('data-row-key');
    assert.equal(key, 'chat-sessions:cluster-header');
    assert.ok([...f.container.querySelectorAll('[data-row-key]')].includes(header));
    f.pass();
    assert.equal(header.getAttribute('data-row-key'), key);
    assert.equal(f.container.querySelectorAll(`[data-row-key="${key}"]`).length, 1);
  } finally { f.close(); }
});

test('native exit clones of the extra keyed header never paint a duplicate', () => {
  const f = motionFixture();
  try {
    const header = f.container.querySelector(`[${HEADER}]`);
    // Native nextKeys only contains host rows. Its removed snapshot clones this
    // extra keyed descendant, removes the key and marks it inert for the overlay.
    const exit = header.cloneNode(true);
    exit.removeAttribute('data-row-key');
    exit.setAttribute('inert', '');
    const overlay = f.doc.createElement('div');
    overlay.setAttribute('aria-hidden', 'true');
    f.container.after(overlay);
    overlay.appendChild(exit);
    assert.equal(f.dom.window.getComputedStyle(exit).display, 'none', 'inert native exit is hidden before observer reconciliation');
    assert.notEqual(f.dom.window.getComputedStyle(header).display, 'none');
    f.pass();
    assert.equal(exit.isConnected, false, 'marker clears the obsolete clone');
    assert.equal(f.container.querySelectorAll(`[${HEADER}]`).length, 1);
  } finally { f.close(); }
});

for (const scenario of [
  { name: 'top', before: 0, after: 0 },
  { name: 'middle', before: 90, after: 90 },
  { name: 'bottom clamped', before: 120, after: 52 },
]) {
  test(`foreign workspace folding keeps native motion and clock at ${scenario.name}`, () => {
    const f = motionFixture();
    try {
      f.container.scrollTop = scenario.before;
      f.row.getBoundingClientRect = () => ({ left: 0, top: f.row.offsetTop - f.container.scrollTop, width: 240, height: 32 });
      f.pass();
      const header = f.container.querySelector(`[${HEADER}]`);
      for (const expanding of [false, true]) {
        const fromScroll = expanding ? scenario.after : scenario.before;
        const toScroll = expanding ? scenario.before : scenario.after;
        const layoutDelta = expanding ? -68 : 68;
        f.container.scrollTop = toScroll;
        f.move(expanding ? 100 : 32);
        // Native getBoundingClientRect includes scroll clamping: at bottom the
        // layout displacement is fully cancelled, while offsetTop still changes.
        const dy = layoutDelta + toScroll - fromScroll;
        const frames = [{ transform: `translate(0px, ${dy}px)`, opacity: 1 }, { transform: 'translate(0, 0)', opacity: 1 }];
        const native = f.row.animate(frames, { duration: 200, easing: 'ease-out' });
        const title = header.animate(frames, { duration: 200, easing: 'ease-out' });
        native.startTime = title.startTime = 123;
        native.currentTime = title.currentTime = 83;
        f.calls.length = 0;
        f.pass();
        assert.ok(!native.cancelled, 'native viewport-aware transform is retained');
        assert.ok(!title.cancelled, 'header stays on the same native clock');
        assert.equal(native.currentTime, title.currentTime);
        assert.equal(f.calls.length, 0, 'marker never restarts a 200ms movement');
        native.cancel(); title.cancel();
      }
    } finally { f.close(); }
  });
}

test('foreign collapse with zero viewport displacement does not invent a glide', () => {
  const f = motionFixture();
  try {
    f.pass();
    f.container.scrollTop = 120;
    f.row.getBoundingClientRect = () => ({ top: f.row.offsetTop - f.container.scrollTop, left: 0, width: 240, height: 32 });
    const before = f.row.getBoundingClientRect().top;
    f.move(32);
    f.container.scrollTop = 52;
    assert.equal(f.row.getBoundingClientRect().top, before);
    f.calls.length = 0;
    f.pass();
    assert.equal(f.calls.length, 0, 'scroll clamp must not become an offsetTop-only movement');
  } finally { f.close(); }
});

test('layout baseline includes header geometry and unchanged passes never glide', () => {
  const f = motionFixture();
  try {
    f.pass();
    f.pass();
    assert.equal(f.calls.length, 0, 'header installation must not be mistaken for a row move on the next pass');
  } finally { f.close(); }
});

test('insertion retires intermediate header motion without moving its final anchor', () => {
  const f = motionFixture();
  try {
    const header = f.container.querySelector(`[${HEADER}]`);
    Object.defineProperty(header, 'offsetTop', { get: () => 100 });
    header.getBoundingClientRect = () => ({ top: 100, left: 0, width: 240, height: 32 });
    f.pass();
    const native = header.animate([{ transform: 'translate(0px, -34px)' }, { transform: 'translate(0, 0)' }], { duration: 200 });
    const added = f.doc.createElement('div');
    added.setAttribute('data-row-key', 'session:new-header');
    f.group.appendChild(added);
    f.move(134);
    f.calls.length = 0;
    f.pass();
    assert.equal(native.cancelled, true, 'the title must not carry the hidden receipt header displacement');
    assert.equal(f.calls.filter((call) => call.element === header).length, 0, 'unchanged final anchor stays still');
  } finally { f.close(); }
});

test('native intermediate transforms are replaced by one final-layout glide on insertion', () => {
  const f = motionFixture();
  try {
    f.pass();
    f.calls.length = 0;
    const foreign = f.doc.querySelector('[data-row-key="workspace:real"]');
    const foreignAnimation = foreign.animate([{ transform: 'translateY(-34px)' }, { transform: 'none' }], { duration: 200 });
    const native = f.row.animate([{ transform: 'translate(0px, -68px)', opacity: 1 }, { transform: 'translate(0, 0)', opacity: 1 }], { duration: 200 });
    const added = f.doc.createElement('div');
    added.setAttribute('data-row-key', 'session:added');
    Object.defineProperty(added, 'offsetTop', { get: () => 134 });
    f.group.prepend(added);
    const fade = added.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
    f.move(134);
    f.calls.length = 0;
    f.pass();
    assert.equal(native.cancelled, true, 'native transform measured before flattening is retired');
    assert.ok(!foreignAnimation.cancelled, 'workspace header animation stays native');
    assert.ok(!fade.cancelled, 'new row keeps native opacity fade');
    const movement = f.calls.filter((call) => call.element === f.row);
    assert.equal(movement.length, 1);
    assert.equal(movement[0].frames[0].transform, 'translateY(-34px)');
    assert.equal(movement[0].options.duration, 200);
    assert.equal(movement[0].options.easing, 'ease-out');
    f.calls.length = 0;
    f.pass();
    assert.equal(f.calls.length, 0, 'refresh does not replay entry motion');
  } finally { f.close(); }
});

test('membership reconciliation runs before the next animation frame', async () => {
  const f = motionFixture();
  try {
    f.pass();
    f.calls.length = 0;
    f.move(134);
    const native = f.row.animate([{ transform: 'translateY(-68px)' }, { transform: 'none' }], { duration: 200 });
    const added = f.doc.createElement('div');
    added.setAttribute('data-row-key', 'session:microtask');
    f.group.appendChild(added);
    await new Promise(setImmediate);
    assert.equal(native.cancelled, true);
    assert.ok(f.calls.some((call) => call.element === f.row && call.frames[0].transform === 'translateY(-34px)'));
  } finally { f.close(); }
});

test('recent activity orders pins internally and promotes ordinary rows only below pins', () => {
  const f = motionFixture();
  try {
    const times = { old: 50, pinNew: 80, ordinaryOld: 10, ordinaryNew: 100 };
    const rows = { old: f.row };
    for (const id of ['pinNew', 'ordinaryOld', 'ordinaryNew']) {
      const group = f.group.cloneNode(true);
      group.querySelector('[data-row-key^="workspace:"]').dataset.rowKey = `workspace:${id}`;
      const row = group.querySelector('[data-row-key^="session:"]');
      row.dataset.rowKey = `session:${id}`;
      f.container.append(group);
      f.state.ids.add(id);
      rows[id] = row;
    }
    for (const id of ['old', 'pinNew']) rows[id].innerHTML = '<span class="pinIndicator"></span>';
    f.state.pinRanks = new Map([['old', 0], ['pinNew', 1]]);
    f.state.activityOf = id => times[id];
    f.pass();
    const ordered = () => Object.keys(rows).sort((a, b) => +rows[a].style.order - +rows[b].style.order);
    assert.deepEqual(ordered(), ['pinNew', 'old', 'ordinaryNew', 'ordinaryOld'], 'pin activity outranks pin registration order');
    times.ordinaryOld = 200;
    f.pass();
    assert.deepEqual(ordered(), ['pinNew', 'old', 'ordinaryOld', 'ordinaryNew'], 'ordinary activity cannot cross the pinned boundary');
    times.old = 300;
    f.pass();
    assert.deepEqual(ordered(), ['old', 'pinNew', 'ordinaryOld', 'ordinaryNew']);
    times.pinNew = 300;
    f.pass();
    assert.deepEqual(ordered(), ['old', 'pinNew', 'ordinaryOld', 'ordinaryNew'], 'equal activity uses stable native pin order');
  } finally { f.close(); }
});

test('all pins remain above ordinary activity beyond the eight legacy diagnostic ranks', () => {
  const f = motionFixture();
  try {
    f.state.activityOf = id => id === 'old' ? 1000 : Number(id.slice(3));
    const pins = [];
    for (let i = 0; i < 12; i++) {
      const row = f.doc.createElement('div');
      row.dataset.rowKey = `session:pin${i}`;
      row.innerHTML = '<span class="pinIndicator"></span>';
      f.group.append(row);
      pins.push(row);
    }
    f.pass();
    assert.ok(pins.every(row => +row.style.order < +f.row.style.order), 'no pin falls back to the ordinary partition');
    assert.equal(new Set(pins.map(row => row.style.order)).size, 12);
  } finally { f.close(); }
});

test('visible blank sorts before pins and becomes ordinary after its first turn', () => {
  const f = motionFixture();
  try {
    f.row.innerHTML = '<span class="pinIndicator" role="img"></span>';
    f.state.pinRanks = new Map([['old', 0]]);
    const blank = f.doc.createElement('div');
    blank.setAttribute('data-row-key', 'session:blank');
    blank.textContent = 'arbitrary localized title';
    f.group.appendChild(blank);
    let isBlank = true;
    f.state.isBlank = (id) => id === 'blank' && isBlank;
    f.pass();
    const header = f.container.querySelector(`[${HEADER}]`);
    assert.ok(+f.dom.window.getComputedStyle(header).order < +blank.style.order);
    assert.ok(+blank.style.order < +f.row.style.order, 'blank first even when DOM order places the pin first');
    isBlank = false;
    f.pass();
    assert.ok(+blank.style.order > +f.row.style.order, 'a real conversation returns below pins');
  } finally { f.close(); }
});

test('unpin and replaced nodes override stale poll ranks immediately', () => {
  const f = motionFixture();
  try {
    f.row.innerHTML = '<span class="pinIndicator"></span>';
    f.state.pinRanks = new Map([['old', 0]]);
    f.pass();
    assert.ok(+f.row.style.order < 100);
    f.row.replaceChildren();
    f.pass();
    assert.equal(f.row.style.order, '100', 'no wait for the next status response');
    const clone = f.row.cloneNode(true);
    f.row.replaceWith(clone);
    f.pass();
    assert.equal(clone.style.order, '100', 'React replacement cannot resurrect a stale pin');
    const native = clone.animate([{ transform: 'translateY(-34px)' }, { transform: 'none' }], { duration: 200 });
    f.calls.length = 0;
    f.state.rooms = new Map([['real', { pinned: true, pinIndex: 0 }]]);
    f.pass();
    assert.ok(!native.cancelled, 'stale room diagnostics cannot restart native motion');
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

test('newly pinned rows rank immediately before the status poll', () => {
  const f = motionFixture();
  try {
    f.row.innerHTML = '<span class="pinIndicator"></span>';
    f.pass();
    assert.ok(+f.row.style.order < 100, 'native indicator is already current');
  } finally { f.close(); }
});

test('blank insertion above a pin glides once and stale status refresh never replays it', () => {
  const f = motionFixture();
  try {
    f.row.innerHTML = '<span class="pinIndicator"></span>';
    f.state.pinRanks = new Map([['old', 0]]);
    f.pass();
    const header = f.container.querySelector(`[${HEADER}]`);
    const titleMotion = header.animate([{ transform: 'translateY(-34px)' }, { transform: 'none' }], { duration: 200 });
    const pinMotion = f.row.animate([{ transform: 'translateY(-68px)' }, { transform: 'none' }], { duration: 200 });
    const blank = f.doc.createElement('div');
    blank.setAttribute('data-row-key', 'session:blank');
    f.group.appendChild(blank);
    f.state.isBlank = (id) => id === 'blank';
    f.move(134);
    f.calls.length = 0;
    f.pass();
    assert.ok(+blank.style.order < +f.row.style.order);
    assert.equal(titleMotion.cancelled, true);
    assert.equal(pinMotion.cancelled, true);
    const moves = f.calls.filter((call) => call.element === f.row);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].frames[0].transform, 'translateY(-34px)');
    // Unpin after the insertion. The stale HTTP response still names the old pin.
    f.row.replaceChildren();
    f.pass();
    assert.equal(f.row.style.order, '100');
    f.calls.length = 0;
    for (const pinned of [true, false, true]) {
      f.state.rooms = new Map([['real', { pinned, pinIndex: pinned ? 0 : null }]]);
      f.pass();
    }
    assert.equal(f.calls.length, 0, 'evidence-only room updates do not animate');
    assert.equal(f.row.style.order, '100');
  } finally { f.close(); }
});

test('pin-style movement glides, then folding retires that motion', () => {
  const f = motionFixture();
  try {
    f.pass();
    f.state.pinRanks = new Map([['old', 0]]);
    f.row.innerHTML = '<span class="pinIndicator"></span>';
    f.move(66);
    f.pass();
    const movement = f.calls.find((call) => call.element === f.row);
    assert.equal(movement.frames[0].transform, 'translateY(34px)');
    f.container.querySelector(`[${HEADER}]`).click();
    assert.equal(movement.animation.cancelled, true);
    f.calls.length = 0;
    f.pass();
    assert.equal(f.calls.length, 0, 'fold does not cause a second glide on the marker pass');
  } finally { f.close(); }
});

test('reduced-motion preference suppresses glides while refreshing the layout baseline', () => {
  const f = motionFixture();
  try {
    f.pass();
    f.dom.window.matchMedia = () => ({ matches: true });
    f.move(134);
    f.pass();
    assert.equal(f.calls.length, 0);
    f.dom.window.matchMedia = () => ({ matches: false });
    f.pass();
    assert.equal(f.calls.length, 0, 'reenabling motion does not replay a skipped transition');
  } finally { f.close(); }
});

test('completed repeated new-chat clicks do not replay cluster expansion', async () => {
  const f = fixture();
  const calls = [];
  f.dom.window.Element.prototype.animate = (...args) => { calls.push(args); return { cancel() {} }; };
  let opened = 0;
  f.paint(async () => { opened++; });
  const button = f.container.querySelector(`[${ACTION}]`);
  for (let i = 0; i < 3; i++) { button.click(); await new Promise(setImmediate); }
  assert.equal(opened, 3, 'navigation may focus the reused blank');
  assert.equal(calls.length, 0, 'an already expanded cluster has no new entry animation');
  f.dom.window.close();
});

test('click and keyboard fold the entire cluster and state survives repaint', () => {
  const f = fixture();
  f.paint();
  const header = f.container.querySelector(`[${HEADER}]`);
  header.click();
  assert.equal(f.state.collapsed, true);
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.ok(f.container.hasAttribute(COLLAPSED));
  f.paint();
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  header.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(f.state.collapsed, false);
  header.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(f.state.collapsed, true);
  f.dom.window.close();
});
