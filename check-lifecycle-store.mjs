/**
 * L1 测试：生命周期账本存储（契约 §8 的 8 项 + REVIEW-20261107 的 F05／F06／F08 回归）。
 *
 * 全部测试使用真实临时目录（mkdtemp），不 mock fs；每项都对应契约里一条可观察
 * 行为，实现被改坏时必须变红。F05 与 F08 需要故障注入：前者用真子进程 + 同步阻塞
 * 事件循环让租约过期，后者只在目录 FileHandle 上注入 sync 错误。
 *
 * 运行：node --test check-lifecycle-store.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ELIGIBILITY,
  INTENT_STATE,
  LEDGER_SCHEMA_VERSION,
  LedgerInvalidError,
  ROOM_STATE,
  classifyDirectory,
  classifyMember,
  roomTransition,
  scopeIdentity,
  summarizeRooms,
} from './lifecycle/model.js';
import { LedgerStore, LedgerWriteError, LockHeldError, ledgerDirectory } from './lifecycle/store.js';

const NOW = Date.UTC(2026, 10, 7, 0, 0, 0);
const LEDGER_SEGMENTS = ['storages', 'dsh-chat-sessions-lifecycle'];
const LEASE_WORKER_FLAG = '--lifecycle-lease-worker';
/** 持久化契约里的字面量：测试直接钉字符串，避免「常量改了测试跟着改」。 */
const MARKER_FILE = 'initialized.json';
const CODE_LOCK_LOST = 'LOCK_LOST';
const CODE_REVISION_CONFLICT = 'REVISION_CONFLICT';
const CODE_DURABILITY_UNKNOWN = 'LEDGER_DURABILITY_UNKNOWN';
const CODE_MISSING_AFTER_INIT = 'LEDGER_MISSING_AFTER_INIT';

