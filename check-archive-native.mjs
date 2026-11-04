// Opt-in suite: exercises the installed native workspace projection.
// Run with: DSH_NATIVE_WORKSPACE_CLIENT=/path/to/@deepseek-ai/dsh-client-ui-workspace/lib/client.js npm run test:native
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { fixture, clientApi, rowIds } from './test-support/archive-fixture.mjs';

const nativePath = process.env.DSH_NATIVE_WORKSPACE_CLIENT;
if (!nativePath) {
  console.error(`DSH_NATIVE_WORKSPACE_CLIENT is not set.

This suite checks the projection rules of an installed DeepSeek Harness, so it needs that
installation's client bundle. Point the variable at
  @deepseek-ai/dsh-client-ui-workspace/lib/client.js
inside the installed DSH, for example:
  /Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js

This command therefore only runs on a machine with DSH installed. The default suites
(npm run check, npm test) do not need it.`);
  process.exit(1);
}

// Exercise the installed native projection, rather than reimplementing its blank/archive rule.
// A version change that removes a named function deliberately fails this compatibility test.
let nativeSource;
try {
  nativeSource = await readFile(nativePath, 'utf8');
} catch (error) {
  console.error(`Cannot read the native workspace client at ${nativePath}\n${error.message}`);
  process.exit(1);
}
function nativeFunction(name) {
  const start = nativeSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `native ${name} must exist`);
  const end = nativeSource.indexOf('\n\t\t}', start);
  return nativeSource.slice(start, end + 5);
}
const native = vm.runInNewContext(`(() => {
  ${['sessionVisible','buildGroup','groupByWorkspace','sectionMembers','sessionTitle','visiblePendingKind','runningChildCount','sessionNode','deriveGroups'].map(nativeFunction).join('\n')}
  const mainSessionId = list => Object.values(list.byId).find(s => (s.retainedBy.mainView ?? 0) > 0)?.id;
  const owningGroupKey = (workspaces, id) => workspaces.find(w => w.sessionIds.includes(id))?.workspaceId;
  return { deriveGroups, sessionVisible };
})()`);
function projectedGroups(api, list, workspace, filter) {
  // Baseline switch-19 has no adapter. Keep its real identity projection for RED.
  const project = api.projectArchivedBlanks ?? (value => value);
  return native.deriveGroups(project(list, workspace), workspace.items,
    { archivedSessionIds: workspace.archivedSessionIds, pinnedSessionIds: [], archivedFilter: filter }, new Map(),
    { expandedGroups: workspace.items.map(w => w.workspaceId), ungroupedOrder: [] });
}

