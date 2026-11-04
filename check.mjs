#!/usr/bin/env node
/**
 * Package self-check for dsh-chat-sessions.
 *
 * Verifies the manifest, the exported resources, the patch shape and JS syntax —
 * without installing anything and without touching the profile.
 *
 *   node check.mjs
 *
 * Exit code 0 = skeleton is installable; 1 = a check failed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const failures = [];
const notes = [];

const fail = (msg) => failures.push(msg);
const ok = (msg) => notes.push(`ok   ${msg}`);
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/** package.json ------------------------------------------------------------ */
let pkg;
try {
  pkg = JSON.parse(read('package.json'));
  ok('package.json parses');
} catch (error) {
  fail(`package.json does not parse: ${error.message}`);
}

if (pkg) {
  if (!pkg.name) fail('package.json: missing name');
  else if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name)) fail(`package.json: suspicious name "${pkg.name}"`);
  else ok(`name ${pkg.name}`);

  if (!pkg.version) fail('package.json: missing version');
  if (pkg.type !== 'module') fail('package.json: "type" must be "module" (ESM halves)');
   if (pkg.name !== 'dsh-chat-sessions') fail('package.json: unexpected public package name');
   if (pkg.license !== 'MIT' || pkg.author !== 'zsqbfan') fail('package.json: unexpected license or author');
   if (pkg.private === true) fail('package.json: release package is marked private');
  if (!pkg.engines?.dsh) fail('package.json: missing engines.dsh');
  else ok(`engines.dsh ${pkg.engines.dsh}`);

  const patch = pkg.dsh?.bundle?.patch;
  if (!patch) fail('package.json: missing dsh.bundle.patch');
  else ok(`dsh.bundle.patch ${patch}`);

  const client = pkg.dsh?.client;
  if (!client) fail('package.json: missing dsh.client (required for the client half)');
  else {
    if (client.platform !== 'web') fail('package.json: dsh.client.platform must be "web"');
    if (!Array.isArray(client.inject) || client.inject.length === 0) {
      fail('package.json: dsh.client.inject should list the client packages this half extends');
    } else ok(`dsh.client.inject ${client.inject.join(', ')}`);
  }

  /** exports must resolve to real files */
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    if (target.includes('*')) {
      // pattern export, e.g. ./locale/*.json — check at least one match exists
      const dir = join(root, dirname(target));
      try {
        statSync(dir);
        ok(`exports["${key}"] pattern dir exists`);
      } catch {
        fail(`exports["${key}"] → ${target}: directory ${dirname(target)} missing`);
      }
      continue;
    }
    try {
      statSync(join(root, target));
      ok(`exports["${key}"] → ${target}`);
    } catch {
      fail(`exports["${key}"] → ${target}: file missing`);
    }
  }

  /** files[] must carry every runtime artifact */
  const files = pkg.files ?? [];
  for (const needle of ['index.js', 'client.js', 'links.js', 'gc.js', 'cordis.patch.yml', 'icon.svg']) {
    if (!files.some((entry) => entry === needle || entry.startsWith(needle.replace(/\.(js|svg|yml)$/, '')))) {
      fail(`files[] does not cover ${needle}`);
    }
  }
  if (!files.some((entry) => entry.includes('locale'))) fail('files[] does not cover locale/*.json');
  if (failures.length === 0) ok('files[] covers the runtime artifacts');
}

/** locale resources -------------------------------------------------------- */
for (const locale of ['en', 'zh']) {
  try {
    const data = JSON.parse(read(`locale/${locale}.json`));
    const title = data?.meta?.title;
    const description = data?.meta?.description;
    if (!title) fail(`locale/${locale}.json: missing meta.title`);
    else if (!description) fail(`locale/${locale}.json: missing meta.description`);
    else ok(`locale/${locale}.json meta ${title}`);
  } catch (error) {
    fail(`locale/${locale}.json: ${error.message}`);
  }
}

/** icon -------------------------------------------------------------------- */
try {
  const svgPath = join(root, 'icon.svg');
  const { size } = statSync(svgPath);
  const head = read('icon.svg').trimStart().slice(0, 200);
  if (!head.startsWith('<svg')) fail('icon.svg: does not start with <svg');
  else if (size > 256 * 1024) fail(`icon.svg: ${size} bytes exceeds the 256 KiB limit`);
  else ok(`icon.svg ${size} bytes, SVG root present`);
} catch (error) {
  fail(`icon.svg: ${error.message}`);
}

/** patch shape ------------------------------------------------------------- */
try {
  const yml = read('cordis.patch.yml');
  if (!/^\s*-\s*insert:/m.test(yml)) fail('cordis.patch.yml: no top-level `- insert:` entry');
  else if (!/name:\s*'dsh-chat-sessions'/.test(yml)) fail('cordis.patch.yml: insert row does not name this package');
  else ok('cordis.patch.yml inserts one row for this package');
  if (/^\s*-?\s*id:\s*web\s*$/m.test(yml)) fail('cordis.patch.yml: must not patch host rows owned by other bundles');
} catch (error) {
  fail(`cordis.patch.yml: ${error.message}`);
}

/** S2+ host half ----------------------------------------------------------- */
/** Host services this profile actually provides; `inject` must never name anything else. */
const KNOWN_SERVICES = new Set([
  'agents',
  'sessionController',
  'sessionPersistence',
  'sessionQuery',
  'sessions',
  'webServer',
  'workspaceRegistry',
]);

const hostSource = read('index.js');

for (const specifier of hostSource.matchAll(/from\s+'([^']+)'|import\s*\(\s*'([^']+)'/g)) {
  const target = specifier[1] ?? specifier[2];
  if (!target.startsWith('node:') && !target.startsWith('./')) {
    fail(`index.js imports "${target}"; a linked bundle can only resolve node: builtins and its own files`);
  }
}
if (hostSource.includes('ensureMaterialized')) {
  fail('index.js: sessionPersistence has no ensureMaterialized; the durability barrier is flush()');
}

