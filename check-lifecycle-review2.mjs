#!/usr/bin/env node
// 生命周期 L1（第二轮复审场景）：直接驱动 LifecycleCoordinator + 真 LedgerStore。
//
// 这一组不是私有函数的镜像测试，而是把复审报告 R2-F02/F03/F04/F06/F07/F08 描述的用户可见
// 结果写成断言：
//   · 恢复/迁移的意图写不进账本 → 启动不得 READY、不得产生原生副作用；
//   · 收尾失败留下的原生对象 → 重启后按原生事实补账，停用能清干净；
//   · 最后确认里看到的新成员 → 必须入账，重新启用不丢；
//   · 同 cwd 子代理 → 不补账、不恢复；
//   · PARTIAL → 下一次启动继续补齐，不把用户已收编的会话抢回来。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ELIGIBILITY, PROCESS_STATE, ROOM_STATE } from './lifecycle/model.js';
import { LedgerStore } from './lifecycle/store.js';
import { LifecycleCoordinator } from './lifecycle/coordinator.js';
import { createHost } from './test-support/lifecycle-host.mjs';

async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'chat-lifecycle-r2-')));
  const home = join(base, 'dsh-home');
  const root = join(base, 'chats');
  await mkdir(home, { recursive: true });
  await mkdir(root, { recursive: true });
  const host = await createHost({ home, root });
  return { base, home, root, host };
}

/** 打开账本 + 协调器；`failAt` 指定第几次 update 抛错（模拟 EACCES / ENOSPC）。 */
async function open({ host, home, root, failAt = 0 }) {
  const store = await LedgerStore.open({ dshHome: home, canonicalRoot: root, profileId: 'review-2' });
  let updates = 0;
  const wrapper = {
    get status() { return store.status; },
    read: () => store.read(),
    close: () => store.close(),
    async update(mutator) {
      updates += 1;
      if (failAt !== 0 && updates === failAt) {
        const error = new Error('injected write failure');
        error.code = 'EACCES';
        throw error;
      }
      return store.update(mutator);
    },
  };
  const coordinator = new LifecycleCoordinator({
    ctx: host.ctx,
    config: { root },
    store: wrapper,
    identity: { root, profileId: 'review-2', dshHome: home, pluginId: 'dsh-chat-sessions' },
  });
  return { store, coordinator, updates: () => updates };
}

/** 直接读本测试自己那份账本（createHost 的插件装配会另开一个 scope，不能按数量取）。 */
async function ledgerOf(store) {
  return JSON.parse(await readFile(store.path, 'utf8'));
}

/** 造一个「上次停用后留下的」DETACHED 房间（目录 + 会话头都在，原生登记不在）。 */
async function seedDetachedRoom({ host, home, root, members = 1 }) {
  const owner = `session-${'1'.repeat(8)}-1111-4111-8111-111111111111`;
  const cwd = join(root, '.sessions', owner);
  await mkdir(cwd, { recursive: true });
  host.seedSession({ cwd, id: owner });
  const ids = [owner];
  for (let index = 1; index < members; index += 1) {
    const id = `session-${String(index + 1).repeat(8)}-2222-4222-8222-222222222222`;
    host.seedSession({ cwd, id });
    ids.push(id);
  }
  const { store, coordinator } = await open({ host, home, root });
  await store.update((state) => {
    state.rooms.push({
      workspaceId: 'ws-detached',
      ownerSessionId: owner,
      cwd,
      canonicalCwd: cwd,
      state: ROOM_STATE.DETACHED,
      sessionIds: ids,
      members: ids.map((sessionId) => ({ sessionId, eligibility: ELIGIBILITY.ELIGIBLE })),
      operation: null,
      lastError: null,
    });
  });
  await store.close();
  return { owner, cwd, ids };
}

