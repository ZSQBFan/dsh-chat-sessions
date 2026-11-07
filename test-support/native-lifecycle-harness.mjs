#!/usr/bin/env node
// 真宿主 L2 harness：在隔离 DSH_HOME + 隔离 profile 里装本仓库，走原生 plugin manager 停用/启用。
//
// 由 `check-lifecycle-native.mjs` 用 Electron 的 node 模式启动（app 二进制 + ELECTRON_RUN_AS_NODE），
// 因为宿主代码在 app.asar 里，只有 app 自带的 node 能 import。
//
// 环境变量：
//   LC_NATIVE_HOME  隔离 DSH_HOME（必需，必须为空目录或全新目录）
//   LC_NATIVE_PORT  端口（默认 62311）
//   LC_PLUGIN_DIR   被安装的插件目录（默认本仓库根）
//   LC_DSH_MODULES  宿主模块根（.../app.asar/dsh/node_modules/@deepseek-ai/）
//   LC_FROM_DEFAULT 首次建 profile 时设 1
//
// 输出：一行 `@@NATIVE@@ {json}`，随后进程退出 0；断言失败时打印 `@@NATIVE_FAIL@@`。
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

const HOME = process.env.LC_NATIVE_HOME;
const MODULES = process.env.LC_DSH_MODULES;
if (!HOME || !MODULES) {
  console.error('@@NATIVE_FAIL@@ 需要 LC_NATIVE_HOME 与 LC_DSH_MODULES');
  process.exit(2);
}
const PORT = process.env.LC_NATIVE_PORT ?? '62311';
const PLUGIN_DIR = process.env.LC_PLUGIN_DIR ?? process.cwd();
process.env.DSH_HOME = HOME;
process.env.DSH_AGENTS_HOME = path.join(HOME, 'agents');
process.env.DSH_TELEMETRY_DISABLED = '1';

const steps = [];
const note = (name, detail) => steps.push({name, at: new Date().toISOString(), ...detail});

// 捕获 web 打印的 `?token=`，后面访问插件路由要带 cookie。
let token = null;
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const text = typeof chunk === 'string' ? chunk : String(chunk);
  const match = /\?token=([A-Za-z0-9_-]+)/u.exec(text);
  if (match !== null && token === null) token = match[1];
  return originalWrite(chunk, ...rest);
};

const {runProfile} = await import(MODULES + 'dsh/lib/profile-boot.js');
const {loadLayeredEnv} = await import(MODULES + 'dsh-app-boot/lib/index.js');

const bootOptions = {
  environment: loadLayeredEnv('dsh'),
  profile: 'lc-native',
  // patchFiles 必需是数组：宿主内部对它直接 flatMap。
  patchFiles: process.env.LC_PATCH === undefined ? [] : [process.env.LC_PATCH],
  args: ['--port', PORT, '--no-open'],
};
if (process.env.LC_FROM_DEFAULT === '1') bootOptions.fromDefaultProfile = 'web';
const {ctx, shutdown} = await runProfile(bootOptions);
note('boot', {port: PORT, token: token !== null});

const manager = ctx.get('pluginManager');
const registry = ctx.get('workspaceRegistry');
const controller = ctx.get('sessionController');
const persistence = ctx.get('sessionPersistence');

// 安装（同路径重复安装返回 already-installed，不当失败）。
try {
  const installed = await manager.installBundle(PLUGIN_DIR);
  note('install', {application: installed?.application ?? null, changed: installed?.changed ?? null});
} catch (error) {
  note('install-error', {message: String(error?.message ?? error)});
}

async function pluginRow() {
  const rows = await manager.listPlugins();
  return rows.find((row) => String(row.moduleName ?? '').includes('dsh-chat-sessions'));
}

async function cookieJar() {
  const response = await fetch(`http://127.0.0.1:${PORT}/?token=${token}`, {redirect: 'manual'});
  const cookies = response.headers.getSetCookie?.() ?? [];
  return cookies.map((entry) => entry.split(';')[0]).join('; ');
}