test('B2-F001: auto-archived noncurrent blank survives reload and native single restore without changing data', async () => {
  const f = await fixture();
  try {
    const a = await f.add(21, { message: false });
    const current = await f.add(22, { message: false });
    const hidden = await f.add(23, { message: false });
    const file = join(a.directory, 'B2-F001.txt');
    await writeFile(file, 'B2-F001 durable contents\n');
    const hash = async () => createHash('sha256').update(await readFile(file)).digest('hex');
    const beforeHash = await hash(), beforeLog = JSON.stringify(f.events.get(a.id));
    f.snapshots.find(s => s.header.id === a.id).header.createdAt = Date.now() - 200_000;
    f.events.get(a.id).forEach(e => e.time = Date.now() - 200_000);
    const storedLog = JSON.stringify(f.events.get(a.id));
    await f.request(); // Maintenance chooses archive; no direct archive mutation for a.
    assert.ok(f.archived.has(a.id), 'maintenance actually archived the blank');
    const workspaceId = f.workspaces.find(w => w.sessionIds.includes(a.id)).id;
    const state = () => ({
      list: { projectionsBySession: {}, ids: f.snapshots.map(s => s.header.id), byId: Object.fromEntries(f.snapshots.map(s => [s.header.id,
        { id: s.header.id, cwd: s.header.cwd, blank: true, retainedBy: s.header.id === current.id ? { mainView: 1 } : {}, running: false, updatedAt: s.header.createdAt }])) },
      workspace: { items: f.workspaces.map(w => ({ workspaceId: w.id, path: w.path, sessionIds: [...w.sessionIds], createdAt: new Date().toISOString() })), archivedSessionIds: [...f.archived] },
    });
    let api = await clientApi(), live = state();
    assert.ok(rowIds(projectedGroups(api, live.list, live.workspace, 'only')).includes(a.id), 'archived-only must discover the noncurrent blank');
    assert.ok(!rowIds(projectedGroups(api, live.list, live.workspace, 'default')).includes(hidden.id), 'ordinary noncurrent blank stays hidden');
    await writeFile(join(f.root, 'reload-state.json'), JSON.stringify(live));
    await f.restart(); // New plugin closure, and a fresh client factory reading a serialized snapshot.
    live = JSON.parse(await readFile(join(f.root, 'reload-state.json'), 'utf8')); api = await clientApi();
    assert.ok(rowIds(projectedGroups(api, live.list, live.workspace, 'only')).includes(a.id));
    assert.ok(rowIds(projectedGroups(api, live.list, live.workspace, 'show')).includes(a.id));
    await f.registry.unarchiveSession(a.id); // The same public per-session operation the native menu uses.
    live = state();
    assert.ok(!rowIds(projectedGroups(api, live.list, live.workspace, 'only')).includes(a.id));
    assert.ok(!rowIds(projectedGroups(api, live.list, live.workspace, 'default')).includes(a.id), 'restored noncurrent blank follows native visibility');
    live.list.byId[current.id].retainedBy = {}; live.list.byId[a.id].retainedBy = { mainView: 1 };
    assert.ok(rowIds(projectedGroups(api, live.list, live.workspace, 'default')).includes(a.id), 'selecting restored blank reveals it normally');
    assert.equal(f.workspaces.find(w => w.sessionIds.includes(a.id)).id, workspaceId);
    assert.equal(f.snapshots.find(s => s.header.id === a.id).header.cwd, a.directory);
    assert.equal(await hash(), beforeHash); assert.equal(JSON.stringify(f.events.get(a.id)), storedLog);
    assert.ok(beforeLog.includes('Room-21')); assert.equal(live.list.byId[a.id].blank, true, 'projection never changes canonical summary');
  } finally { await f.close(); }
});

test('B2-F001: ordinary blanks and manual/shared-room summaries keep native visibility', async () => {
  const api = await clientApi();
  const cwd = '/fixture/.sessions/session-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const byId = {
    archivedBlank: { id: 'archivedBlank', cwd, blank: true },
    hidden: { id: 'hidden', cwd, blank: true },
    current: { id: 'current', cwd, blank: true },
    manual: { id: 'manual', cwd, blank: false },
    shared: { id: 'shared', cwd, blank: false },
    regular: { id: 'regular', cwd: '/regular', blank: true },
    subagent: { id: 'subagent', cwd, blank: true, origin: 'subagent' },
    mismatch: { id: 'mismatch', cwd: '/elsewhere', blank: true },
  };
  const list = { ids: Object.keys(byId), byId };
  const workspace = { archivedSessionIds: ['archivedBlank', 'manual', 'regular', 'subagent', 'mismatch'], items: [
    { path: cwd, sessionIds: list.ids.filter(id => id !== 'regular') }, { path: '/regular', sessionIds: ['regular'] },
  ] };
  const projected = api.projectArchivedBlanks(list, workspace);
  assert.notEqual(projected, list); assert.notEqual(projected.byId.archivedBlank, byId.archivedBlank);
  for (const id of list.ids.filter(id => id !== 'archivedBlank')) assert.equal(projected.byId[id], byId[id], `${id} unchanged`);
  const archived = new Set(workspace.archivedSessionIds);
  assert.equal(native.sessionVisible(projected.byId.archivedBlank, 'current', archived, 'only'), true);
  assert.equal(native.sessionVisible(projected.byId.manual, 'current', archived, 'only'), true);
  assert.equal(native.sessionVisible(projected.byId.hidden, 'current', archived, 'default'), false);
  assert.equal(native.sessionVisible(projected.byId.current, 'current', archived, 'default'), true);
  assert.equal(native.sessionVisible(projected.byId.shared, 'current', archived, 'default'), true);
  assert.equal(byId.archivedBlank.blank, true);
});
