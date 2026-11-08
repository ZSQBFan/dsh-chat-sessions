#!/usr/bin/env node
// 生命周期 L1：真临时目录 + 可控宿主替身（test-support/lifecycle-host.mjs）。
//
// 这里测的是「交接/恢复的语义」，不是私有函数的镜像：
//   · 显式停用 → 解除登记、目录/文件/会话头原样、未分组可继续；
//   · 普通重载 / 进程退出 → 保留 Workspace ID；
//   · 重新启用 → 只挂回仍属本插件、目录身份匹配的会话；
//   · 用户收编 → RELEASED，不抢；外来成员 / 目录异常 → CONFLICT，不猜；
//   · 坏账本 → 停止自动变更；创建意图崩溃 → ABANDONED，无半成品房间。
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHost, manifest, readLedgerText } from './test-support/lifecycle-host.mjs';

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat-lifecycle-')));
  const home = join(base, 'dsh-home');
  const root = join(base, 'chats');
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  const host = await createHost({ home, root });
  return { base, home, root, host };
}

test('unknown legacy Workspace ID returns HTTP 400 without changing ledger state', async () => {
  const {home, host} = await sandbox();
  try {
    assert.equal((await host.request('/status', {}, 'GET')).status, 200);
    const [scope] = await readLedgerText(home);
    const path = join(home, 'storages', 'dsh-chat-sessions-lifecycle', scope.scope, 'ledger.json');
    const before = await readFile(path);
    const response = await host.request('/lifecycle/recover-legacy', {workspaceIds: ['ws-does-not-exist']});
    assert.equal(response.status, 400);
    assert.equal(response.body.blocked, 'WORKSPACE_IDS_INVALID');
    assert.deepEqual(await readFile(path), before);
    assert.equal(host.workspaces.length, 0);
  } finally {
    await host.close();
  }
});

/** 创建一条独立对话，返回会话与房间信息。 */
async function createRoom(host) {
  const created = await host.request('/create', {});
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body;
}

async function ledgerFor(home) {
  const scopes = await readLedgerText(home);
  assert.equal(scopes.length, 1, `期望恰好一个 scope，实际 ${scopes.length}`);
  return scopes[0].ledger;
}

test('创建写入账本，status 暴露明确托管集合而不是路径猜测', async () => {
  const { home, root, host } = await sandbox();
  try {
    const created = await createRoom(host);
    await writeFile(join(created.cwd, 'note.txt'), 'keep');
    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms.length, 1);
    assert.equal(ledger.rooms[0].state, 'MANAGED');
    assert.equal(ledger.rooms[0].workspaceId, created.workspaceId);
    assert.deepEqual(ledger.rooms[0].sessionIds, [created.sessionId]);
    assert.deepEqual(ledger.creationIntents, []);

    const status = await host.request('/status', {}, 'GET');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.managedWorkspaceIds, [created.workspaceId]);
    assert.deepEqual(status.body.managedSessionIds, [created.sessionId]);
    assert.equal(status.body.lifecycle.state, 'READY');
    // 全量 workspaces 仍然照发，客户端排序依赖它。
    assert.ok(status.body.workspaces.some((workspace) => workspace.id === created.workspaceId));
    assert.equal(await realpath(join(root, '.sessions', created.sessionId)), created.cwd);
  } finally {
    await host.close();
  }
});

test('显式停用交出登记：目录、文件、会话头、归档与置顶一律不动', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    await writeFile(join(created.cwd, 'keep.txt'), 'user-data');
    await mkdir(join(created.cwd, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(created.cwd, 'nested', 'deeper', 'x.bin'), Buffer.from([0, 1, 2, 255]));
    host.archived.add(created.sessionId);
    await host.registry.pinSession(created.sessionId);
    const before = await manifest(created.cwd);
    const headerBefore = JSON.stringify(host.sessions.get(created.sessionId));

    host.manager.mode = 'plugin-disabled';
    await host.dispose();

    assert.equal(host.workspaces.length, 0, '房间登记必须解除');
    assert.equal(host.sessions.has(created.sessionId), true, '会话记录不能被删');
    assert.equal(JSON.stringify(host.sessions.get(created.sessionId)), headerBefore, '会话头（含 cwd）不能变');
    assert.deepEqual(await manifest(created.cwd), before, '任务目录内容必须逐项不变');
    assert.ok(host.archived.has(created.sessionId));
    assert.deepEqual(host.pinned, [created.sessionId]);

    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'DETACHED');
    assert.deepEqual(ledger.process.lastDetach.reason, 'PLUGIN_DISABLE');
    assert.equal(ledger.process.lastDetach.atomicGuard, 're-read-only');
  } finally {
    await host.close();
  }
});