// ── 子进程 worker（F05）：必须在注册测试之前分流 ─────────────────────────────
//
// `fork` 用同一个文件跑 worker；顶层 await 会挂住模块求值，所以下面的 test()
// 注册不会在 worker 里执行。
if (process.argv[2] === LEASE_WORKER_FLAG) {
  await runLeaseWorker(JSON.parse(process.argv[3]));
  process.exit(0);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 同步阻塞事件循环：心跳定时器完全停摆，租约必然过期（模拟活 writer 被挂起）。 */
function blockEventLoop(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function sendToParent(message) {
  await new Promise((resolve, reject) => {
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * F05 的旧 writer：持锁进入 mutator → 通知父进程 → 同步挂起超过租约 → 再提交。
 * 旧实现会直接覆盖接管者的提交；正确实现必须在提交前被 fencing 拒绝。
 */
async function runLeaseWorker(options) {
  const store = await LedgerStore.open(options);
  let report;
  try {
    await store.update(async (state) => {
      await sendToParent({ phase: 'locked' });
      blockEventLoop(options.blockMs);
      state.generation = 999; // 一旦落盘就是「旧事务覆盖新提交」
    });
    report = { phase: 'committed' };
  } catch (error) {
    report = { phase: 'rejected', code: error?.code ?? null, message: String(error?.message ?? error) };
  }
  await sendToParent(report);
}

/** 每个测试一个隔离的工作区：dshHome 与 canonicalRoot 都是真实目录。 */
async function makeWorkspace(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-'));
  t.after(async () => {
    // chmod 失败不阻塞清理：目录权限可能被测试本身改过。
    await chmod(base, 0o700).catch(() => {});
    await rm(base, { recursive: true, force: true });
  });
  const dshHome = join(base, 'home');
  const canonicalRoot = join(base, 'canonical-root');
  await mkdir(dshHome, { recursive: true });
  await mkdir(canonicalRoot, { recursive: true });
  return { base, dshHome, canonicalRoot };
}

function openStore(workspace, overrides = {}) {
  return LedgerStore.open({
    dshHome: workspace.dshHome,
    canonicalRoot: workspace.canonicalRoot,
    pluginId: 'chat-sessions',
    profileId: 'profile-a',
    now: NOW,
    ...overrides,
  });
}

/** 递归列出目录下所有普通文件，用于越界写检查。 */
async function listFiles(root) {
  const files = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(root);
  return files;
}

function makeRoom(overrides = {}) {
  const cwd = '/tmp/lifecycle-room';
  return {
    ownerSessionId: 'owner-session',
    cwd,
    canonicalCwd: cwd,
    directoryIdentity: { dev: '10', ino: '20' },
    workspaceId: 'workspace-own',
    state: ROOM_STATE.MANAGED,
    sessionIds: ['owner-session'],
    members: [{ sessionId: 'owner-session', eligibility: ELIGIBILITY.ELIGIBLE }],
    ...overrides,
  };
}

test('1. 首次 open 建目录，update 建立账本，revision 单调且重开可读', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);

  assert.equal(store.status, 'absent');
  assert.equal(await store.read(), null);
  const homeReal = await realpath(workspace.dshHome);
  assert.ok(store.path.startsWith(join(homeReal, ...LEDGER_SEGMENTS) + sep));
  assert.equal(store.path.endsWith(`${sep}ledger.json`), true);

  const first = await store.update((state) => {
    state.generation = 1;
  });
  assert.equal(first.revision, 1);
  const scopeId = store.path.split(sep).at(-2);
  assert.match(scopeId, /^[0-9a-f]{32}$/u);
  assert.equal(first.state.scopeId, scopeId);
  assert.equal(
    scopeIdentity({ pluginId: 'chat-sessions', profileId: 'profile-a', dshHome: workspace.dshHome, canonicalRoot: workspace.canonicalRoot }).length,
    32,
  );
  assert.equal(JSON.parse(await readFile(store.path, 'utf8')).revision, 1);

  const second = await store.update((state) => {
    state.generation = 2;
    return state;
  });
  assert.equal(second.revision, 2);

  const reopened = await openStore(workspace);
  assert.equal(reopened.status, 'ready');
  const reread = await reopened.read();
  assert.equal(reread.revision, 2);
  assert.equal(reread.generation, 2);
  assert.equal(reread.schemaVersion, LEDGER_SCHEMA_VERSION);

  const third = await reopened.update((state) => {
    state.generation = 3;
  });
  assert.equal(third.revision, 3);

  const scopes = await readdir(join(workspace.dshHome, ...LEDGER_SEGMENTS));
  assert.equal(scopes.length, 1);
});

test('2. 原子写：忽略残留 tmp-*，写入失败不破坏原文件', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);
  await store.update((state) => {
    state.generation = 1;
  });
  const directory = dirname(store.path);

  // 残留临时文件必须被忽略。
  const orphan = join(directory, 'ledger.json.tmp-orphan');
  await writeFile(orphan, '{"半成品": true}', 'utf8');
  const reopened = await openStore(workspace);
  assert.equal(reopened.status, 'ready');
  assert.equal((await reopened.read()).revision, 1);

  // (a) 锁都拿不到（目录不可写）：整次写入失败，原文件与内存状态不变。
  const before = await readFile(reopened.path);
  await chmod(directory, 0o500);
  try {
    await assert.rejects(
      reopened.update((state) => {
        state.generation = 99;
      }),
      (error) => error instanceof LedgerWriteError && error.code === 'LEDGER_WRITE_FAILED',
    );
    assert.ok((await readFile(reopened.path)).equals(before), '写入失败后原文件字节必须不变');
    assert.equal((await reopened.read()).generation, 1, '内存状态不得被失败的写入污染');
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.startsWith('ledger.json.tmp-')),
      ['ledger.json.tmp-orphan'],
    );
    assert.equal((await readdir(directory)).includes('lock.json'), false, '失败后不得留下活动锁');
  } finally {
    await chmod(directory, 0o700);
  }
  const afterPermission = await reopened.update((state) => {
    state.generation = 2;
  });
  assert.equal(afterPermission.revision, 2);

  // (b) 锁拿到、临时文件也写好，但 rename 目标被换成目录：必须回滚、清理并释放锁。
  const aside = join(directory, 'ledger.aside.json');
  const beforeSwap = await readFile(reopened.path);
  await assert.rejects(
    reopened.update(async (state) => {
      state.generation = 99;
      // 写盘前互换目标：原文件安全搬到 aside，rename 将因目标是目录而失败。
      await rename(reopened.path, aside);
      await mkdir(reopened.path);
    }),
    (error) => error instanceof LedgerWriteError && error.code === 'LEDGER_WRITE_FAILED',
  );
  assert.ok((await readFile(aside)).equals(beforeSwap), '原文件不得丢失或改写');
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.startsWith('ledger.json.tmp-') && name !== 'ledger.json.tmp-orphan'),
    [],
  );
  assert.equal((await readdir(directory)).includes('lock.json'), false, '失败后锁必须释放');
  assert.equal((await readdir(directory)).includes('ledger.json'), true, '失败时不得删除目标路径');

  // 还原现场后账本仍可用，revision 继续递增。
  await rm(reopened.path, { recursive: true, force: true });
  await rename(aside, reopened.path);
  await rm(orphan, { force: true });
  const resumed = await reopened.update((state) => {
    state.generation = 3;
  });
  assert.equal(resumed.revision, 3);
  assert.equal((await openStore(workspace)).status, 'ready');
});