try {
  const host = await import(new URL('./index.js', import.meta.url).href);
  if (host.name !== 'chat-sessions') fail(`index.js exports name ${JSON.stringify(host.name)}`);
  else ok('index.js exports name chat-sessions');
  if (typeof host.apply !== 'function') fail('index.js does not export apply() as a function');
  else ok('index.js exports apply()');
  if (!Array.isArray(host.inject)) fail('index.js inject is not an array');
  else {
    const unknown = host.inject.filter((entry) => !KNOWN_SERVICES.has(entry));
    if (unknown.length) fail(`index.js injects services this profile does not provide: ${unknown.join(', ')}`);
    else if (host.inject.length === 0) fail('index.js inject is empty although the host half is active');
    else ok(`inject ${host.inject.join(', ')}`);
  }
  if (!/ROUTE_PREFIX\}\/config/.test(hostSource)) fail('index.js serves no /chat-sessions/config route; the client switch would be dead');
  else if (typeof host.flattenUngrouped !== 'function') fail('index.js does not export flattenUngrouped()');
  else if (host.flattenUngrouped(undefined) !== true || host.flattenUngrouped({}) !== true) {
    fail('flattenUngrouped() must default to on when the config omits it');
  } else if (host.flattenUngrouped({ flattenUngrouped: false }) !== false) {
    fail('flattenUngrouped() ignores an explicit false');
  } else ok('flattenUngrouped defaults on, honours config false, and is served by GET /chat-sessions/config');
  /** S4b: turning the seed off by default is what keeps new logs valid. */
  if (typeof host.seedFirstTurnEnabled !== 'function') fail('index.js does not export seedFirstTurnEnabled()');
  else if (host.seedFirstTurnEnabled(undefined) !== false || host.seedFirstTurnEnabled({}) !== false) {
    fail('seedFirstTurn must default to OFF: a seeded turn collides with the agent\'s turn counter');
  } else if (host.seedFirstTurnEnabled({ seedFirstTurn: true }) !== true) {
    fail('seedFirstTurnEnabled() ignores an explicit true');
  } else ok('seedFirstTurn defaults off (seeded turns corrupt the log) and needs an explicit opt-in');
  /** A route: the session directory doubles as a workspace unless the operator opts out. */
  if (typeof host.ownershipOf !== 'function') fail('index.js does not export ownershipOf()');
  else if (host.ownershipOf(undefined) !== 'workspace' || host.ownershipOf({}) !== 'workspace') {
    fail('ownershipOf() must default to "workspace"');
  } else if (host.ownershipOf({ ownership: 'bare' }) !== 'bare') {
    fail('ownershipOf() ignores ownership: bare');
  } else if (!/workspaceRegistry\.create\(/.test(hostSource) || !/attachSession\(/.test(hostSource)) {
    fail('index.js never registers/attaches the per-session workspace');
  } else ok('ownership defaults to workspace and the receipt workspace is created and attached');
  /** D3: the chip label, the picker row and the docs must agree on one neutral string. */
  if (typeof host.untitledWorkspaceTitle !== 'function') fail('index.js does not export untitledWorkspaceTitle()');
  else if (host.untitledWorkspaceTitle(undefined) !== '独立对话') {
    fail(`untitledWorkspaceTitle() must default to 独立对话, got ${host.untitledWorkspaceTitle(undefined)}`);
  } else if (host.untitledWorkspaceTitle({ untitledWorkspaceTitle: '自定义' }) !== '自定义') {
    fail('untitledWorkspaceTitle() ignores an explicit override');
  } else ok('untitledWorkspaceTitle defaults to 独立对话 and honours an override (report D3)');
  /** D1: the workspace layer and the link layer must fail independently. */
  if (!hostSource.includes('await ensureSessionWorkspace(sessionId, snapshot.header.cwd)')) {
    fail('index.js must attach the session to the workspace of its real cwd (report D1)');
  } else if (!hostSource.includes('workspaceErrors.set(') || !hostSource.includes("status: 'workspace-error'")) {
    fail('a workspace failure must be reported per session instead of swallowed (report D1)');
  } else if (!hostSource.includes('const roomTarget = linkTarget(linkName);')) {
    fail('the link layer must be keyed on the session directory, not on the session id (report D1)');
  } else if ((hostSource.match(/reason: 'owned-by-sibling'/g) ?? []).length < 2) {
    fail("both the sweep and POST /chat-sessions/link must answer reason: 'owned-by-sibling' (report R9)");
  } else ok('index.js separates workspace and link failures and keys links on the real cwd (D1)');
  /** Round 3 §2.4: a receipt workspace left behind by an archived session must still be renamed. */
  if (!hostSource.includes('async function normalizeReceiptTitles()')) {
    fail('index.js must normalise receipt workspace titles registry-wide (round 3 §2.4)');
  } else if (!hostSource.includes('reports.push(...(await normalizeReceiptTitles()));')) {
    fail('sweep() must run normalizeReceiptTitles() — a stale receipt has no session to visit it');
  } else if (!hostSource.includes('if (workspace.sessionIds.length > 0) continue;')
    || !hostSource.includes('await ctx.workspaceRegistry.delete(workspace.id);')) {
    fail('only a receipt with no sessions and no directory may be dropped (round 3 §2.4)');
  } else ok('receipt workspaces are re-titled every sweep and orphans are dropped (round 3 §2.4)');
} catch (error) {
  fail(`index.js does not import: ${error.message}`);
}

/** S3+ client half --------------------------------------------------------- */
/** Seed modules the shell exposes to a dynamic client bundle (staticModules). */
const REQUIRABLE = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']);
/** Client services this app actually provides; `inject` must stay inside this set. */
const KNOWN_CLIENT_SERVICES = new Set([
  'layout',
  'locale',
  'sessions',
  'slots',
  'theme',
  'timer',
  'uiWorkspace',
  'workspaces',
]);

const clientSource = read('client.js');
/** D2: the native search row has no slot for its workspace label, so it is rewritten in place. */
if (!clientSource.includes('searchResultWorkspace')) {
  fail('client.js no longer normalises receipt workspace labels in search results (report D2)');
} else ok('client.js rewrites receipt workspace labels inside the native search rows');
/** D3: the picker row must use the same neutral label as the workspace chip. */
if (!clientSource.includes("'picker.noWorkspace': '独立对话'")) {
  fail('client.js picker label drifted from the workspace chip label (report D3)');
} else ok('client.js picker row and workspace chip share the 独立对话 label');
/** A route keeps receipt workspaces out of the picker and out of the row list. */
for (const [needle, why] of [
  ['isReceiptWorkspace(', 'client.js must recognise receipt workspaces by path'],
  ['data-chat-sessions-owned', 'client.js must mark the receipt row so it can be hidden'],
  ['data-chat-sessions-bucket', 'client.js must mark the receipt group so the indent can be zeroed'],
  ['aria-expanded', 'client.js must expand a collapsed receipt group before hiding its row'],
  [
    'workspace.workspaceId ?? workspace.id',
    'picker rows must read the WorkspaceSnapshot id field (`id` alone is undefined and breaks every real workspace row)',
  ],
]) {
  if (!clientSource.includes(needle)) fail(`${why}: missing ${needle}`);
}

const clientInject = pkg?.dsh?.client?.inject ?? [];

for (const match of clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
  const spec = match[1];
  if (!REQUIRABLE.has(spec)) {
    fail(`client.js requires "${spec}"; a dynamic bundle only resolves the shell seed modules (${[...REQUIRABLE].join(', ')})`);
  } else if (spec.startsWith('@deepseek-ai/') && !clientInject.includes(spec)) {
    fail(`client.js requires ${spec} but dsh.client.inject does not list it`);
  }
}
if (clientSource.includes('conversation.hero.workspace') && !/priority:\s*-\d+/.test(clientSource)) {
  fail('client.js shadows conversation.hero.workspace without a negative priority — a `single` slot throws on equal priority');
}

try {
  let entry;
  globalThis.window = { __ModuleLoader__: { load: (candidate) => { entry = candidate; } } };
  await import(pathToFileURL(join(root, 'client.js')).href);
  if (!entry) throw new Error('__ModuleLoader__.load() was never called');
  if (entry.id !== pkg?.name) fail(`client.js registers id ${JSON.stringify(entry.id)}; expected ${JSON.stringify(pkg?.name)}`);
  else ok(`client.js registers id ${entry.id}`);

  const reactStub = { Fragment: Symbol('Fragment'), createElement: () => null, useState: (value) => [value, () => {}], useCallback: (fn) => fn };
  const jsxRuntimeStub = { Fragment: Symbol('Fragment'), jsx: () => null, jsxs: () => null };
  const half = entry.factory((spec) =>
    spec === 'react'
      ? reactStub
      : spec === 'react/jsx-runtime'
        ? jsxRuntimeStub
        : {}, // primitives miss on purpose: apply() must degrade, not throw
  );

  if (!Array.isArray(half?.inject)) fail('client.js factory returned no inject array');
  else {
    const unknown = half.inject.filter((entryName) => !KNOWN_CLIENT_SERVICES.has(entryName));
    if (unknown.length) fail(`client injects client services this app does not provide: ${unknown.join(', ')}`);
    else if (half.inject.length === 0) fail('client inject is empty although the client half is active');
    else ok(`client inject ${half.inject.join(', ')}`);
  }

  const dicts = half?.dictionaries;
  if (!dicts || !dicts.zh || !dicts.en) fail('client.js exposes no zh/en dictionaries');
  else {
    const zhKeys = Object.keys(dicts.zh);
    const enKeys = Object.keys(dicts.en);
    const missingEn = zhKeys.filter((key) => !(key in dicts.en));
    const missingZh = enKeys.filter((key) => !(key in dicts.zh));
    if (missingEn.length) fail(`dictionaries: en misses ${missingEn.join(', ')}`);
    else if (missingZh.length) fail(`dictionaries: zh misses ${missingZh.join(', ')}`);
    else {
      const used = new Set([...clientSource.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]));
      const unknownKeys = [...used].filter((key) => !(key in dicts.zh));
      if (unknownKeys.length) fail(`client.js uses missing locale keys: ${unknownKeys.join(', ')}`);
      else ok(`dictionaries zh/en ${zhKeys.length} keys, all ${used.size} used keys present`);
    }
  }

  /** apply() must survive a primitives miss instead of throwing inside the slot. */
  const warned = [];
  try {
    half.apply({
      get: () => undefined,
      effect: () => () => {},
      slots: { inject: () => () => {}, register: () => () => {} },
      locale: { register: () => () => {} },
      logger: { warn: (line) => warned.push(line), info: () => {} },
    });
    if (warned.length === 0) fail('apply() stayed silent although uiWorkspace/workspaces and the primitives were missing');
    else ok('apply() degrades to a warning when primitives/services are missing');
  } catch (error) {
    fail(`apply() threw without primitives: ${error.message}`);
  }
  /** S5: the sidebar stylesheet must stay gated and target only the bucket row. */
  if (typeof half?.ungroupedCss !== 'function') fail('client.js exports no ungroupedCss(); S5 stylesheet missing');
  else {
    const css = half.ungroupedCss();
    const attribute = half.FLATTEN_ATTRIBUTE;
    if (typeof attribute !== 'string' || attribute === '') fail('client.js exports no flatten attribute name');
    else if (!css.includes(`html[${attribute}]`)) fail(`ungroupedCss() is not gated on html[${attribute}]`);
    else if (!css.includes('data-chat-sessions-owned')) fail('ungroupedCss() does not target the receipt rows');
    else if (css.includes('bucket-empty')) fail('ungroupedCss() must not hide the 「未分组」 header');
    else if (!/data-chat-sessions-after-cluster/.test(css)) fail('ungroupedCss() must draw the cluster/bucket divider');
    else ok(`ungroupedCss() gates the cluster + bucket rules behind html[${attribute}]`);
  }
  if (!clientSource.includes('/chat-sessions/config')) fail('client.js never reads /chat-sessions/config; the flatten switch would be dead');
  else ok('client.js reads the flatten switch from /chat-sessions/config');
     /** S5c: the divider must live on the stable cluster container, not a virtualized workspace row. */
   if (!clientSource.includes("const CLUSTER_DIVIDER_ATTRIBUTE = 'data-chat-sessions-cluster-divider'")) {
     fail('the client must declare a stable cluster divider marker');
   } else if (!clientSource.includes('[${CLUSTER_DIVIDER_ATTRIBUTE}]::before')) {
     fail('the stable cluster divider must be drawn by the container pseudo-element');
   } else if (!clientSource.includes('container.setAttribute(CLUSTER_DIVIDER_ATTRIBUTE')) {
     fail('the marker must be attached to the stable cluster container');
   } else if (!clientSource.includes('if (unknown || pinChanged) state.request?.()')) {
     fail('an unknown workspace row must trigger an immediate id refresh');
   } else if (!clientSource.includes('if (pending !== 0) return;')) {
     fail('the refresh hook must be throttled');
   } else {
     ok('the cluster divider uses a stable container marker and follows stale id refreshes');
    }

   /**
   * Legacy room-rank diagnostics. Actual per-session activity ordering is
   * exercised by check-header.mjs and the real-browser activity fixture.
   */
  if (!hostSource.includes("ctx.workspaceRegistry.pinnedSessionIds")) {
    fail('status must read the registry pin set, or a pinned standalone room cannot be ranked');
  } else if (!hostSource.includes('pinned: indexes.length > 0')
    || !hostSource.includes('pinIndex: indexes.length > 0 ? Math.min(...indexes) : null')
    || !hostSource.includes('updatedAt: sessionIds.reduce(')) {
    fail('status must publish pinned/pinIndex/updatedAt per workspace (the client ranks on them)');
  } else if (!hostSource.includes('pinOrder.set(sessionId, index)')) {
    fail('the cluster must rank pinned rooms by the registry pin order (newest pin first), not by activity');
  } else if (!clientSource.includes("const PIN_ATTRIBUTE = 'data-chat-sessions-rank'")) {
    fail('the client must stamp a rank attribute on receipt groups');
  } else if (!clientSource.includes('order:100') || !clientSource.includes('PINNED_RANKS.map(')) {
    fail('pinned receipt groups must override the cluster order (1..n) against the default 100');
  } else if (!clientSource.includes('const leftPin = leftRoom?.pinIndex ?? Number.MAX_SAFE_INTEGER')
    || !clientSource.includes('if (leftPin !== rightPin) return leftPin - rightPin')
    || !clientSource.includes('return (rightRoom?.updatedAt ?? 0) - (leftRoom?.updatedAt ?? 0)')) {
    fail('several pinned rooms must be ranked by pin order, with latest activity only as the tiebreak');
  } else if (!clientSource.includes('receiptWorkspaces(chatRoot)')) {
    fail('the marker pass must be fed by the pin-aware status fetch');
  } else {
    ok('legacy pinned-room diagnostics retain registry ranks; actual rows sort by activity');
  }

  /** Round 4d: a pin/unpin must re-rank immediately, not after the poll interval. */
  if (!clientSource.includes('const PIN_INDICATOR ='))
    fail('the marker pass must watch the native pin indicator');
  else if (!clientSource.includes('if (seen !== undefined && seen !== pinnedNow) pinChanged = true;')) {
    fail('a changed pin indicator must request a refresh on that pass');
  } else {
    ok('a pin/unpin re-ranks on the next observer pass, not on the next poll');
  }

  /** Round 4c: the rank must be readable from a node with an accessibility handle, not only the group. */
  if (!clientSource.includes('\'[data-row-key^="session:"]\'')) {
    fail('the pin rank must be mirrored onto the session rows so a verifier can read it');
  } else if (!clientSource.includes('row.setAttribute(PIN_ATTRIBUTE, next)')) {
    fail('the pin rank must also be mirrored onto the (hidden) workspace row');
  } else if (!/\[\$\{GROUP_ATTRIBUTE\}\]\[\$\{PIN_ATTRIBUTE\}="\$\{rank\}"\]\{order:\$\{rank\}\}/.test(clientSource)) {
    fail('the `order` rule must stay scoped to the group, the row mirror is evidence only');
  } else {
    ok('pin rank is mirrored onto rows, `order` stays scoped to the group');
  }

  /** Membership diagnostics and the motion kill switch remain available during reconciliation. */
  if (!clientSource.includes('const sameBlocks = keysNow === lastBlockKeys;')) {
    fail('the glide must record cluster membership changes');
  } else if (!clientSource.includes("blocks=${sameBlocks ? 'same' : 'changed'}")) {
    fail('the glide diagnostic must say whether the block set changed');
  } else if (!clientSource.includes('glideEnabled = config.glide !== false;')) {
    fail('the glide needs a config kill switch');
  } else if (!hostSource.includes('glide: config?.glide !== false,')) {
    fail('the host half must publish the glide switch');
  } else {
    ok('the glide records membership changes and can be switched off by config');
  }

  /**
   * Reordering the cluster by CSS `order` needs the block container to become a flex *column* —
   * and a flex column shrinks its children by default once the content is taller than the scroll
   * box, which made the whole workspace strip compress upward whenever a group was added. The
   * container is therefore marked, and its children are pinned to `flex: 0 0 auto`.
   */
  if (!clientSource.includes("const CONTAINER_ATTRIBUTE = 'data-chat-sessions-container';")) {
    fail('the block container must be marked so the stylesheet can size it');
  } else if (!clientSource.includes('[${CONTAINER_ATTRIBUTE}] > *{flex:0 0 auto!important}')) {
    fail('flex children of the block container must not shrink');
  } else if (clientSource.includes(':has(> [${GROUP_ATTRIBUTE}]){display:flex')) {
    fail('the unmarked :has() flex override must be gone');
  } else if (!clientSource.includes('const containers = new Set();')
    || !clientSource.includes('const firstContainer = ownedGroups[0]?.group.parentElement ?? null;')) {
    // One "first parent" guess is not enough: the shipped list wraps the rooms in more than one box,
    // and a missed wrapper leaves that row's `order` inert while everything else looks right.
    fail('every parent that directly holds a flattened cluster group must be located from the cluster itself');
  } else {
    ok('container is a flex column whose children cannot shrink');
  }

  /**
   * Every `*_ATTRIBUTE` a template literal interpolates must actually be declared. A misspelt or
   * missing constant is not a type error — it throws `ReferenceError` at runtime and silently
   * aborts the rest of the pass, which is how "the animation disappeared" and "the pin order did
   * nothing" shipped together: the throw happened after the ranks were written, so everything
   * looked half-right.
   */
  /**
   * The other half of the same failure mode: a *local* that was renamed or deleted while a later
   * line still reads it. `node --check` passes, the module loads, and the pass throws on the first
   * run — after the early writes, so half the feature looks fine.
   */
  {
    const locals = new Set([...clientSource.matchAll(/^\s*(?:const|let) ([a-z][A-Za-z0-9_]*) =/gm)].map((m) => m[1]));
    const suspicious = ['container', 'blockOf', 'nativeMoving']
      .filter((name) => clientSource.includes(`${name}.`) && !locals.has(name)
        && !clientSource.includes(`const ${name}`) && !clientSource.includes(`let ${name}`));
    if (suspicious.length > 0) {
      fail(`client.js reads removed locals: ${suspicious.join(', ')}`);
    } else {
      ok('no dangling reference to a removed local');
    }
  }

  {
    const declared = new Set(
      [...clientSource.matchAll(/^\s*const ([A-Z][A-Z0-9_]*_ATTRIBUTE) =/gm)].map((m) => m[1]),
    );
    const used = new Set([...clientSource.matchAll(/\$\{([A-Z][A-Z0-9_]*_ATTRIBUTE)\}/g)].map((m) => m[1]));
    const missing = [...used].filter((name) => !declared.has(name));
    if (missing.length > 0) {
      fail(`client.js references undeclared constants: ${missing.join(', ')}`);
    } else {
      ok('every ${*_ATTRIBUTE} interpolation has a declaration');
    }
  }

  /**
   * The shipped hover preview anchors on a box; a cluster row's room box is `display:contents`, so
   * the card measured 0x0 and parked itself in the window corner. The card must be re-anchored on
   * the row, and only when the native code got it wrong.
   */
  if (!clientSource.includes("root.matches('[class*=\"hoverContent\"]')")) {
    fail('blank and named session previews must share content-based detection without a copy label');
  } else if (!clientSource.includes('nextHoverFrame(() => placeCard(node));')) {
    fail('the re-anchor must run after the shipped layout effect, or it is overwritten');
  } else if (!clientSource.includes("attributeFilter: ['style', 'class']")) {
    fail('the re-anchor must observe native position rewrites on reused cards');
  } else if (!clientSource.includes("getComputedStyle(card).position !== 'fixed'")) {
    fail('only the floating preview may be re-anchored');
  } else {
    ok('the shipped hover preview is re-anchored on the hovered cluster row');
  }

  /**
   * A changed `client.js` needs a full app restart, and half the bug reports were against the old
   * bundle. Stamping the live build on <html> makes that distinguishable in one attribute.
   */
  if (!clientSource.includes("const BUILD_ATTRIBUTE = 'data-chat-sessions-build';")) {
    fail('the client must expose which build is live');
  } else if (!hostSource.includes("export const PLUGIN_BUILD = 'chip-icon-2026-11-04-keyboard-actions';")) {
    fail('the build id must be bumped with the behaviour change');
  } else if (!hostSource.includes('build: PLUGIN_BUILD,')) {
    fail('GET /chat-sessions/config must publish the build id');
  } else if (!clientSource.includes('document.documentElement.setAttribute(BUILD_ATTRIBUTE, buildTag);')) {
    fail('the client must stamp the host build id, not a second copy of it');
  } else if (!clientSource.includes('build: buildTag,')) {
    fail('diagnostics samples must carry the same build id');
  } else {
    ok('one build id: host publishes it, client stamps and reports it');
  }

  /**
   * R19 and R22 also need state changes that the UI only exposes behind hover-only row menus:
   * pinning a session and deleting a workspace. Both routes must go through the very same registry
   * calls the menus use, or a scripted run would prove something the UI never does.
   */
  if (!hostSource.includes("url.pathname === `${ROUTE_PREFIX}/pin`")) {
    fail('the host must offer a scriptable pin route for R19');
  } else if (!hostSource.includes('await ctx.workspaceRegistry.pinSession(sessionId);')) {
    fail('pin must call the same registry call the inline menu does');
  } else if (!hostSource.includes('await ctx.workspaceRegistry.unpinSession(sessionId);')) {
    fail('unpin must call the same registry call the inline menu does');
  } else if (!hostSource.includes('pinOrder: [...pinOrder.entries()]')) {
    fail('the pin route must report the resulting order so a test can assert it');
  } else if (!hostSource.includes('ok: applied > 0,')) {
    fail('pin must report ok on the effect: a room that also holds an archived sibling still pins (report F1-adjacent)');
  } else {
    ok('POST /chat-sessions/pin pins through the registry and reports the order');
  }

  /**
   * Orphans are every session no workspace claims — including the ones still living in a real
   * workspace directory whose workspace was just deleted (report R22). Counting only the cwds under
   * `.sessions/` froze `orphans` at its old value and made the orphan row unreadable (report F2/F3).
   */
  if (!hostSource.includes('const orphanSessions = [];')) {
    fail('status must list orphan rows, not only count them (report F3)');
  } else if (!hostSource.includes('const claimed = new Set();') || !hostSource.includes('if (claimed.has(sessionId)) continue;')) {
    fail('orphans must be counted over every durable session, not only the ones inside .sessions/ (report F2)');
  } else if (!hostSource.includes('orphanSessionsTruncated')) {
    fail('the orphan row list must say when it was capped');
  } else {
    ok('status counts orphans over every durable session and lists the rows (F2/F3)');
  }

  /**
   * The window has to be addressable. Rounds 5-2 and 5-3 both missed a freshly orphaned row because
   * a busy home filled the 200-row cap with older orphans first (report F3 BLOCKED), so the rows are
   * ordered newest-first and the caller can narrow or widen the window explicitly.
   */
  if (!hostSource.includes("orphanCandidates.sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0))")) {
    fail('orphan rows must be ordered newest-first so a fresh orphan lands inside the cap (report F3)');
  } else if (!hostSource.includes("url.searchParams.get('orphanSession')")) {
    fail('status must accept ?orphanSession=<id> so one orphan row can be read exactly (report F3)');
  } else if (!hostSource.includes("rawAll === 'all'") || !hostSource.includes('orphanLimit must be an integer between 1 and 5000')) {
    fail('status must accept ?orphans=all and reject an out-of-range ?orphanLimit (report F3)');
  } else if (!hostSource.includes('orphanSessionsLimit:') || !hostSource.includes('orphanSessionsFilter:')) {
    fail('status must echo the window it applied, so a narrow read cannot be mistaken for a count');
  } else {
    ok('status windows the orphan rows newest-first and accepts orphanLimit / orphans=all / orphanSession');
  }

  if (!hostSource.includes("url.pathname === `${ROUTE_PREFIX}/workspaces/delete`")) {
    fail('the host must offer a scriptable workspace deletion route for R22');
  } else if (!hostSource.includes('await ctx.workspaceRegistry.delete(target.id)')) {
    fail('deleting must call the same registry call the row menu does');
  } else if (!hostSource.includes('orphans: await orphanCount(),')) {
    fail('the delete route must report how many sessions just became orphans');
  } else {
    ok('POST /chat-sessions/workspaces/delete deletes through the registry and reports orphans');
  }

  /**
   * R22 needs a workspace whose deletion orphans its sessions, but the sidebar's "add workspace"
   * opens a native directory picker that automation cannot drive. The route below mirrors the same
   * validation and the same registry call so the case can be scripted.
   */
  if (!hostSource.includes("url.pathname === `${ROUTE_PREFIX}/workspaces`")) {
    fail('the host must offer a scriptable workspace creation route for R22');
  } else if (!hostSource.includes('ctx.workspaceRegistry.create(resolved, title)')) {
    fail('the route must go through the same registry call the picker uses');
  } else if (!hostSource.includes("error: `path is not a directory: ${resolved}`")) {
    fail('the route must validate the path like the picker does');
  } else {
    ok('POST /chat-sessions/workspaces creates a workspace the same way the picker does');
  }

  /**
   * Tree mode (`按工作区树`) nests a standalone room under its path ancestor — `~/.dsh/chats/.sessions/…`
   * lives inside the `.dsh` workspace — so the row would look exactly like a project session. The
   * fix is a visual cue only: the host publishes `treeBadge`/`nestedUnder`, the client marks nested
   * owned blocks and the stylesheet dims the session rows. No structure, text or ordering changes.
   */
  if (!hostSource.includes('export function treeBadgeOf(config)')) {
    fail('the host must expose the tree badge mode');
  } else if (!hostSource.includes('treeBadge: treeBadgeOf(config),')) {
    fail('/chat-sessions/config must publish the tree badge mode');
  } else if (!hostSource.includes('nestedUnder,')) {
    fail('status must report which workspace a room is nested under');
  } else if (!clientSource.includes("const TREE_BADGE_ATTRIBUTE = 'data-chat-sessions-tree-badge';")) {
    fail('the client must mark nested standalone blocks');
  } else if (!clientSource.includes("const depthPx = Number.parseInt(group.style.getPropertyValue('--dsh-workspace-indent') ?? '', 10);")) {
    fail('nesting must be read from the tree indent, not from the room path');
  } else if (!clientSource.includes("const BADGE_ELEMENT_ATTRIBUTE = 'data-chat-sessions-badge';")) {
    fail('the row glyph must be identifiable in the DOM');
  } else if (!clientSource.includes("badge.setAttribute('aria-hidden', 'true');")) {
    fail('the glyph must not change the row accessible name');
  } else if (!clientSource.includes('sessionRow.prepend(badge);')) {
    fail('the glyph must precede the title');
  } else if (!clientSource.includes('[${TREE_BADGE_ATTRIBUTE}="tint"] [data-row-key^="session:"]{opacity:.65!important}')) {
    fail('the legacy tint mode must stay scoped to non-archived standalone rows');
  } else {
    ok('tree mode dims nested standalone rows (visual only, `treeBadge` switchable)');
  }

  /**
   * The desktop window is a `dsh-app://` page with no debugging port, so a page-only measurement
   * can never be read from outside. The client therefore posts samples to the host half.
   */
  if (!clientSource.includes("void fetch('/chat-sessions/diagnostics'")) {
    fail('the client must be able to ship measurements to the host');
  } else if (!hostSource.includes("url.pathname === `${ROUTE_PREFIX}/diagnostics`")) {
    fail('the host must expose the diagnostics route');
  } else if (!clientSource.includes("kind: sameBlocks ? 'reorder' : 'membership'") && !clientSource.includes("reportDiagnostics(sameBlocks ? 'reorder' : 'membership')")) {
    fail('the client must report whether the block set changed');
  } else {
    ok('page measurements are shipped to the host (`/chat-sessions/diagnostics`)');
  }

  /**
   * The group reorder is pure CSS `order`, and the "a new room appears above the divider" frame is
   * fixed by the inverted polarity, not by killing scroll anchoring. Disabling the anchor also
   * removed the browser's own compensation when a row is inserted inside a group, which read as a
   * drop-in from the divider — so anchoring must stay at the browser default.
   */
  if (clientSource.includes('overflow-anchor:none')) {
    fail('scroll anchoring must stay at the browser default (see the order polarity rule)');
  } else {
    ok('scroll anchoring is left at the browser default');
  }

  /**
   * S9: in '单列表' (flat) the shipped list renders no workspace rows, so the only honest adaptation
   * is to leave its pin/recency order untouched and publish which rows are standalone sessions.
   */
  if (!clientSource.includes("const FLAT_ATTRIBUTE = 'data-chat-sessions-flat';")) {
    fail('the client must name the flat-list marker');
  } else if (!clientSource.includes("const STANDALONE_ATTRIBUTE = 'data-chat-sessions-standalone';")) {
    fail('standalone rows must be marked in flat mode');
  } else if (!clientSource.includes("document.querySelector('[data-row-key^=\"workspace:\"]') === null && sessionRows.length > 0")) {
    fail('flat mode must be detected without relying on the localised header label');
  } else if (!clientSource.includes('row.toggleAttribute(STANDALONE_ATTRIBUTE, isStandalone);')) {
    fail('flat mode must mark exactly the standalone session rows');
  } else if (!clientSource.includes("if (cwd.startsWith(prefix) || cwd.includes('/.sessions/')) standaloneIds.add(session.sessionId);")) {
    fail('the host status must map sessions onto receipt workspaces');
  } else {
    ok('S9: flat list leaves the shipped order alone and marks standalone rows');
  }

  /**
   * The synthetic "no workspace" bucket now carries real orphans (delete a workspace that still
   * has sessions). Hiding its header unconditionally would erase the only label that tells the
   * user those sessions lost their home, so the header is hidden only while the bucket is empty.
   */
  if (clientSource.includes("const EMPTY_BUCKET_ATTRIBUTE = 'data-chat-sessions-bucket-empty';")) {
    fail('the 「未分组」 header must never be hidden — the tree only renders it when it has rows');
  } else if (!clientSource.includes('const bucketHadRows = new WeakSet();')) {
    fail('a collapsed-but-populated bucket must be remembered');
  } else if (!clientSource.includes("const ORPHAN_BUCKET_ATTRIBUTE = 'data-chat-sessions-orphan-bucket';")
    || !clientSource.includes("`${gate} [${ORPHAN_BUCKET_ATTRIBUTE}]{order:110!important}`,")
    || !clientSource.includes("if (key === '') {")) {
    fail('the orphan bucket must keep the shipped last slot and stay out of the cluster/divider bookkeeping');
  } else {
    ok('orphaned sessions keep the native 「未分组」 header (bucket hidden only when empty)');
  }

  /**
   * The 「未分组」 block is neither a workspace nor cluster material: it keeps the shipped last slot
   * and must never become the anchor the cluster divider rides on.
   */
  if (!clientSource.includes("const ORPHAN_BUCKET_ATTRIBUTE = 'data-chat-sessions-orphan-bucket';")) {
    fail('the orphan-bucket marker must be named');
  } else if (!clientSource.includes("`${gate} [${ORPHAN_BUCKET_ATTRIBUTE}]{order:110!important}`,")) {
    fail('the orphan bucket must be ordered below the standalone cluster');
  } else if (!clientSource.includes("if (key === '') {") || !clientSource.includes('bucketGroup.removeAttribute(FOREIGN_ATTRIBUTE);')) {
    fail('the orphan bucket must be kept out of the cluster/divider bookkeeping');
  } else {
    ok('the 「未分组」 bucket stays last and never anchors the cluster divider');
  }

  /**
   * A hidden row reports `rect.top === 0` forever; measuring one (instead of the first *visible*
   * workspace row) made the first motion journal look frozen while the defect was live.
   */
  if (!clientSource.includes('const visibleWorkspaceRows = () =>')) {
    fail('measurements must skip hidden rows');
  } else if (!clientSource.includes("if (row.hasAttribute(OWNED_ROW_ATTRIBUTE)) continue;")) {
    fail('hidden receipt rows must be skipped by the sampler');
  } else if (!clientSource.includes('kind: `burst:${burstKind}`')) {
    fail('a membership change must record a tagged per-frame burst');
  } else {
    ok('samplers read visible rows only and record a per-frame burst');
  }

  /**
   * Round 6: a pinned *chat* must outrank another room's chat, not just its own siblings.
   *
   * A room can hold several chats (a fork inherits its parent's directory) and the shipped list
   * renders them as sibling rows inside the group box, so ranking the box ranked all of its chats:
   * a freshly pinned chat dragged its unpinned sibling above an older pin from another room.
   */
  if (!hostSource.includes('pinOrder: [...pinOrder.entries()]')) {
    fail('status must report the pin order per session (a room can hold several chats)');
  } else if (!clientSource.includes("const pinRanks = new Map();") || !clientSource.includes('payload?.pinOrder')) {
    fail('the client must read the per-session pin order from status');
  } else if (!clientSource.includes('const pinIndex = effectivePinRanks.get(sessionId)') || !clientSource.includes('session.querySelector(PIN_INDICATOR) !== null')) {
    fail('a chat row must use its current native pin indicator and per-session pin rank');
  } else if (!clientSource.includes("group.style.display = 'contents'")) {
    fail('the cluster group box must be flattened so a chat row can outrank another room');
  } else if (!clientSource.includes("child.style.display = 'contents'")) {
    fail('the shipped row wrapper inside a group must be flattened too, or row order is inert');
  } else if (!clientSource.includes('const nestedInAnotherGroup = group.parentElement !== null') || !clientSource.includes("group.style.removeProperty('display')")) {
    // 「按工作区树」 renders the receipt inside its path ancestor: flattening there would collapse
    // the shipped indentation into one level, so only the top-level cluster may be flattened.
    fail('a tree-nested group must keep its box (only the top-level cluster is flattened)');
  } else if (!clientSource.includes("const order = blank ? '2' : pinIndex !== undefined ? String(3 + pinIndex)") || !clientSource.includes('ordinaryOrders.get(sessionId)') || !clientSource.includes('session.style.order = order') || !clientSource.includes('node.style.order = order')) {
    fail('a visible blank must precede pins, with the same order on its flex wrapper');
  } else {
    ok('a pinned chat is ranked by its own session and rises past another room (multi-chat rooms)');
  }

  /** Round 4b: the pin reorder must glide like the shipped list, not teleport. */
  if (!clientSource.includes('const GLIDE_MS = 200')) {
    fail('the reorder glide must use the shipped duration (200 ms)');
  } else if (!clientSource.includes("easing: 'ease-out'")) {
    fail('the reorder glide must use the shipped easing (ease-out)');
  } else if (!clientSource.includes('prefers-reduced-motion: reduce')) {
    fail('the reorder glide must respect prefers-reduced-motion');
  } else if (!clientSource.includes('armGlide') || !clientSource.includes("addEventListener('pointerdown', armGlide")) {
    fail('motion must be armed by the first pointer/key input, like the shipped AnimatedRows');
  } else if (!clientSource.includes('const moved = previous - rowTop(row)')) {
    fail('the glide must translate from the last painted offset delta (FLIP)');
  } else if (!clientSource.includes('node = node.offsetParent;')) {
    // Room-level ordering moves whole boxes, so a row's `offsetTop` never changes: the baseline has
    // to be absolute.
    fail('the glide baseline must be absolute (sum the offsetParent chain), not row offsetTop');
  } else if (!clientSource.includes('const rowTop = (row) => {')) {
    // A flattened group (`display:contents`) has no box: the baseline has to come from its first
    // chat row, and the glide has to run on the rows, or `offsetTop` is 0 for every block.
    fail('the glide baseline must come from the block first chat row (groups are display:contents)');
  } else if (!clientSource.includes("lastTops = new Map(movable.map((row) => [row.getAttribute('data-row-key'), rowTop(row)]));")) {
    fail('the glide must re-baseline after every pass');
  } else if (!clientSource.includes('|| row.closest(`[${GROUP_ATTRIBUTE}]`) !== null)')) {
    fail('glide must include every chat of a receipt room, not only flattened ones');
  } else if (!clientSource.includes('[data-row-key^="session:"], [${CLUSTER_HEADER_ATTRIBUTE}][data-row-key]')) {
    fail('the glide must baseline individual chat rows and the cluster header');
  } else if (clientSource.includes('const nativeMoving')) {
    fail('the glide must not bail out on a document-wide animation scan; it de-animates per block (report F1)');
  } else if ((clientSource.match(/(^|\n)\s*lastTops = new Map\(\);/g) ?? []).length !== 1) {
    // Exactly one legitimate wipe remains: entering single-list (flat) rendering, where blocks do
    // not exist at all. A second one means the glide pass is clearing its own baseline again.
    fail('the glide must keep its baseline on passes that skip animating, or glided stays 0 forever (report F1)');
  } else if (clientSource.indexOf('lastTops = new Map(movable.map') < clientSource.indexOf('const nativeInside')) {
    fail('the glide must keep its baseline on passes that skip animating, or glided stays 0 forever (report F1)');
  } else if (!clientSource.includes('const nativeInside') || !clientSource.includes('const rowMotions = new Map();')) {
    fail('the glide must track owned animations separately from native transforms');
  } else if (!hostSource.includes('export function glideMotion(config)') || !hostSource.includes('glideMotion: glideMotion(config),')) {
    fail('the host must publish the glideMotion override so the reorder animation is testable on a reduce-motion machine');
  } else if (!clientSource.includes("const motionAllowed = glideMotionMode === 'force'")) {
    fail('the client must honour glideMotion force/off instead of only prefers-reduced-motion');
  } else {
    ok('pinning a standalone room glides to the head instead of teleporting');
  }

  /** S5b: the seeded first turn is empty, so its badge must be hidden by attributes. */
  if (typeof half?.emptyTurnCss !== 'function') fail('client.js exports no emptyTurnCss(); the seeded empty-turn badge would show');
  else {
    const css = half.emptyTurnCss();
    const attribute = half.EMPTY_TURN_ATTRIBUTE;
    if (typeof attribute !== 'string' || attribute === '') fail('client.js exports no empty-turn attribute name');
    else if (!css.includes(`html[${attribute}]`)) fail(`emptyTurnCss() is not gated on html[${attribute}]`);
    else if (!css.includes('data-turn-process-messages="0"')) fail('emptyTurnCss() does not pin the empty-turn message count');
    else if (!css.includes('data-turn-process-tool-calls="0"') || !css.includes('data-turn-process-subagents="0"')) fail('emptyTurnCss() must pin tool-call and subagent counts to 0 as well');
    else if (!/display:\s*none\s*!important/.test(css)) fail('emptyTurnCss() does not hide the badge with !important');
    else ok(`emptyTurnCss() hides only the empty-turn badge behind html[${attribute}]`);
  }

} catch (error) {
  fail(`client.js cannot be loaded: ${error.message}`);
}

