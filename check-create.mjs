#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from './index.js';

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'chat-sessions-create-'));
  const sessionsRoot = join(root, '.sessions');
  await mkdir(sessionsRoot, { recursive: true });
  const blankCwd = join(sessionsRoot, 'session-blank');
  const runningCwd = join(sessionsRoot, 'session-running');
  const archivedCwd = join(sessionsRoot, 'session-archived');
  const busyCwd = join(sessionsRoot, 'session-busy');
  const subagentCwd = join(sessionsRoot, 'session-subagent');
  const foreignCwd = join(root, 'foreign');
  await Promise.all([blankCwd, runningCwd, archivedCwd, busyCwd, subagentCwd, foreignCwd].map((path) => mkdir(path, { recursive: true })));

  const snapshots = [
    { header: { id: 'blank', cwd: blankCwd, createdAt: 6 }, sizeBytes: 0 },
    { header: { id: 'running', cwd: runningCwd, createdAt: 5 }, sizeBytes: 0 },
    { header: { id: 'archived', cwd: archivedCwd, createdAt: 4 }, sizeBytes: 0 },
    { header: { id: 'busy', cwd: busyCwd, createdAt: 3 }, sizeBytes: 0 },
    { header: { id: 'subagent', cwd: subagentCwd, origin: 'subagent', createdAt: 2 }, sizeBytes: 0 },
    { header: { id: 'foreign', cwd: foreignCwd, createdAt: 1 }, sizeBytes: 0 },
  ];
  const summaries = [
    { sessionId: 'blank', cwd: blankCwd, blank: true, running: false, agentAvailable: false },
    { sessionId: 'running', cwd: runningCwd, blank: true, running: true, agentAvailable: true },
    { sessionId: 'archived', cwd: archivedCwd, blank: true, running: false, agentAvailable: false },
    { sessionId: 'busy', cwd: busyCwd, blank: true, running: false, busy: true, agentAvailable: true },
    { sessionId: 'subagent', cwd: subagentCwd, blank: true, running: false, origin: 'subagent', agentAvailable: false },
    { sessionId: 'foreign', cwd: foreignCwd, blank: true, running: false, agentAvailable: false },
  ];
  const workspaces = [
    { id: 'workspace-blank', path: blankCwd, sessionIds: ['blank'] },
    { id: 'workspace-running', path: runningCwd, sessionIds: ['running'] },
    { id: 'workspace-archived', path: archivedCwd, sessionIds: ['archived'] },
  ];
  const calls = [];
  const live = new Map();
  let createRelease;
  const registry = {
    archivedSessionIds: ['archived'],
    list: () => workspaces,
    async create(path, title) {
      const workspace = { id: `workspace-${workspaces.length + 1}`, path, title, sessionIds: [] };
      workspaces.push(workspace);
      return workspace;
    },
    async delete() { return true; },
  };
  const sessionController = {
    async list() { return { items: summaries }; },
    async create(request) {
      calls.push(request);
      if (request.sessionId === 'blank' && options.delayReuse === true) {
        await new Promise((resolve) => { createRelease = resolve; });
      }
      const id = request.sessionId ?? `created-${calls.length}`;
      live.set(id, { append() {} });
      if (!snapshots.some((entry) => entry.header.id === id)) {
        const cwd = request.cwd ?? workspaces.find((w) => w.id === request.workspaceId)?.path;
        snapshots.push({ header: { id, cwd, createdAt: 5 }, sizeBytes: 0 });
        summaries.push({ sessionId: id, cwd, blank: true, running: false });
        const workspace = workspaces.find((w) => w.id === request.workspaceId);
        if (workspace) workspace.sessionIds.push(id);
      }
      return { sessionId: id };
    },
  };
  const persistence = {
    async list() { return snapshots; },
    async flush() {},
    async stat(id) { return snapshots.find((entry) => entry.header.id === id); },
  };
  let handler;
  const cleanups = [];
  const ctx = {
    webServer: { register(route) { handler = route.handler; return () => {}; } },
    sessionController,
    sessionPersistence: persistence,
    sessions: { get: (id) => live.get(id) },
    workspaceRegistry: registry,
    logger: { info() {}, warn() {} },
    effect(run, label) {
      // Skip the background sweep in this route fixture; install the HTTP effect only.
      if (label) return () => {};
      const cleanup = run();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  apply(ctx, { root, seedFirstTurn: options.seedFirstTurn === true });
  assert.equal(typeof handler, 'function');

  async function request(body) {
    const req = {
      method: 'POST',
      url: '/chat-sessions/create',
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
    };
    return new Promise((resolve, reject) => {
      const res = {
        writeHead(status) { this.status = status; },
        end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
  }

  return {
    root,
    calls,
    live,
    summaries,
    workspaces,
    releaseReuse() { createRelease?.(); },
    request,
    close: async () => { for (const cleanup of cleanups.reverse()) cleanup?.(); await rm(root, { recursive: true, force: true }); },
  };
}

test('default create remains force-create; opt-in reuses the native blank standalone session', async () => {
  const f = await fixture();
  try {
    const fresh = await f.request({});
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.body.sessionId, 'blank');
    assert.equal(f.calls.length, 1);

    f.calls.length = 0;
    const reused = await f.request({ reuseBlank: true });
    assert.equal(reused.status, 200);
    assert.equal(reused.body.sessionId, 'blank');
    assert.equal(reused.body.reused, true);
    assert.deepEqual(f.calls, [{ sessionId: 'blank', workspaceId: 'workspace-blank' }]);
  } finally {
    await f.close();
  }
});

test('reuse filters exact native blank, running, archived, foreign-root, and subagent rows', async () => {
  const f = await fixture();
  try {
    f.summaries.splice(f.summaries.findIndex((summary) => summary.sessionId === 'blank'), 1);
    const result = await f.request({ reuseBlank: true });
    assert.equal(result.body.reused, undefined);
    assert.match(result.body.sessionId, /^session-/u);
    assert.equal(f.calls.some((request) => request.sessionId === 'running'), false);
    assert.equal(f.calls.some((request) => request.sessionId === 'archived'), false);
    assert.equal(f.calls.some((request) => request.sessionId === 'busy'), false);
    assert.equal(f.calls.some((request) => request.sessionId === 'subagent'), false);
    assert.equal(f.calls.some((request) => request.sessionId === 'foreign'), false);
  } finally {
    await f.close();
  }
});

test('concurrent opt-in requests share one reuse flight', async () => {
  const f = await fixture({ delayReuse: true });
  try {
    const first = f.request({ reuseBlank: true });
    const second = f.request({ reuseBlank: true });
    for (let turn = 0; turn < 10 && f.calls.length === 0; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(f.calls.length, 1);
    f.releaseReuse();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.body.sessionId, 'blank');
    assert.equal(right.body.sessionId, 'blank');
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test('seedFirstTurn only affects newly created sessions, never a reused blank', async () => {
  const f = await fixture({ seedFirstTurn: true });
  try {
    const fresh = await f.request({});
    assert.equal(fresh.body.seeded, true);
    const blank = f.live.get(fresh.body.sessionId);
    assert.ok(blank);
    const reused = await f.request({ reuseBlank: true });
    assert.equal(reused.body.sessionId, 'blank');
    assert.equal(reused.body.seeded, false);
  } finally {
    await f.close();
  }
});

test('first creation is reused by later clicks until its blank is consumed', async () => {
  const f = await fixture();
  try {
    f.summaries.find((row) => row.sessionId === 'blank').blank = false;
    const first = await f.request({ reuseBlank: true });
    const workspaceCount = f.workspaces.length;
    for (let i = 0; i < 3; i++) {
      const repeated = await f.request({ reuseBlank: true });
      assert.equal(repeated.body.sessionId, first.body.sessionId);
      assert.equal(repeated.body.cwd, first.body.cwd);
      assert.equal(repeated.body.workspaceId, first.body.workspaceId);
    }
    assert.equal(f.workspaces.length, workspaceCount);
    f.summaries.find((row) => row.sessionId === first.body.sessionId).blank = false;
    const next = await f.request({ reuseBlank: true });
    assert.notEqual(next.body.sessionId, first.body.sessionId);
    assert.equal(f.workspaces.length, workspaceCount + 1);
  } finally { await f.close(); }
});

test('concurrent first clicks create one directory and receipt workspace', async () => {
  const f = await fixture();
  try {
    f.summaries.find((row) => row.sessionId === 'blank').blank = false;
    const count = f.workspaces.length;
    const results = await Promise.all(Array.from({ length: 5 }, () => f.request({ reuseBlank: true })));
    assert.equal(new Set(results.map((result) => result.body.sessionId)).size, 1);
    assert.equal(f.workspaces.length, count + 1);
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('workspace-mode new chat skips an orphan blank whose workspace was removed', async () => {
  const f = await fixture();
  try {
    f.workspaces.splice(0, 1);
    const result = await f.request({ reuseBlank: true });
    assert.notEqual(result.body.sessionId, 'blank');
    assert.ok(result.body.workspaceId);
  } finally { await f.close(); }
});

test('non-boolean reuse flags preserve explicit force-create behavior', async () => {
  const f = await fixture();
  try {
    for (const reuseBlank of [false, 'true', 1]) {
      const result = await f.request({ reuseBlank });
      assert.notEqual(result.body.sessionId, 'blank');
    }
    assert.equal(f.calls.length, 3);
  } finally { await f.close(); }
});
