/**
 * L1 测试：生命周期账本存储（契约 §8 的 8 项）。
 *
 * 全部测试使用真实临时目录（mkdtemp），不 mock fs；每项都对应契约里一条可观察
 * 行为，实现被改坏时必须变红。
 *
 * 运行：node --test check-lifecycle-store.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

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

  // (c) 存活 pid + 过期租约：回收。
  await writeFile(lockPath, JSON.stringify({ token: 'expired', pid: 1, hostname: 'x', createdAt: lease(-120_000), leaseExpiresAt: lease(-60_000) }));
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