test('R2-F02 恢复意图写不进账本：启动不得 READY，也不创建原生工作区', async () => {
  const { home, root, host } = await sandbox();
  try {
    const seeded = await seedDetachedRoom({ host, home, root });
    // 第 1 次 update 就是恢复意图（migrate 被 rooms 非空跳过）。
    const { store, coordinator } = await open({ host, home, root, failAt: 1 });
    const started = await coordinator.start();
    assert.equal(started.ok, false, '意图没落盘就不能宣告就绪');
    assert.equal(coordinator.state, PROCESS_STATE.DEGRADED);
    assert.equal(coordinator.canWrite(), false);
    assert.equal(host.workspaces.length, 0, '不得在意图失败后创建原生工作区');
    assert.deepEqual(host.workspaces.flatMap((workspace) => workspace.sessionIds), []);
    const after = await ledgerOf(store);
    assert.equal(after.rooms[0].state, ROOM_STATE.DETACHED, '房间停在原状态，留给下次重试');
    assert.ok(seeded.ids.length >= 1);
  } finally {
    await host.close();
  }
});

test('R2-F03 首次迁移写失败：启动必须 blocked，不能先 DEGRADED 再 READY', async () => {
  const { home, root, host } = await sandbox();
  try {
    const owner = `session-${'3'.repeat(8)}-3333-4333-8333-333333333333`;
    const cwd = join(root, '.sessions', owner);
    await mkdir(cwd, { recursive: true });
    host.seedSession({ cwd, id: owner });
    const workspace = await host.registry.create(cwd, '旧房间');
    await workspace.attachSession(owner);

    const { store, coordinator } = await open({ host, home, root, failAt: 1 });
    const started = await coordinator.start();
    assert.equal(started.ok, false);
    assert.equal(coordinator.state, PROCESS_STATE.DEGRADED, '迁移失败后不许被 READY 覆盖');
    assert.equal(coordinator.canWrite(), false);
    // 迁移那一笔没落盘，账本可能还停在「首次安装」：能读就读，读不到也算没写进去。
    const after = await store.read();
    assert.equal(after, null, '迁移失败时账本不应存在');
    assert.equal(store.status, 'absent');
  } finally {
    await host.close();
  }
});

test('R2-F04 收尾失败留下的原生对象：重启按原生事实补账，停用能清干净', async () => {
  const { home, root, host } = await sandbox();
  try {
    const sessionId = `session-${'4'.repeat(8)}-4444-4444-8444-444444444444`;
    const cwd = join(root, '.sessions', sessionId);
    await mkdir(cwd, { recursive: true });
    host.seedSession({ cwd, id: sessionId });

    const first = await open({ host, home, root });
    await first.coordinator.start();
    const begun = await first.coordinator.beginCreate({ sessionId, cwd, canonicalCwd: cwd });
    assert.equal(begun.ok, true);
    const workspace = await host.registry.create(cwd, '独立对话');
    await workspace.attachSession(sessionId);
    // 收尾写失败：账本只剩 PENDING 意图。
    const failing = await open({ host, home, root, failAt: 1 });
    const finished = await failing.coordinator.finishCreate({ sessionId, cwd, canonicalCwd: cwd, workspaceId: workspace.id });
    assert.equal(finished.ok, false);
    await failing.coordinator.close();
    await first.coordinator.close();

    const restarted = await open({ host, home, root });
    const started = await restarted.coordinator.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    const after = await ledgerOf(restarted.store);
    assert.equal(after.rooms.length, 1, '原生对象已建成的意图要补成房间');
    assert.equal(after.rooms[0].workspaceId, workspace.id);
    assert.equal(after.creationIntents[0].state, 'ADOPTED');
    const described = await restarted.coordinator.describe();
    assert.deepEqual(described.managed.sessionIds, [sessionId]);

    const detached = await restarted.coordinator.detach({ reason: 'PLUGIN_DISABLE' });
    assert.equal(detached.detached.length, 1);
    assert.equal(host.workspaces.length, 0, '补账之后停用必须解除登记');
    await restarted.coordinator.close();
  } finally {
    await host.close();
  }
});