test('3. 坏 JSON 与未知 schemaVersion → LEDGER_INVALID，原件与隔离副本都在', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);
  await store.update((state) => {
    state.generation = 5;
  });

  const corrupt = Buffer.from('{"schemaVersion":1,"revision":2,', 'utf8');
  await writeFile(store.path, corrupt);
  const quarantined = await openStore(workspace);

  assert.equal(quarantined.status, 'invalid');
  assert.equal(quarantined.diagnostics.length >= 1, true);
  assert.equal(quarantined.diagnostics[0].code, 'LEDGER_INVALID');
  await assert.rejects(quarantined.read(), (error) => error instanceof LedgerInvalidError && error.code === 'LEDGER_INVALID');
  await assert.rejects(
    quarantined.update((state) => state),
    (error) => error.code === 'LEDGER_INVALID',
  );
  assert.ok((await readFile(quarantined.path)).equals(corrupt), '原件不得被覆盖或删除');

  const quarantineDirectory = join(dirname(quarantined.path), 'quarantine');
  const copies = await readdir(quarantineDirectory);
  assert.equal(copies.length, 1);
  assert.ok((await readFile(join(quarantineDirectory, copies[0]))).equals(corrupt), '隔离副本必须与原字节一致');

  // 第二种坏法：schemaVersion 不认识。
  const other = await makeWorkspace(t);
  const otherStore = await openStore(other);
  const valid = await otherStore.update((state) => {
    state.generation = 1;
    return state;
  });
  await writeFile(otherStore.path, `${JSON.stringify({ ...valid.state, schemaVersion: 99 }, null, 2)}\n`, 'utf8');
  const rejected = await openStore(other);
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.diagnostics[0].code, 'LEDGER_INVALID');
  assert.equal((await readdir(join(dirname(rejected.path), 'quarantine'))).length, 1);
});

test('4. 锁：存活 pid 拒绝、死 pid/过期租约回收、并发更新不丢', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);
  await store.update((state) => {
    state.generation = 0;
  });
  const lockPath = join(dirname(store.path), 'lock.json');
  const lease = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

  // (a) 存活 pid（1 号进程）持锁：拒绝，并且不得删掉别人的锁。
  await writeFile(lockPath, JSON.stringify({ token: 'foreign', pid: 1, hostname: 'x', createdAt: lease(0), leaseExpiresAt: lease(60_000) }));
  await assert.rejects(
    store.update((state) => {
      state.generation = 1;
    }),
    (error) => error instanceof LockHeldError && error.code === 'LOCK_HELD',
  );
  assert.equal((await readFile(lockPath, 'utf8')).includes('foreign'), true, '不得删除或改写存活进程的锁');

  // (b) 死 pid：租约未过期也按契约回收，写入继续。
  await writeFile(lockPath, JSON.stringify({ token: 'dead', pid: 999_999, hostname: 'x', createdAt: lease(0), leaseExpiresAt: lease(60_000) }));
  const afterDead = await store.update((state) => {
    state.generation = 1;
  });
  assert.equal(afterDead.revision, 2);
  assert.equal((await readdir(dirname(store.path))).some((name) => name.startsWith('lock.stale-')), true);

  // (c) 存活 pid + 过期租约：仍拒绝回收；只有确认 owner 退出后才允许接管。
  await writeFile(lockPath, JSON.stringify({ token: 'expired', pid: 1, hostname: 'x', createdAt: lease(-120_000), leaseExpiresAt: lease(-60_000) }));
  await assert.rejects(
    store.update((state) => {
      state.generation = 2;
    }),
    (error) => error instanceof LockHeldError && error.code === 'LOCK_HELD',
  );
  await unlink(lockPath); // 测试夹具模拟 owner 已退出，下一次才可获取。
  const afterExpired = await store.update((state) => {
    state.generation = 2;
  });
  assert.equal(afterExpired.revision, 3);

  // (d) 同一 store 上并发：全部成功，revision 连续、generation 累加不丢。
  const concurrent = await Promise.all(
    Array.from({ length: 12 }, () => store.update((state) => {
      state.generation += 1;
    })),
  );
  assert.deepEqual(concurrent.map((entry) => entry.revision).sort((a, b) => a - b), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal((await store.read()).generation, 14);

  // (e) 两个实例：后写者必须重读前者的 revision，而不是覆盖。
  const second = await openStore(workspace);
  const fromSecond = await second.update((state) => {
    state.generation += 1;
  });
  assert.equal(fromSecond.revision, 16);
  assert.equal((await openStore(workspace)).status, 'ready');
});