test('普通重载与进程退出都保留 Workspace ID（不采用每次退出都解绑）', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);

    host.manager.mode = 'enabled'; // HMR / 依赖重启：行仍在且 enabled
    await host.dispose();
    assert.equal(host.workspaces.some((workspace) => workspace.id === created.workspaceId), true);
    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'MANAGED');
    assert.equal(ledger.process.lastDetach.reason, 'RELOAD');
  } finally {
    await host.close();
  }
});

test('进程退出（pluginManager 已消失）保留登记并记 UNKNOWN', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    host.manager.mode = 'absent'; // G0 实测：dispose 时宿主服务已整个消失
    await host.dispose();
    assert.equal(host.workspaces.some((workspace) => workspace.id === created.workspaceId), true);
    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'MANAGED');
    assert.equal(ledger.process.lastDetach.reason, 'UNKNOWN');
    assert.equal(ledger.process.lastDetach.skipped, true);
  } finally {
    await host.close();
  }
});

test('重新启用按条件恢复同一房间：Workspace ID 变化但路径与会话仍挂回', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    host.manager.mode = 'plugin-disabled';
    await host.dispose();

    host.manager.mode = 'enabled';
    await host.relaunch();

    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'MANAGED');
    assert.equal(ledger.rooms[0].canonicalCwd, created.cwd);
    const room = host.workspaces.find((workspace) => workspace.path === created.cwd);
    assert.ok(room, '目录必须重新登记');
    assert.deepEqual(room.sessionIds, [created.sessionId], '未分组旧会话必须挂回');
    // 恢复不改标题入口，也不自动取消归档。
    assert.equal(await realpath(join(created.cwd, '..', created.sessionId)), created.cwd);
  } finally {
    await host.close();
  }
});

test('用户收编者标记 RELEASED，不抢也不新建第二个房间', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    host.manager.mode = 'plugin-disabled';
    await host.dispose();

    // 停用期间用户把会话收编进自己的普通工作区。
    const userRoom = await host.registry.create(created.cwd, '用户自己的房间');
    await userRoom.attachSession(created.sessionId);

    host.manager.mode = 'enabled';
    await host.relaunch();

    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'RELEASED');
    assert.equal(ledger.rooms[0].lastError.code, 'USER_CLAIMED');
    assert.equal(host.workspaces.length, 1, '不能因为恢复再多出一个房间');
    assert.equal(host.workspaces[0].id, userRoom.id);
    assert.equal(host.workspaces[0].title, '用户自己的房间');
  } finally {
    await host.close();
  }
});

test('房间里有外来成员时整房间保留登记并标 CONFLICT', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    // 「外来」的定义是 cwd 不在这个房间：同 cwd 的派生会话是本房间成员（R05）。
    const elsewhere = join(home, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    const intruder = host.seedSession({ cwd: elsewhere });
    const room = host.workspaces.find((workspace) => workspace.id === created.workspaceId);
    // 直接写进登记集合：模拟「历史上挂进来、但后来 header 指向别处」的成员，
    // 这条路径不经过 attachSession 的 cwd 校验，正是交接时要防的那种不确定归属。
    room.sessionIds.push(intruder.id);

    host.manager.mode = 'plugin-disabled';
    await host.dispose();

    assert.equal(host.workspaces.length, 1, '有外来成员的房间必须留着');
    assert.deepEqual(host.workspaces[0].sessionIds.sort(), [created.sessionId, intruder.id].sort());
    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'CONFLICT');
    assert.equal(ledger.rooms[0].lastError.code, 'FOREIGN_MEMBERS');
  } finally {
    await host.close();
  }
});