/** local module imports stay honest ---------------------------------------- */
{
  // A name used but forgotten in the import list only blows up at runtime (ReferenceError inside
  // a catch-all), which is exactly how a stale `dropSessionLink` slipped through once.
  const source = readFileSync(join(root, 'index.js'), 'utf8');
  const imported = new Set();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/(?:links|gc)\.js'/gu)) {
    for (const name of match[1].split(',')) imported.add(name.trim());
  }
  const localExports = new Set();
  for (const file of ['links.js', 'gc.js']) {
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/^export (?:async )?function (\w+)/gmu)) {
      localExports.add(match[1]);
    }
  }
  const used = [...localExports].filter((name) => new RegExp(`(?<![\\w.])${name}\\(`, 'u').test(source));
  const missing = used.filter((name) => !imported.has(name));
  if (missing.length > 0) fail(`index.js uses ${missing.join(', ')} without importing it`);
  else ok(`index.js imports every links/gc helper it calls (${used.length})`);
}

/** links.js: room-keyed title symlink layer (S6) --------------------------- */
try {
  const {
    slugify, linkTarget, ensureRoomLink, archiveRoomLink, restoreRoomLink, dropRoomLink,
    findRoomLink, findArchivedRoomLink, tidyLinks, ARCHIVE_DIRECTORY, LINKS_FILE,
  } = await import(pathToFileURL(join(root, 'links.js')).href);
  const slugCases = [
    ['每周复盘 / 2024:Q3 *草稿*', '每周复盘-2024-Q3-草稿'],
    ['  a   b  ', 'a-b'],
    ['---', ''],
    ['', ''],
  ];
  const wrong = slugCases.filter(([input, expected]) => slugify(input) !== expected);
  if (wrong.length > 0) fail(`slugify mismatch: ${JSON.stringify(wrong)}`);
  else ok('links.js slugify keeps CJK, drops illegal chars, trims dashes');
  const long = slugify('标'.repeat(200));
  if ([...long].length > 60 || Buffer.byteLength(long, 'utf8') > 200) fail('slugify does not cap length');
  else ok(`slugify caps at 60 code points (got ${[...long].length})`);

  /** Every link inside `dir` whose target is `target`. */
  const linksTo = (dir, target) => readdirSync(dir).filter((name) => {
    try {
      return readlinkSync(join(dir, name)) === target;
    } catch {
      return false;
    }
  });

  const sandbox = mkdtempSync(join(tmpdir(), 'chat-sessions-links-'));
  try {
    // --- one room, one name -------------------------------------------------
    const targetA = linkTarget('session-a');
    const first = await ensureRoomLink({ root: sandbox, target: targetA, slug: '周报', owner: true });
    const again = await ensureRoomLink({ root: sandbox, target: targetA, slug: '周报', owner: true });
    const renamed = await ensureRoomLink({ root: sandbox, target: targetA, slug: '周报 2', owner: true });
    const other = await ensureRoomLink({ root: sandbox, target: linkTarget('session-b'), slug: '周报', owner: true });
    const names = linksTo(sandbox, targetA);
    const relative = readlinkSync(join(sandbox, '周报-2')) === targetA;
    if (first.status !== 'created' || again.status !== 'unchanged') {
      fail(`ensureRoomLink is not idempotent: ${JSON.stringify([first, again])}`);
    } else if (renamed.status !== 'renamed' || renamed.name !== '周报-2') {
      fail(`owner rename did not land: ${JSON.stringify(renamed)}`);
    } else if (names.length !== 1 || existsSync(join(sandbox, '周报'))) {
      fail(`one room must keep exactly one name, got ${JSON.stringify(names)}`);
    } else if (other.name !== '周报' || !relative) {
      fail(`a second room must take the freed name while the target stays relative: ${JSON.stringify(other)}`);
    } else if (await findRoomLink(sandbox, targetA) !== '周报-2') {
      fail('findRoomLink does not resolve the current room name');
    } else {
      ok('links.js keeps one name per room: create/rename/reuse, relative targets');
    }

    // --- a sibling that inherited the cwd never renames the room ------------
    const sharedTarget = linkTarget('session-shared');
    const sib1 = await ensureRoomLink({ root: sandbox, target: sharedTarget, slug: '共享', owner: false });
    const sib2 = await ensureRoomLink({ root: sandbox, target: sharedTarget, slug: '别的名字', owner: false });
    const sib3 = await ensureRoomLink({ root: sandbox, target: sharedTarget, slug: '房主改名', owner: true });
    const sharedNames = linksTo(sandbox, sharedTarget);
    if (sib2.status !== 'unchanged' || sib2.name !== '共享') {
      fail(`a non-owner must adopt, not rename: ${JSON.stringify(sib2)}`);
    } else if (sib3.status !== 'renamed' || sib3.name !== '房主改名') {
      fail(`the room owner must be able to rename: ${JSON.stringify(sib3)}`);
    } else if (sharedNames.length !== 1 || sib1.status !== 'created') {
      fail(`shared room must keep exactly one name, got ${JSON.stringify(sharedNames)}`);
    } else {
      ok('links.js gives a shared directory one name and lets only the owner rename it');
    }

    // --- archive round trip keeps the name ----------------------------------
    const archiveDir = join(sandbox, ARCHIVE_DIRECTORY);
    const moved = await archiveRoomLink({ root: sandbox, target: targetA, slug: '周报' });
    const movedTwice = await archiveRoomLink({ root: sandbox, target: targetA, slug: '周报' });
    if (moved.status !== 'archived' || moved.to !== '周报-2') {
      fail(`archiveRoomLink did not keep the current name: ${JSON.stringify(moved)}`);
    } else if (movedTwice.status !== 'unchanged') {
      fail(`archiveRoomLink is not idempotent: ${JSON.stringify(movedTwice)}`);
    } else if (readlinkSync(join(archiveDir, '周报-2')) !== `../${targetA}` || linksTo(sandbox, targetA).length !== 0) {
      fail('archiveRoomLink left the top-level name behind or broke the target');
    } else {
      ok(`links.js moves the room name into ${ARCHIVE_DIRECTORY}/ on archive (idempotent, relative)`);
    }

    const back = await restoreRoomLink({ root: sandbox, target: targetA });
    const backAgain = await restoreRoomLink({ root: sandbox, target: targetA });
    if (back.status !== 'restored' || back.to !== '周报-2') {
      fail(`restoreRoomLink did not bring the name back: ${JSON.stringify(back)}`);
    } else if (backAgain.reason !== 'not-archived') {
      fail(`restoreRoomLink must be a no-op once the archive is empty: ${JSON.stringify(backAgain)}`);
    } else {
      ok('links.js restores the archived name on unarchive, so a round trip never renames');
    }

    // --- a room that never had a name gets one inside the archive -----------
    const orphan = await archiveRoomLink({ root: sandbox, target: linkTarget('session-c'), slug: '周报' });
    if (orphan.status !== 'archived' || orphan.to === null
      || readlinkSync(join(archiveDir, orphan.to)) !== `../${linkTarget('session-c')}`) {
      fail(`archiveRoomLink must name an untitled room inside the archive: ${JSON.stringify(orphan)}`);
    } else {
      ok(`links.js archives a room that never had a link directly inside ${ARCHIVE_DIRECTORY}/`);
    }

    // --- dropping a room forgets its name and its record -------------------
    const dropped = await dropRoomLink({ root: sandbox, target: sharedTarget });
    const rooms = JSON.parse(readFileSync(join(sandbox, LINKS_FILE), 'utf8'));
    if (dropped !== '房主改名' || linksTo(sandbox, sharedTarget).length !== 0) {
      fail(`dropRoomLink must remove the room name: ${JSON.stringify(dropped)}`);
    } else if (rooms?.version !== 2 || Object.hasOwn(rooms.rooms ?? {}, sharedTarget)) {
      fail(`dropRoomLink must forget the room record: ${JSON.stringify(rooms)}`);
    } else {
      ok('links.js forgets a reclaimed room (name gone, record pruned)');
    }

    // --- legacy v1 records are ignored, disk wins --------------------------
    writeFileSync(join(sandbox, LINKS_FILE), `${JSON.stringify({ version: 1, claims: { 'session-a': '幽灵' } })}\n`);
    const afterLegacy = await ensureRoomLink({ root: sandbox, target: targetA, slug: '周报', owner: true });
    if (afterLegacy.name !== '周报-2') {
      fail(`a v1 record must not override the disk: ${JSON.stringify(afterLegacy)}`);
    } else {
      ok('links.js ignores v1 per-session claims and re-derives rooms from disk');
    }

    // --- tidy cleans what older builds left, then reports nothing ----------
    const tidy = mkdtempSync(join(tmpdir(), 'chat-sessions-tidy-'));
    try {
      mkdirSync(join(tidy, ARCHIVE_DIRECTORY), { recursive: true });
      const room = linkTarget('session-twin');
      symlinkSync(room, join(tidy, '甲'));
      symlinkSync(room, join(tidy, '乙'));
      symlinkSync(room, join(tidy, ARCHIVE_DIRECTORY, '丙'));
      const dry = await tidyLinks({ root: tidy });
      const before = readdirSync(tidy).filter((name) => !name.startsWith('.')).sort();
      if (dry.groups.length !== 1 || before.length !== 2) {
        fail(`tidy must report but not touch by default: ${JSON.stringify(dry.groups)}, ${before}`);
      } else {
        const applied = await tidyLinks({ root: tidy, apply: true });
        const after = readdirSync(tidy).filter((name) => !name.startsWith('.')).sort();
        const archived = readdirSync(join(tidy, ARCHIVE_DIRECTORY));
        const againReport = await tidyLinks({ root: tidy });
        if (applied.removed.length !== 1 || after.length !== 1) {
          fail(`tidy did not remove the duplicate: ${JSON.stringify(applied.removed)}, ${after}`);
        } else if (!archived.includes('丙')) {
          fail('tidy must not touch the single name inside .archive');
        } else if (againReport.groups.length !== 0) {
          fail(`tidy must report an empty group list afterwards: ${JSON.stringify(againReport.groups)}`);
        } else {
          ok('links.js tidy keeps one name per room, then reports groups: []');
        }
      }
    } finally {
      rmSync(tidy, { recursive: true, force: true });
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
} catch (error) {
  fail(`links.js cannot be exercised: ${error.message}`);
}

/** JS syntax --------------------------------------------------------------- */
/** gc.js: archive-first empty-session reclamation (S7) ------------------- */
try {
  const { decide, idleSince, isSessionDirName, reclaimEmptyDir, IDLE_MS } = await import(pathToFileURL(join(root, 'gc.js')).href);
  const cases = [
    [{ userMessages: 0, assistantMessages: 0, running: false, archived: false, idleMs: IDLE_MS }, 'archive', 'idle empty session'],
    [{ userMessages: 0, assistantMessages: 0, running: false, archived: false, idleMs: IDLE_MS - 1 }, 'keep', 'young empty session'],
    [{ userMessages: 0, assistantMessages: 0, running: true, archived: false, idleMs: IDLE_MS * 10 }, 'keep', 'running session'],
    [{ userMessages: 0, assistantMessages: 0, running: false, archived: true, idleMs: IDLE_MS * 10 }, 'keep', 'already archived'],
    [{ userMessages: 2, assistantMessages: 2, running: false, archived: true, idleMs: IDLE_MS * 10 }, 'keep', 'a manual archive is never undone'],
    [{ userMessages: 2, assistantMessages: 2, running: false, archived: false, idleMs: IDLE_MS * 10 }, 'keep', 'live conversation'],
    [{ userMessages: 0, assistantMessages: 1, running: false, archived: false, idleMs: IDLE_MS * 10 }, 'keep', 'reply without a prompt'],
    [{ userMessages: 0, assistantMessages: 0, running: false, archived: false, idleMs: IDLE_MS * 10 }, 'archive', 'renamed but never used'],
  ];
  const wrongCases = cases.filter(([input, expected]) => decide(input) !== expected).map(([input, expected]) => `${JSON.stringify(input)} → ${decide(input)} (want ${expected})`);
  if (wrongCases.length > 0) fail(`gc.decide() wrong: ${wrongCases.join('; ')}`);
  else ok('gc.decide() archives only message-free sessions and never undoes a manual archive');

  if (idleSince(undefined) !== Number.POSITIVE_INFINITY) fail('gc.idleSince() must treat a missing timestamp as infinite idleness');
  else ok('gc.idleSince() treats a missing timestamp as infinite idleness');

  if (!isSessionDirName('session-077936f9-4d5f-4791-a02c-3b22f409e911')) fail('gc.isSessionDirName() rejects a real session id');
  else if (isSessionDirName('../etc') || isSessionDirName('session-xyz') || isSessionDirName('session-077936f9-4d5f-4791-a02c-3b22f409e91')) fail('gc.isSessionDirName() accepts a foreign name');
  else ok('gc.isSessionDirName() only accepts session-<uuid>');

  const sandbox = mkdtempSync(join(tmpdir(), 'chat-sessions-gc-'));
  try {
    const empty = join(sandbox, 'empty'); mkdirSync(empty);
    const dirty = join(sandbox, 'dirty'); mkdirSync(dirty); writeFileSync(join(dirty, 'keep.txt'), 'x');
    const droppings = join(sandbox, 'droppings'); mkdirSync(droppings); writeFileSync(join(droppings, '.DS_Store'), 'x');
    const missing = join(sandbox, 'missing');
    const results = [
      await reclaimEmptyDir(empty),
      await reclaimEmptyDir(dirty),
      await reclaimEmptyDir(droppings),
      await reclaimEmptyDir(missing),
    ];
    const dirStates = [existsSync(empty), existsSync(dirty), existsSync(droppings), existsSync(missing)];
    if (JSON.stringify(results) !== '[true,false,true,false]') fail(`gc.reclaimEmptyDir() wrong: ${JSON.stringify(results)}`);
    else if (JSON.stringify(dirStates) !== '[false,true,false,false]') fail(`gc.reclaimEmptyDir() left the wrong dirs: ${JSON.stringify(dirStates)}`);
    else if (!existsSync(join(dirty, 'keep.txt'))) fail('gc.reclaimEmptyDir() deleted a non-empty directory');
    else ok('gc.reclaimEmptyDir() removes only empty cwds (.DS_Store tolerated, files kept)');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
} catch (error) {
  fail(`gc.js cannot be exercised: ${error.message}`);
}

{
  const source = readFileSync(join(root, 'client.js'), 'utf8');
  const okChip =
    source.includes("const CHIP_ATTRIBUTE = 'data-chat-sessions-chip';") &&
    source.includes("const CHIP_BADGE_ATTRIBUTE = 'data-chat-sessions-chip-badge';") &&
    source.includes('const paintChipBadge = (isStandaloneChip) => {') &&
    source.includes('chip.prepend(badge);') &&
    source.includes("document.documentElement.setAttribute(CHIP_ATTRIBUTE, 'standalone');") &&
    source.includes('>svg:first-of-type{display:none!important}') &&
    source.includes('paintChipBadge(untitled !== undefined && chipLabel.trim() === untitled);') &&
    !source.includes('icon: jsx(IconNewChat, { size: 16 }),');
  if (okChip) ok('hero chip and picker row render the same standalone glyph');
  else fail('hero chip and picker row must render the same standalone glyph');
}

for (const file of ['index.js', 'client.js', 'links.js', 'gc.js', 'check.mjs']) {
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
    ok(`${file} syntax`);
  } catch (error) {
    fail(`${file} syntax: ${String(error.stderr ?? error.message).trim().split('\n')[0]}`);
  }
}

/** report ------------------------------------------------------------------ */
for (const line of notes) console.log(line);
if (failures.length) {
  console.error('\nFAILED:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`\nchat-sessions OK — ${notes.length} checks passed. Install with plugin_manager install_bundle.`);