test('5. scopeId 稳定、rootResolved:false 不误判迁移、跨 scope 账本报 SCOPE_MISMATCH', async (t) => {
  const workspace = await makeWorkspace(t);
  const identity = {
    pluginId: 'chat-sessions',
    profileId: 'profile-a',
    dshHome: workspace.dshHome,
    canonicalRoot: workspace.canonicalRoot,
  };
  const baseline = scopeIdentity(identity);
  assert.match(baseline, /^[0-9a-f]{32}$/u);
  assert.equal(scopeIdentity({ ...identity, dshHome: `${workspace.dshHome}${sep}.${sep}` }), baseline);
  assert.notEqual(scopeIdentity({ ...identity, profileId: 'profile-b' }), baseline);
  assert.notEqual(scopeIdentity({ ...identity, canonicalRoot: join(workspace.base, 'other') }), baseline);
  assert.notEqual(scopeIdentity({ ...identity, pluginId: 'other-plugin' }), baseline);

  const store = await openStore(workspace);
  await store.update((state) => {
    state.generation = 7;
  });

  // canonicalRoot 暂不存在：rootResolved=false，账本照常建立，重开不得判成迁移。
  const missingRoot = join(workspace.base, 'not-yet-there');
  const ghost = await openStore(workspace, { canonicalRoot: missingRoot });
  assert.equal(ghost.status, 'absent');
  assert.notEqual(ghost.path, store.path);
  const ghostWritten = await ghost.update((state) => {
    state.generation = 1;
  });
  assert.equal(ghostWritten.state.identity.rootResolved, false);
  const ghostReopened = await openStore(workspace, { canonicalRoot: missingRoot });
  assert.equal(ghostReopened.status, 'ready');
  assert.equal(ghostReopened.diagnostics.length, 0);
  assert.equal((await ghostReopened.read()).revision, 1);
  assert.equal(JSON.parse(await readFile(store.path, 'utf8')).generation, 7, '另一 scope 的账本不得被改动');

  // 身份不同 → 新目录、新空账本；不做隐式迁移。
  const otherScope = await openStore(workspace, { profileId: 'profile-b' });
  assert.notEqual(otherScope.path, store.path);
  assert.equal(otherScope.status, 'absent');

  // 把一个合法账本放进不属于它的 scope 目录：只能判 SCOPE_MISMATCH，不改写。
  await mkdir(dirname(otherScope.path), { recursive: true });
  const foreign = await readFile(ghost.path);
  await copyFile(ghost.path, otherScope.path);
  const crossed = await openStore(workspace, { profileId: 'profile-b' });
  assert.equal(crossed.status, 'invalid');
  assert.equal(crossed.diagnostics[0].code, 'SCOPE_MISMATCH');
  assert.ok(crossed.diagnostics[0].quarantinePath);
  assert.ok((await readFile(crossed.path)).equals(foreign));
  await assert.rejects(crossed.update((state) => state), (error) => error.code === 'LEDGER_INVALID');
});

test('5b. root symlink scope remains stable when the leaf appears after first open', async (t) => {
  const workspace = await makeWorkspace(t);
  const actualRoot = join(workspace.base, 'actual-root');
  const aliasParent = join(workspace.base, 'alias-root');
  await mkdir(actualRoot, {recursive: true});
  await symlink(actualRoot, aliasParent, 'dir');
  const configuredRoot = join(aliasParent, 'room');
  const first = await openStore(workspace, {canonicalRoot: configuredRoot});
  assert.equal(first.status, 'absent');
  const firstPath = first.path;
  await first.update((state) => { state.generation = 9; });
  assert.equal((await first.read()).identity.rootResolved, false);
  await mkdir(join(actualRoot, 'room'), {recursive: true});
  const reopened = await openStore(workspace, {canonicalRoot: configuredRoot});
  assert.equal(reopened.path, firstPath);
  assert.equal(reopened.status, 'ready');
  assert.equal((await reopened.read()).generation, 9);
});

test('6. classifyDirectory / classifyMember 分类表与房间计数', () => {
  const room = makeRoom();

  assert.equal(classifyDirectory(room, null), 'missing');
  assert.equal(classifyDirectory(room, { isDirectory: () => false }), 'not-directory');
  assert.equal(classifyDirectory(room, { isDirectory: () => true, dev: 10, ino: 20 }), 'ok');
  assert.equal(classifyDirectory(room, { isDirectory: () => true, dev: 10, ino: 21 }), 'identity-changed');
  assert.equal(classifyDirectory(makeRoom({ directoryIdentity: null }), { isDirectory: () => true, dev: 1, ino: 2 }), 'ok');

  const header = { cwd: room.canonicalCwd };
  assert.equal(classifyMember({ header: null, canonicalCwd: room.canonicalCwd }), ELIGIBILITY.MISSING_SESSION);
  assert.equal(classifyMember({ header, isSubagent: true, canonicalCwd: room.canonicalCwd }), ELIGIBILITY.CONFLICT);
  assert.equal(classifyMember({ header: { cwd: '/tmp/elsewhere' }, canonicalCwd: room.canonicalCwd }), ELIGIBILITY.CONFLICT);
  assert.equal(
    classifyMember({ header, claimedBy: 'workspace-other', room }),
    ELIGIBILITY.USER_OWNED,
  );
  assert.equal(classifyMember({ header, claimedBy: 'workspace-own', room }), ELIGIBILITY.ELIGIBLE);
  assert.equal(classifyMember({ header, room }), ELIGIBILITY.ELIGIBLE);
  assert.throws(() => classifyMember({ header }), TypeError);

  const moved = roomTransition(room, ROOM_STATE.DETACHING, {
    now: NOW,
    operation: { kind: 'DETACH', id: 'op-1', startedAt: new Date(NOW).toISOString() },
    error: { code: 'REGISTRY_DELETE_FAILED', at: new Date(NOW).toISOString() },
  });
  assert.equal(moved.state, ROOM_STATE.DETACHING);
  assert.equal(moved.lastError.code, 'REGISTRY_DELETE_FAILED');
  assert.equal(room.state, ROOM_STATE.MANAGED, 'roomTransition 不得改输入');
  const kept = roomTransition(moved, ROOM_STATE.DETACHED, { now: NOW });
  assert.equal(kept.lastError.code, 'REGISTRY_DELETE_FAILED', '迁移不得抹掉上一步错误');
  const cleared = roomTransition(kept, ROOM_STATE.MANAGED, { now: NOW, error: null });
  assert.equal(cleared.lastError, null);

  const summary = summarizeRooms([room, moved, kept, roomTransition(room, ROOM_STATE.RELEASED, { now: NOW })]);
  assert.equal(summary.total, 4);
  assert.equal(summary.managed, 1);
  assert.equal(summary.detaching, 1);
  assert.equal(summary.detached, 1);
  assert.equal(summary.released, 1);
});