test('同 cwd 派生会话算本房间成员：交接时一起入账并清掉登记（R05 / 验收 F01）', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    const room = host.workspaces.find((workspace) => workspace.id === created.workspaceId);
    // 宿主允许直接 create 一个继承同 cwd 的会话，账本里当然没有它。
    const derived = host.seedSession({ cwd: created.cwd });
    await room.attachSession(derived.id);

    host.manager.mode = 'plugin-disabled';
    await host.dispose();

    assert.equal(host.workspaces.length, 0, '派生会话不是外来成员，整房间应当交接');
    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'DETACHED');
    assert.deepEqual([...ledger.rooms[0].sessionIds].sort(), [created.sessionId, derived.id].sort());
    assert.deepEqual(
      ledger.rooms[0].members.map((member) => member.sessionId).sort(),
      [created.sessionId, derived.id].sort(),
    );
  } finally {
    await host.close();
  }
});

test('目录被删或身份变化时冲突且绝不 mkdir', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    host.manager.mode = 'plugin-disabled';
    await host.dispose();
    await rm(created.cwd, { recursive: true, force: true });

    host.manager.mode = 'enabled';
    await host.relaunch();

    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'CONFLICT');
    assert.equal(ledger.rooms[0].lastError.code, 'DIRECTORY_MISSING');
    await assert.rejects(stat(created.cwd), { code: 'ENOENT' }, '恢复路径不允许重建目录');
    assert.equal(host.workspaces.length, 0);
  } finally {
    await host.close();
  }
});

test('重复停用是幂等的：第二次不重复删、不重复写错误', async () => {
  const { home, host } = await sandbox();
  try {
    await createRoom(host);
    host.manager.mode = 'plugin-disabled';
    await host.dispose();
    const first = await ledgerFor(home);

    await host.dispose(); // 已经 DISPOSED，再来一次
    const second = await ledgerFor(home);
    assert.equal(second.rooms[0].state, 'DETACHED');
    assert.equal(second.rooms[0].revision, first.rooms[0].revision, '无变化时 revision 不应增长');
    assert.equal(host.workspaces.length, 0);
  } finally {
    await host.close();
  }
});

test('账本损坏时降级为 DEGRADED，且完全不碰原生登记', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    host.manager.mode = 'plugin-disabled';
    await host.dispose();

    const scopes = await readLedgerText(home);
    const path = join(home, 'storages', 'dsh-chat-sessions-lifecycle', scopes[0].scope, 'ledger.json');
    await writeFile(path, '{ this is not json');

    // 手工恢复登记，模拟「账本坏了但原生还有房间」。
    const kept = await host.registry.create(created.cwd, '独立对话');
    await kept.attachSession(created.sessionId);

    host.manager.mode = 'enabled';
    await host.relaunch();

    const status = await host.request('/status', {}, 'GET');
    assert.equal(status.body.lifecycle.state, 'DEGRADED');
    assert.deepEqual(status.body.managedWorkspaceIds, []);
    assert.equal(host.workspaces.length, 1, '坏账本不得触发删除');
    assert.equal(host.workspaces[0].id, kept.id);
    assert.ok(host.warnings.some((line) => line.includes('LEDGER_INVALID')), '必须留下诊断');
  } finally {
    await host.close();
  }
});

test('创建意图崩溃后判 ABANDONED，不产生半成品房间', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    // 手工造一条 10 分钟前的 PENDING 意图，模拟「落了意图、原生没建完」。
    const scopes = await readLedgerText(home);
    const path = join(home, 'storages', 'dsh-chat-sessions-lifecycle', scopes[0].scope, 'ledger.json');
    const ledger = JSON.parse(await readFile(path, 'utf8'));
    ledger.creationIntents = [{
      id: 'intent-ghost',
      sessionId: 'session-ghost',
      cwd: join(created.cwd, '..', 'session-ghost'),
      canonicalCwd: join(created.cwd, '..', 'session-ghost'),
      ownerSessionId: 'session-ghost',
      state: 'PENDING',
      at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      createdAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    }];
    await writeFile(path, JSON.stringify(ledger, null, 2));

    await host.relaunch();
    const after = await ledgerFor(home);
    assert.equal(after.creationIntents[0].state, 'ABANDONED');
    assert.equal(after.rooms.length, 1, '不能把幽灵意图变成房间');
    assert.equal(host.workspaces.length, 1);
  } finally {
    await host.close();
  }
});