test('R2-F06 最后确认才出现的新同 cwd 成员：先入账再删登记', async () => {
  const { home, root, host } = await sandbox();
  try {
    const owner = `session-${'5'.repeat(8)}-5555-4555-8555-555555555555`;
    const late = `session-${'6'.repeat(8)}-6666-4666-8666-666666666666`;
    const cwd = join(root, '.sessions', owner);
    await mkdir(cwd, { recursive: true });
    host.seedSession({ cwd, id: owner });
    const workspace = await host.registry.create(cwd, '独立对话');
    await workspace.attachSession(owner);

    const { store, coordinator } = await open({ host, home, root });
    await store.update((state) => {
      state.rooms.push({
        workspaceId: workspace.id,
        ownerSessionId: owner,
        cwd,
        canonicalCwd: cwd,
        state: ROOM_STATE.MANAGED,
        sessionIds: [owner],
        members: [{ sessionId: owner, eligibility: ELIGIBILITY.ATTACHED }],
        operation: null,
        lastError: null,
      });
    });
    await coordinator.start();
    // 成员在「删除登记前最后一次复读」里才出现：必须被补进账本。
    host.seedSession({ cwd, id: late });
    await workspace.attachSession(late);
    const detached = await coordinator.detach({ reason: 'PLUGIN_DISABLE' });
    assert.deepEqual(detached.detached, [owner]);
    const after = await ledgerOf(store);
    assert.deepEqual([...after.rooms[0].sessionIds].sort(), [owner, late].sort(), '看到的新成员必须入账');
    assert.equal(host.workspaces.length, 0);
    await coordinator.close();
  } finally {
    await host.close();
  }
});

test('R2-F07 同 cwd 子代理：不补账、不恢复', async () => {
  const { home, root, host } = await sandbox();
  try {
    const owner = `session-${'7'.repeat(8)}-7777-4777-8777-777777777777`;
    const subagent = `session-${'8'.repeat(8)}-8888-4888-8888-888888888888`;
    const cwd = join(root, '.sessions', owner);
    await mkdir(cwd, { recursive: true });
    host.seedSession({ cwd, id: owner });
    host.seedSession({ cwd, id: subagent, origin: 'subagent' });
    const workspace = await host.registry.create(cwd, '独立对话');
    await workspace.attachSession(owner);
    await workspace.attachSession(subagent);

    const { store, coordinator } = await open({ host, home, root });
    await store.update((state) => {
      state.rooms.push({
        workspaceId: workspace.id,
        ownerSessionId: owner,
        cwd,
        canonicalCwd: cwd,
        state: ROOM_STATE.MANAGED,
        sessionIds: [owner],
        members: [{ sessionId: owner, eligibility: ELIGIBILITY.ATTACHED }],
        operation: null,
        lastError: null,
      });
    });
    await coordinator.start();
    await coordinator.detach({ reason: 'PLUGIN_DISABLE' });
    const after = await ledgerOf(store);
    assert.deepEqual(after.rooms[0].sessionIds, [owner], '子代理不归插件托管');
    assert.ok(!after.rooms[0].sessionIds.includes(subagent));
    await coordinator.close();
  } finally {
    await host.close();
  }
});

test('R2-F08 PARTIAL：下一次启动继续补齐缺失成员', async () => {
  const { home, root, host } = await sandbox();
  try {
    const owner = `session-${'9'.repeat(8)}-9999-4999-8999-999999999999`;
    const missing = `session-${'a'.repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    const cwd = join(root, '.sessions', owner);
    await mkdir(cwd, { recursive: true });
    host.seedSession({ cwd, id: owner });
    host.seedSession({ cwd, id: missing });
    const workspace = await host.registry.create(cwd, '独立对话');
    await workspace.attachSession(owner);

    const { store, coordinator } = await open({ host, home, root });
    await store.update((state) => {
      state.rooms.push({
        workspaceId: workspace.id,
        ownerSessionId: owner,
        cwd,
        canonicalCwd: cwd,
        state: ROOM_STATE.PARTIAL,
        sessionIds: [owner, missing],
        members: [
          { sessionId: owner, eligibility: ELIGIBILITY.ATTACHED },
          { sessionId: missing, eligibility: ELIGIBILITY.CONFLICT },
        ],
        operation: null,
        lastError: { phase: 'restore', code: 'ATTACH_FAILED', reason: 'ATTACH_FAILED', at: new Date().toISOString() },
      });
    });
    const started = await coordinator.start();
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.ok(workspace.sessionIds.includes(missing), '这次启动必须把缺失成员挂回去');
    const after = await ledgerOf(store);
    assert.equal(after.rooms[0].state, ROOM_STATE.MANAGED);
    const described = await coordinator.describe();
    assert.deepEqual([...described.managed.sessionIds].sort(), [owner, missing].sort());
    await coordinator.close();
  } finally {
    await host.close();
  }
});