test('7. creationIntents 往返、ABANDONED 收敛，房间随账本一起持久化', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);
  const intent = {
    id: 'intent-1',
    ownerSessionId: 'owner-session',
    cwd: workspace.canonicalRoot,
    state: INTENT_STATE.PENDING,
    at: new Date(NOW).toISOString(),
  };
  const room = makeRoom();

  await store.update((state) => {
    state.creationIntents.push(intent);
    state.rooms.push(room);
  });
  const reopened = await openStore(workspace);
  const loaded = await reopened.read();
  assert.deepEqual(loaded.creationIntents, [intent]);
  assert.equal(loaded.rooms[0].ownerSessionId, room.ownerSessionId);
  assert.deepEqual(summarizeRooms(loaded.rooms), {
    managed: 1, detaching: 0, detached: 0, restoring: 0, partial: 0, released: 0, conflict: 0, total: 1,
  });

  const abandoned = await reopened.update((state) => {
    state.creationIntents[0].state = INTENT_STATE.ABANDONED;
    state.rooms[0] = roomTransition(state.rooms[0], ROOM_STATE.PARTIAL, { now: NOW });
  });
  assert.equal(abandoned.state.creationIntents[0].state, 'ABANDONED');
  assert.equal((await openStore(workspace)).status, 'ready');
  assert.equal((await (await openStore(workspace)).read()).creationIntents[0].state, INTENT_STATE.ABANDONED);

  // 终态意图被清理后账本仍合法（收敛路径不留悬空 PENDING）。
  await reopened.update((state) => {
    state.creationIntents = state.creationIntents.filter((entry) => entry.state === INTENT_STATE.PENDING);
  });
  const settled = await (await openStore(workspace)).read();
  assert.deepEqual(settled.creationIntents, []);
  assert.equal(settled.rooms[0].state, ROOM_STATE.PARTIAL);

  // 非法意图必须在写盘前被拒绝，磁盘保持原样。
  const revisionBefore = settled.revision;
  await assert.rejects(
    reopened.update((state) => {
      state.creationIntents.push({ id: 'bad', ownerSessionId: 'x', cwd: 'relative/path', state: 'PENDING', at: new Date(NOW).toISOString() });
    }),
    (error) => error instanceof LedgerInvalidError,
  );
  assert.equal((await (await openStore(workspace)).read()).revision, revisionBefore);
});

test('8. 越界写检查：store 的所有文件都在自己的账本目录内', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);
  await store.update((state) => {
    state.generation = 1;
  });
  await store.update((state) => {
    state.generation = 2;
  });
  await store.snapshot();

  // 制造一次隔离，确保 quarantine 也纳入检查。
  await writeFile(store.path, 'not json at all', 'utf8');
  const broken = await openStore(workspace);
  assert.equal(broken.status, 'invalid');

  // scope 目录必须独立于 store.path 推断：否则「把 ledger.json 写到 scope 外」这类
  // 缺陷会被 dirname(store.path) 一起带偏，检查反而永远通过。
  const lifecycleHome = join(workspace.dshHome, ...LEDGER_SEGMENTS);
  const scopes = (await readdir(lifecycleHome, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{32}$/u.test(entry.name));
  assert.equal(scopes.length, 1);
  const ledgerRoot = join(lifecycleHome, scopes[0].name) + sep;
  const files = await listFiles(workspace.dshHome);
  assert.equal(files.length > 0, true);
  for (const file of files) {
    assert.ok(file.startsWith(ledgerRoot), `写到了账本目录之外: ${file}`);
  }
  assert.equal(files.some((file) => file.endsWith(`${sep}ledger.json`)), true);
  assert.equal(files.some((file) => file.includes(`${sep}quarantine${sep}`)), true);

  // 未参与账本的目录必须保持干净。
  assert.deepEqual(await readdir(workspace.canonicalRoot), []);
  assert.deepEqual((await readdir(workspace.base)).sort(), ['canonical-root', 'home']);

  // ledgerDirectory 的入参白名单本身就是防越界的第一道闸。
  assert.throws(() => ledgerDirectory({ dshHome: workspace.dshHome, scopeId: '../escape' }), TypeError);
  assert.throws(() => ledgerDirectory({ dshHome: 'relative/home', scopeId: 'a'.repeat(32) }), TypeError);
  assert.equal(ledgerDirectory({ dshHome: workspace.dshHome, scopeId: 'a'.repeat(32) }), join(workspace.dshHome, ...LEDGER_SEGMENTS, 'a'.repeat(32)));
});