test('bundle 卸载（包已移除）同样交出登记', async () => {
  const { home, host } = await sandbox();
  try {
    await createRoom(host);
    host.manager.mode = 'removed';
    await host.dispose();
    assert.equal(host.workspaces.length, 0);
    const ledger = await ledgerFor(home);
    assert.equal(ledger.process.lastDetach.reason, 'BUNDLE_REMOVE');
  } finally {
    await host.close();
  }
});

test('交接不产生空壳登记，也不移动标题软链接', async () => {
  const { home, root, host } = await sandbox();
  try {
    const created = await createRoom(host);
    const linkBefore = await stat(join(root, created.sessionId)).catch(() => null);
    const archiveBefore = await stat(join(root, '.archive')).catch(() => null);

    host.manager.mode = 'plugin-disabled';
    await host.dispose();

    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'DETACHED');
    assert.equal(await stat(join(root, created.sessionId)).then(() => 'there', () => 'gone'),
      linkBefore === null ? 'gone' : 'there', '标题入口不该被交接挪动');
    assert.equal(await stat(join(root, '.archive')).then(() => 'there', () => 'gone'),
      archiveBefore === null ? 'gone' : 'there', '交接不触发归档目录变化');
  } finally {
    await host.close();
  }
});

test('用户停用期间新注册的同路径空工作区不被接管（验收 F02 / R08）', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    host.manager.mode = 'plugin-disabled';
    await host.dispose();

    // 用户在原 cwd 自己登记了一个普通工作区，成员为空。
    const userRoom = await host.registry.create(created.cwd, '用户自己的房间');

    host.manager.mode = 'enabled';
    await host.relaunch();

    const ledger = await ledgerFor(home);
    assert.equal(ledger.rooms[0].state, 'RELEASED');
    assert.equal(ledger.rooms[0].lastError.code, 'USER_CLAIMED');
    assert.equal(host.workspaces.length, 1, '不能在同一路径上再建一个登记');
    assert.equal(host.workspaces[0].id, userRoom.id);
    assert.deepEqual([...host.workspaces[0].sessionIds], [], '用户工作区的成员集合必须保持原样');
    assert.equal(host.workspaces[0].title, '用户自己的房间', '不接管就不改用户标题');

    const status = await host.request('/status', {}, 'GET');
    assert.deepEqual(status.body.managedWorkspaceIds, [], '用户收编的房间不在托管集合里');
    assert.deepEqual(status.body.managedSessionIds, [], '旧会话也不该被当成托管成员');
  } finally {
    await host.close();
  }
});

test('PARTIAL 只托管真正挂回去的成员，用户/异常成员保持原资格（验收 F03）', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    // 同 cwd 派生一条会话（交接时会被收进房间），随后删掉它的 header，
    // 模拟「账本里有、日志已经不在了」的成员。
    const derived = host.seedSession({ cwd: created.cwd });
    await host.workspaces[0].attachSession(derived.id);
    host.manager.mode = 'plugin-disabled';
    await host.dispose();

    host.sessions.delete(derived.id); // header 读不到 → MISSING_SESSION
    host.manager.mode = 'enabled';
    await host.relaunch();

    const ledger = await ledgerFor(home);
    const room = ledger.rooms[0];
    assert.equal(room.state, 'PARTIAL', '一个成员恢复不了就是 PARTIAL，不能报 MANAGED');
    const memberOf = (id) => room.members.find((member) => member.sessionId === id);
    assert.equal(memberOf(created.sessionId).eligibility, 'attached');
    assert.notEqual(memberOf(derived.id).eligibility, 'attached', '没挂回去的成员不能被标成 attached');

    const status = await host.request('/status', {}, 'GET');
    assert.deepEqual(status.body.managedSessionIds, [created.sessionId], '托管集合只含真正挂回的成员');
  } finally {
    await host.close();
  }
});