async function api(pathname, options = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    ...options,
    headers: {'content-type': 'application/json', cookie: await cookieJar(), ...(options.headers ?? {})},
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = {raw: text.slice(0, 400)}; }
  return {status: response.status, body};
}

async function ledger() {
  const base = path.join(HOME, 'storages', 'dsh-chat-sessions-lifecycle');
  const {readdir} = await import('node:fs/promises');
  const scopes = await readdir(base).catch(() => []);
  for (const scope of scopes) {
    const text = await readFile(path.join(base, scope, 'ledger.json'), 'utf8').catch(() => null);
    if (text !== null) return JSON.parse(text);
  }
  return null;
}

const result = {ok: false, checks: [], steps, evidence: {}};
function check(name, condition, detail) {
  result.checks.push({name, pass: condition === true, detail});
  if (condition !== true) result.ok = false;
}

try {
  const row = await pluginRow();
  check('plugin-installed', row !== undefined && row.enabled === true, {row});
  if (row === undefined) throw new Error('plugin row missing after install');

  const created = await api('/chat-sessions/create', {method: 'POST', body: '{}'});
  check('create-200', created.status === 200 && created.body.ok === true, created.body);
  const sessionId = created.body.sessionId;
  const cwd = created.body.cwd;
  const workspaceId = created.body.workspaceId;
  await writeFile(path.join(cwd, 'keep.txt'), 'native-user-data');
  await mkdir(path.join(cwd, 'nested'), {recursive: true});

  const statusCreated = await api('/chat-sessions/status');
  check('status-managed-set', Array.isArray(statusCreated.body.managedWorkspaceIds)
    && statusCreated.body.managedWorkspaceIds.includes(workspaceId), {
    managed: statusCreated.body.managedWorkspaceIds, state: statusCreated.body.lifecycle?.state});

  // 宿主规则：置顶与归档互斥（archiveSession 会把该会话从 pin 集合里摘掉），
  // 所以用两个房间分别承载「只置顶」与「只归档」，同时验证批量交接。
  const second = await api('/chat-sessions/create', {method: 'POST', body: '{}'});
  check('create-second-200', second.status === 200 && second.body.ok === true, second.body);
  const archivedId = sessionId;
  const archivedCwd = cwd;
  const archivedWorkspace = workspaceId;
  const pinnedId = second.body.sessionId;
  const pinnedCwd = second.body.cwd;
  const pinnedWorkspace = second.body.workspaceId;
  await writeFile(path.join(pinnedCwd, 'keep.txt'), 'native-user-data-2');
  await mkdir(path.join(pinnedCwd, 'nested'), {recursive: true});

  // 共享 cwd（房间 = 目录，R05）：同一房间挂第二条会话，交接必须把它一起算进去，
  // 而不是当成外来成员把整房间判成 CONFLICT（独立验收 F01 的真实场景）。
  const sharedId = `session-${randomUUID()}`;
  const controller = ctx.get('sessionController');
  await controller.create({sessionId: sharedId, workspaceId: archivedWorkspace});
  note('shared-session', {sharedId, workspaceId: archivedWorkspace});
  const sharedBefore = registry.list().find((entity) => entity.id === archivedWorkspace)?.sessionIds ?? [];
  check('shared-room-has-two-members', sharedBefore.includes(archivedId) && sharedBefore.includes(sharedId), {members: sharedBefore});

  let pinOutcome = null;
  try {
    await registry.pinSession(pinnedId);
    pinOutcome = {ok: true, pins: [...(registry.pinnedSessionIds ?? [])]};
  } catch (error) {
    pinOutcome = {ok: false, code: error?.code ?? String(error?.name ?? ''), message: String(error?.message ?? error)};
  }
  note('pin', pinOutcome);
  await registry.archiveSession(archivedId);
  const headerBefore = (await persistence.stat(archivedId))?.header ?? null;

  // ── 显式停用（原生管理器，不是脚本模拟） ──
  const disabled = await manager.setPluginEnabled(row.entryId, false);
  note('disable', {application: disabled?.application ?? null, changed: disabled?.changed ?? null});
  const afterDisable = registry.list().some((entity) => entity.id === archivedWorkspace || entity.id === pinnedWorkspace);
  const ledgerAfterDisable = await ledger();
  const states = (ledgerAfterDisable?.rooms ?? []).map((entry) => entry.state);
  check('disable-removes-registration', afterDisable === false, {stillThere: afterDisable});
  const archivedRoomAfterDisable = (ledgerAfterDisable?.rooms ?? []).find((entry) => entry.cwd === archivedCwd);
  check('disable-shared-room-detached', archivedRoomAfterDisable?.state === 'DETACHED',
    {state: archivedRoomAfterDisable?.state, error: archivedRoomAfterDisable?.lastError ?? null});
  check('disable-shared-room-keeps-both-members',
    Array.isArray(archivedRoomAfterDisable?.sessionIds)
      && archivedRoomAfterDisable.sessionIds.includes(archivedId)
      && archivedRoomAfterDisable.sessionIds.includes(sharedId),
    {sessionIds: archivedRoomAfterDisable?.sessionIds});
  check('disable-ledger-detached', states.length === 2 && states.every((entry) => entry === 'DETACHED'),
    {states, last: ledgerAfterDisable?.process?.lastDetach?.reason,
      error: ledgerAfterDisable?.process?.lastDetach?.reason});
  check('disable-dir-intact', await readFile(path.join(archivedCwd, 'keep.txt'), 'utf8') === 'native-user-data');
  check('disable-second-dir-intact', await readFile(path.join(pinnedCwd, 'keep.txt'), 'utf8') === 'native-user-data-2');
  const headerAfter = (await persistence.stat(archivedId))?.header ?? null;
  check('disable-session-header-kept', JSON.stringify(headerAfter) === JSON.stringify(headerBefore));
  // 不信插件、也不只信内存里的 registry：直接读原生落盘状态。
  const persisted = JSON.parse(await readFile(path.join(HOME, 'storages', 'workspace.json'), 'utf8'));
  check('disable-archive-persisted', (persisted?.global?.archivedSessionIds ?? []).includes(archivedId),
    {archived: persisted?.global?.archivedSessionIds});
  check('disable-pin-persisted', (persisted?.global?.pinnedSessionIds ?? []).includes(pinnedId),
    {pins: persisted?.global?.pinnedSessionIds});

  // ── 重新启用：只挂回仍未分组、身份匹配的会话 ──
  const enabled = await manager.setPluginEnabled(row.entryId, true);
  note('enable', {application: enabled?.application ?? null});
  // restore 在 apply 里异步跑，轮询到 READY。
  let restored = null;
  for (let i = 0; i < 40; i++) {
    const status = await api('/chat-sessions/status');
    if (status.body?.lifecycle?.state === 'READY') { restored = status.body; break; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  check('enable-restored-ready', restored !== null, {state: restored?.lifecycle?.state});
  const roomArchived = registry.list().find((entity) => entity.path === archivedCwd);
  const roomPinned = registry.list().find((entity) => entity.path === pinnedCwd);
  check('enable-registers-room', roomArchived !== undefined, {room: roomArchived?.id ?? null});
  check('enable-registers-second-room', roomPinned !== undefined, {room: roomPinned?.id ?? null});
  check('enable-attaches-session', roomArchived?.sessionIds?.includes(archivedId) === true, {members: roomArchived?.sessionIds});
  check('enable-restores-shared-member', roomArchived?.sessionIds?.includes(sharedId) === true,
    {members: roomArchived?.sessionIds, sharedId});
  check('enable-attaches-second-session', roomPinned?.sessionIds?.includes(pinnedId) === true, {members: roomPinned?.sessionIds});
  const ledgerAfterEnable = await ledger();
  const enabledStates = (ledgerAfterEnable?.rooms ?? []).map((entry) => entry.state);
  check('enable-ledger-managed', enabledStates.length === 2 && enabledStates.every((entry) => entry === 'MANAGED'),
    {states: enabledStates});

  // ── 普通 HMR 重载：Workspace ID 必须保持 ──
  const keptId = roomArchived?.id ?? null;
  const hmr = ctx.get('hmr');
  if (hmr !== undefined) {
    await hmr.runExclusive(() => hmr.reconcileProfile());
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const stillSame = registry.list().find((entity) => entity.path === archivedCwd);
  check('hmr-keeps-workspace-id', stillSame !== undefined && stillSame.id === keptId, {before: keptId, after: stillSame?.id});

  // ── 原生卸载（bundle remove）：可选阶段，`LC_NATIVE_REMOVE=1` 打开 ──
  // 宿主先 dispose 再 pnpm remove（plugin-manager removeBundle），所以插件在 dispose 时看到的是
  // 「bundle 仍安装但 enabled:false」，账本只能如实记 BUNDLE_DISABLE；能证明的是「确实交接了」。
  if (process.env.LC_NATIVE_REMOVE === '1') {
    const removal = await manager.removeBundle('dsh-chat-sessions');
    note('remove', {
      stage: removal?.stage ?? null,
      application: removal?.application ?? null,
      packageExit: removal?.packageResult?.exitCode ?? null,
    });
    check('remove-bundle-applied', removal?.application === 'applied', {application: removal?.application});
    const ledgerAfterRemove = await ledger();
    const removeStates = (ledgerAfterRemove?.rooms ?? []).map((entry) => entry.state);
    check('remove-bundle-detaches', removeStates.length === 2 && removeStates.every((entry) => entry === 'DETACHED'),
      {states: removeStates, last: ledgerAfterRemove?.process?.lastDetach?.reason});
    check('remove-bundle-keeps-directory',
      await readFile(path.join(archivedCwd, 'keep.txt'), 'utf8') === 'native-user-data');
    check('remove-bundle-keeps-second-directory',
      await readFile(path.join(pinnedCwd, 'keep.txt'), 'utf8') === 'native-user-data-2');
    const registryAfterRemove = registry.list();
    check('remove-bundle-clears-registration',
      registryAfterRemove.some((entity) => entity.path === archivedCwd || entity.path === pinnedCwd) === false,
      {paths: registryAfterRemove.map((entity) => entity.path)});
    const rowsAfterRemove = await manager.listPlugins();
    check('remove-bundle-plugin-gone',
      rowsAfterRemove.every((entry) => String(entry.moduleName ?? '').includes('dsh-chat-sessions') === false));
    result.evidence.removeLedger = {
      states: removeStates,
      lastDetach: ledgerAfterRemove?.process?.lastDetach ?? null,
    };
  }

  result.evidence = {archivedId, pinnedId, sharedId, archivedCwd, pinnedCwd, archivedWorkspace, pinnedWorkspace, keptId, ledgerAfterEnable: {
    revision: ledgerAfterEnable?.revision, rooms: (ledgerAfterEnable?.rooms ?? []).map((entry) => ({state: entry.state, workspaceId: entry.workspaceId})),
  }};
  result.ok = result.checks.every((entry) => entry.pass);
} catch (error) {
  result.error = String(error?.stack ?? error).slice(0, 2000);
  result.ok = false;
}

await appendFile(path.join(HOME, 'native-lifecycle.jsonl'), JSON.stringify({t: Date.now(), ...result}) + '\n');
originalWrite.call(process.stdout, `@@NATIVE@@ ${JSON.stringify(result)}\n`);
try { await shutdown?.shutdown?.(0); } catch {}
process.exit(result.ok ? 0 : 1);