// ── REVIEW-20261107 回归：F05／F06／F08 ─────────────────────────────────────

/** 目录 FileHandle.sync 故障注入：只影响目录句柄，普通文件仍走真实实现。 */
async function withDirectorySyncFault(workspace, code, run) {
  const probe = await open(join(workspace.base, `sync-probe-${code}`), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.sync;
  const counter = { injected: 0 };
  prototype.sync = async function patchedSync() {
    const info = await this.stat();
    if (info.isDirectory()) {
      counter.injected += 1;
      throw Object.assign(new Error(`injected directory fsync ${code}`), { code });
    }
    return original.call(this);
  };
  try {
    return { outcome: await run(), counter };
  } finally {
    prototype.sync = original;
    await probe.close().catch(() => {});
  }
}

test('9. F05 活 writer 租约过期后不得覆盖接管者的提交（心跳 + token/revision fencing）', async (t) => {
  const workspace = await makeWorkspace(t);
  // 三个时间必须同时成立，才能既有语义又有抗抖动余量：
  //   leaseMs > CI 上一次事件循环停顿的量级（共享 4 核 VM 上实测可达数百 ms），否则提交前的
  //            fencing 会把「调度抖动」误判成「租约过期」，测试随机红；
  //   bAttemptMs > leaseMs  → B 抢锁时 A 的租约确实已过期；
  //   bAttemptMs < blockMs  → B 抢锁时 A 仍存活在 mutator 里（反证活 writer 不被抢锁）。
  // 于是把 A 的阻塞时长放大到 3s、租约 800ms、B 在 1.5s 抢锁：抖动余量 700ms 起步。
  // 可用 DCS_LEASE_MS 覆盖租约，上限由 bAttemptMs 决定。
  const blockMs = 3_000;
  const bAttemptMs = 1_500;
  const leaseMs = Math.min(Number(process.env.DCS_LEASE_MS ?? 800), bAttemptMs - 200);
  const store = await openStore(workspace, { leaseMs });
  assert.equal((await store.update((state) => {
    state.generation = 0;
  })).revision, 1);

  // A：真子进程，mutator 里同步挂起 blockMs，心跳停摆 → 租约必然过期。
  const child = fork(fileURLToPath(import.meta.url), [
    LEASE_WORKER_FLAG,
    JSON.stringify({
      dshHome: workspace.dshHome,
      canonicalRoot: workspace.canonicalRoot,
      pluginId: 'chat-sessions',
      profileId: 'profile-a',
      leaseMs,
      blockMs,
    }),
  ], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const [locked] = await once(child, 'message');
  assert.equal(locked.phase, 'locked', 'worker 必须先在持锁状态下进入 mutator');
  // 立刻挂上第二个监听：worker 恢复后的报告绝不能因为父进程还在 await 而丢失。
  const reportPromise = once(child, 'message');

  // B：旧 writer 仍存活（即便租约已过期）时也不得抢锁；这与 dsh-chat 的保守 owner-lock 语义一致。
  await delay(bAttemptMs);
  const b = await openStore(workspace, { leaseMs });
  await assert.rejects(
    b.update((state) => {
      state.generation += 10;
    }),
    (error) => error instanceof LockHeldError && error.code === 'LOCK_HELD',
  );

  // A 恢复：提交前 fencing 必须拒绝，而不是把旧草稿写上去。
  const [report] = await reportPromise;
  await once(child, 'exit');
  assert.equal(report.phase, 'rejected', '旧事务不得提交成功');
  assert.equal(report.code, CODE_LOCK_LOST);

  // 旧 owner 结束后，新的 writer 才可以接管并提交。
  const bWrite = await b.update((state) => {
    state.generation += 10;
  });
  assert.equal(bWrite.revision, 2);
  assert.equal(bWrite.state.generation, 10);
  const resumed = await store.update((state) => {
    state.generation += 1;
  });
  assert.equal(resumed.revision, 3);
  assert.equal(resumed.state.generation, 11);

  // 反向证据：正常长事务由心跳续租，别的实例拿不到锁（活 writer 不会被抢锁）。
  const holding = store.update(async (state) => {
    await delay(leaseMs * 6);
    state.generation += 1;
  });
  await delay(leaseMs * 2);
  const rival = await openStore(workspace, { leaseMs });
  await assert.rejects(
    rival.update((state) => {
      state.generation = -1;
    }),
    (error) => error instanceof LockHeldError && error.code === 'LOCK_HELD',
  );
  const held = await holding;
  assert.equal(held.revision, 4);
  assert.equal(held.state.generation, 12);

  // revision fencing 的另一半：锁仍是自己的，但磁盘 revision 已被推进 → 拒绝覆盖。
  await assert.rejects(
    store.update(async (state) => {
      state.generation = 42;
      // 模拟「别的进程写过账本但锁还在本事务手里」：只推进 revision。
      const file = JSON.parse(await readFile(store.path, 'utf8'));
      file.revision += 5;
      await writeFile(store.path, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    }),
    (error) => error instanceof LedgerWriteError && error.code === CODE_REVISION_CONFLICT,
  );
  const conflicted = JSON.parse(await readFile(store.path, 'utf8'));
  assert.equal(conflicted.generation, 12, '基线不一致时不得写入任何字段');
  assert.equal(conflicted.revision, 9);
  const afterConflict = await store.update((state) => {
    state.generation = 13;
  });
  assert.equal(afterConflict.revision, 10, '拒绝覆盖后仍以磁盘 revision 为基线继续');
});

test('10. F06 已初始化账本丢失不得静默重建（独立标记 + LEDGER_MISSING_AFTER_INIT）', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);
  await store.update((state) => {
    state.migration.completed = true;
    state.generation = 77;
  });

  // 标记与账本分离、同目录、且首次安装后已落盘。
  const markerPath = join(dirname(store.path), MARKER_FILE);
  assert.notEqual(markerPath, store.path);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(store.markerPath, markerPath);
  assert.equal(marker.scopeId, store.path.split(sep).at(-2));
  assert.equal(marker.firstRevision, 1);
  assert.equal(store.initializationMarker, 'present');

  // 模拟账本丢失：同一实例的下一次 update 必须失败，且不生成新账本。
  const preserved = join(dirname(store.path), 'ledger.preserved.json');
  await rename(store.path, preserved);
  await assert.rejects(
    store.update((state) => {
      state.generation += 1;
    }),
    (error) => error instanceof LedgerInvalidError && error.code === 'LEDGER_INVALID',
  );
  assert.equal(store.status, 'invalid');
  assert.equal(store.diagnostics.some((entry) => entry.code === CODE_MISSING_AFTER_INIT), true);
  const afterLoss = await readdir(dirname(store.path));
  assert.equal(afterLoss.includes('ledger.json'), false, '不得新建 generation=1 的账本');
  assert.equal(afterLoss.some((name) => name.startsWith('ledger.json.tmp-')), false, '失败后不得留下临时文件');
  assert.equal(afterLoss.includes('lock.json'), false, '失败后不得留下活动锁');

  // 重开实例同样判 invalid，读接口也拒绝。
  const reopened = await openStore(workspace);
  assert.equal(reopened.status, 'invalid');
  assert.equal(reopened.diagnostics[0].code, CODE_MISSING_AFTER_INIT);
  await assert.rejects(reopened.read(), (error) => error instanceof LedgerInvalidError);
  assert.equal((await readdir(dirname(store.path))).includes('ledger.json'), false);

  // 人工恢复原账本后回到 ready，之前的状态（generation=77）完好。
  await rename(preserved, store.path);
  const restored = await openStore(workspace);
  assert.equal(restored.status, 'ready');
  assert.equal((await restored.read()).generation, 77);
  assert.equal((await restored.read()).migration.completed, true);

  // 账本才是权威：只删标记不影响可读性，open 会补写标记。
  await rm(markerPath);
  const repaired = await openStore(workspace);
  assert.equal(repaired.status, 'ready');
  assert.equal(repaired.initializationMarker, 'present');
  assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).scopeId, store.path.split(sep).at(-2));

  // 真正首次安装（另一个 profile／scope）仍能正常建立账本与标记。
  const fresh = await openStore(workspace, { profileId: 'profile-fresh' });
  assert.equal(fresh.status, 'absent');
  assert.notEqual(fresh.path, store.path);
  const created = await fresh.update((state) => {
    state.generation = 1;
  });
  assert.equal(created.revision, 1);
  assert.equal(fresh.initializationMarker, 'present');
  assert.equal(JSON.parse(await readFile(join(dirname(fresh.path), MARKER_FILE), 'utf8')).firstGeneration, 1);
});