test('账本写不进去时创建直接失败，不留下孤儿会话或半登记（验收 F04 / R10）', async () => {
  const { home, host } = await sandbox();
  try {
    const created = await createRoom(host);
    const scopes = await readLedgerText(home);
    const scopeDir = join(home, 'storages', 'dsh-chat-sessions-lifecycle', scopes[0].scope);
    await chmod(scopeDir, 0o500); // 只读：临时文件 rename 不进去，等同 ENOSPC/EACCES
    try {
      const failed = await host.request('/create', {});
      assert.equal(failed.status, 503, JSON.stringify(failed.body));
      assert.equal(failed.body.code, 'LIFECYCLE_LEDGER_UNAVAILABLE');
      assert.equal(host.workspaces.length, 1, '失败请求不许留下新的工作区登记');
      const status = await host.request('/status', {}, 'GET');
      assert.equal(status.body.lifecycle.state, 'DEGRADED', '写不进去之后必须停止自动写');
      const again = await host.request('/create', {});
      assert.equal(again.status, 409, '降级后不再接受新写');
    } finally {
      await chmod(scopeDir, 0o700);
    }
    assert.ok(created.sessionId);
  } finally {
    await host.close();
  }
});

test('非托管工作区既不改标题也不删登记（验收 F07 / R14）', async () => {
  const { root, host } = await sandbox();
  try {
    const created = await createRoom(host);
    // 形似插件房间、但从未进过账本的用户工作区。
    const userPath = join(root, '.sessions', 'session-00000000-0000-4000-8000-000000000000');
    await mkdir(userPath, { recursive: true });
    const userRoom = await host.registry.create(userPath, '用户自己登记的工作区');

    // 触发一次 sweep + 登记表整理。
    await host.request('/link', { sessionId: created.sessionId }, 'POST');

    const after = host.workspaces.find((workspace) => workspace.id === userRoom.id);
    assert.ok(after, '非托管登记不许被删');
    assert.equal(after.title, '用户自己登记的工作区', '非托管工作区的标题不许被改写');
  } finally {
    await host.close();
  }
});

test('首次升级：无账本的旧插件房间按多证据认领，证据不足的只留着不动（验收 K01）', async () => {
  const { home, root, host } = await sandbox();
  try {
    // 模拟 v0.1.1：原生登记表里有房间，账本里一个房间都没有。
    // 房间目录名就是 owner 会话 ID（v0.1.1 的命名），否则审计会把它当空目录。
    const legacyId = 'session-11111111-1111-4111-8111-111111111111';
    const legacyCwd = join(root, '.sessions', legacyId);
    await mkdir(legacyCwd, { recursive: true });
    await writeFile(join(legacyCwd, 'keep.txt'), 'keep');
    const legacySession = host.seedSession({ cwd: legacyCwd, id: legacyId });
    const legacyRoom = await host.registry.create(legacyCwd, '独立对话');
    await legacyRoom.attachSession(legacySession.id);

    // 目录在、登记在，但会话日志已经没了：证据不足，不许认领。
    const orphanCwd = join(root, '.sessions', 'session-22222222-2222-4222-8222-222222222222');
    await mkdir(orphanCwd, { recursive: true });
    const orphanRoom = await host.registry.create(orphanCwd, '证据不足的房间');

    await host.relaunch();

    const ledger = await ledgerFor(home);
    assert.equal(ledger.migration.completed, true, '迁移跑过要留可验证标记');
    assert.equal(ledger.rooms.length, 1, '只认领证据齐全的那一个');
    assert.equal(ledger.rooms[0].workspaceId, legacyRoom.id);
    assert.equal(ledger.rooms[0].state, 'MANAGED');
    assert.deepEqual(ledger.rooms[0].sessionIds, [legacySession.id]);

    const status = await host.request('/status', {}, 'GET');
    assert.deepEqual(status.body.managedWorkspaceIds, [legacyRoom.id]);
    assert.deepEqual(status.body.managedSessionIds, [legacySession.id]);
    assert.ok(host.workspaces.some((workspace) => workspace.id === orphanRoom.id),
      '证据不足的房间不许被删，也不许被认领');
    assert.equal(host.workspaces.find((workspace) => workspace.id === orphanRoom.id).title, '证据不足的房间');
  } finally {
    await host.close();
  }
});