test('11. F08 目录 fsync：平台不支持降级为已知限制，真实 I/O 故障报 LEDGER_DURABILITY_UNKNOWN', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);
  await store.update((state) => {
    state.generation = 1;
  });

  // (a) EINVAL：平台不允许 fsync 目录 → 降级为已知限制，写入照常成功。
  const unsupported = await withDirectorySyncFault(workspace, 'EINVAL', () => store.update((state) => {
    state.generation = 2;
  }));
  assert.equal(unsupported.counter.injected >= 1, true, '注入必须真的命中目录 sync');
  assert.equal(unsupported.outcome.revision, 2);
  assert.equal(unsupported.outcome.state.generation, 2);
  assert.deepEqual((store.limitations ?? []).map((entry) => entry.code), ['DIRECTORY_FSYNC_UNSUPPORTED']);

  // (b) EIO：真实 I/O 故障 → rename 已发生，必须报持久性不确定。
  const failed = await withDirectorySyncFault(workspace, 'EIO', async () => {
    try {
      const result = await store.update((state) => {
        state.generation = 3;
      });
      return { resolved: true, result };
    } catch (error) {
      return { resolved: false, error };
    }
  });
  assert.equal(failed.counter.injected >= 1, true);
  assert.equal(failed.outcome.resolved, false, '真实 I/O 故障不得被吞掉');
  const error = failed.outcome.error;
  assert.equal(error instanceof LedgerWriteError, true);
  assert.equal(error.code, CODE_DURABILITY_UNKNOWN);
  assert.equal(error.durabilityUnknown, true);
  assert.match(error.message, /rename/);
  assert.equal(store.diagnostics.some((entry) => entry.code === CODE_DURABILITY_UNKNOWN), true);
  // rename 已经发生：磁盘上就是这次提交，revision 继续单调。
  const disk = JSON.parse(await readFile(store.path, 'utf8'));
  assert.equal(disk.generation, 3);
  assert.equal(disk.revision, 3);
  const next = await store.update((state) => {
    state.generation = 4;
  });
  assert.equal(next.revision, 4, '持久性告警之后仍能基于磁盘 revision 继续');
  assert.equal(next.state.generation, 4);
  assert.equal(JSON.parse(await readFile(store.path, 'utf8')).generation, 4);
});

test('12. history recovery validates scope and revision, and never replaces a newer ledger', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);
  await store.update((state) => { state.generation = 1; });
  const historyPath = join(dirname(store.path), 'history.jsonl');
  const baseline = JSON.parse(await readFile(store.path, 'utf8'));
  const valid = {...baseline, generation: 2, revision: baseline.revision + 1, migration: {...baseline.migration, completed: true}};
  await writeFile(historyPath, `${JSON.stringify({generation: valid.generation, revision: valid.revision, state: valid})}\n`);
  const recovered = await openStore(workspace);
  const recoveredState = await recovered.read();
  assert.equal(recoveredState.generation, 2);
  assert.equal(recoveredState.revision, 2);
  assert.equal(recoveredState.migration.completed, true);

  const sameGeneration = {...recoveredState, generation: 2, revision: 3, migration: {...recoveredState.migration, completed: false}};
  await writeFile(historyPath, `${JSON.stringify({phase: 'committed', generation: sameGeneration.generation, revision: sameGeneration.revision, state: sameGeneration})}\n`);
  const sameGenerationReopened = await openStore(workspace);
  const sameGenerationState = await sameGenerationReopened.read();
  assert.equal(sameGenerationState.generation, 2);
  assert.equal(sameGenerationState.revision, 3, '同 generation 仍必须选择较新的 revision');
  assert.equal(sameGenerationState.migration.completed, false);

  const newer = {...sameGenerationState, generation: 3, revision: 4};
  await writeFile(store.path, `${JSON.stringify(newer)}\n`);
  const invalid = {...newer, schemaVersion: 999, generation: 999, revision: 999};
  const foreign = {...newer, scopeId: 'f'.repeat(32), generation: 1000, revision: 1000};
  const forgedIdentity = {...newer, generation: 1001, revision: 1001, identity: {...newer.identity, pluginId: 'foreign-plugin'}};
  await writeFile(historyPath, `${JSON.stringify({generation: invalid.generation, revision: invalid.revision, state: invalid})}\n${JSON.stringify({generation: foreign.generation, revision: foreign.revision, state: foreign})}\n${JSON.stringify({generation: forgedIdentity.generation, revision: forgedIdentity.revision, state: forgedIdentity})}\n`);
  const stable = await openStore(workspace);
  const stableState = await stable.read();
  assert.equal(stableState.generation, 3, 'invalid/foreign history must not overwrite a valid ledger');
  assert.equal(stableState.revision, 4);
  assert.equal(stable.status, 'ready');
});


test('13. history recovery lock-held blocks lifecycle writes instead of reporting ready', async (t) => {
  const workspace = await makeWorkspace(t);
  const store = await openStore(workspace);
  await store.update((state) => { state.generation = 1; });
  const baseline = JSON.parse(await readFile(store.path, 'utf8'));
  const historyPath = join(dirname(store.path), 'history.jsonl');
  const lockPath = join(dirname(store.path), 'lock.json');
  const newer = {...baseline, generation: 2, revision: 2};
  await writeFile(historyPath, `${JSON.stringify({phase: 'committed', generation: 2, revision: 2, state: newer})}\n`);
  await writeFile(lockPath, JSON.stringify({token: 'live-owner', pid: 1, hostname: 'test', createdAt: new Date().toISOString(), leaseExpiresAt: new Date(Date.now() + 60_000).toISOString()}));

  const blocked = await openStore(workspace, {leaseMs: 1_000});
  assert.equal(blocked.status, 'ready', '原账本仍可读，但恢复状态必须单独暴露');
  assert.equal(blocked.recoveryState, 'blocked');
  assert.equal(blocked.diagnostics.some((entry) => entry.code === 'RECOVERY_BLOCKED'), true);
  await assert.rejects(blocked.update((state) => { state.generation = 3; }), (error) => error.code === 'RECOVERY_BLOCKED');
});
