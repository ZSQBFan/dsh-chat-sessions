// 生命周期 L1 夹具：一个「够真」的宿主替身，不是 jsdom，也不是 mock dispose。
//
// 它实现的是 index.js/协调器真正依赖的那几条原生语义：
//   · registry.create(path) 同 canonical path 返回既有实体、不改标题；
//   · registry.delete(id) 只删登记，目录与会话日志原地保留；
//   · attachSession 要求 header.cwd 与登记 path 完全一致，否则抛错；
//   · `ctx.get('profileContext')` 存在（生命周期层只在有宿主身份的上下文里启用）；
//   · `ctx.effect` 收集 disposer，`dispose()` 时**并发**调用——与 cordis `_unload` 一致。
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { apply } from '../index.js';

/**
 * @param {{home: string, root: string, config?: object}} options
 *   `home` 当作 DSH_HOME（账本落在 <home>/storages/...），`root` 是插件 chat 根。
 */
export async function createHost({ home, root, config = {} }) {
  const sessions = new Map();
  const workspaces = [];
  const archived = new Set();
  const pinned = [];
  const disposers = [];
  const warnings = [];
  const cleanups = [];
  let handler;
  let profileName = 'lc-test';

  await mkdir(join(root, '.sessions'), { recursive: true });

  const registry = {
    get archivedSessionIds() { return [...archived]; },
    get pinnedSessionIds() { return [...pinned]; },
    list() { return workspaces.map((workspace) => ({ ...workspace, sessionIds: [...workspace.sessionIds] })); },
    get(id) { return workspaces.find((workspace) => workspace.id === id); },
    async create(path, title) {
      const canonical = await realpath(path).catch(() => path);
      const existing = workspaces.find((workspace) => workspace.path === canonical);
      if (existing !== undefined) return existing; // 同路径重复 create 不改标题、不新建
      const record = {
        id: `ws-${randomUUID()}`,
        path: canonical,
        title,
        sessionIds: [],
        async attachSession(sessionId) {
          const header = sessions.get(sessionId);
          if (header === undefined) {
            const error = new Error(`unknown session ${sessionId}`);
            error.code = 'ENOENT';
            throw error;
          }
          const cwd = await realpath(header.cwd).catch(() => header.cwd);
          if (cwd !== record.path) {
            const error = new Error('ApiSessionCwdConflict');
            error.code = 'ApiSessionCwdConflict';
            throw error;
          }
          if (!record.sessionIds.includes(sessionId)) record.sessionIds.push(sessionId);
        },
        async detachSession(sessionId) {
          const index = record.sessionIds.indexOf(sessionId);
          if (index !== -1) record.sessionIds.splice(index, 1);
        },
        async setTitle(next) { record.title = next; },
      };
      workspaces.push(record);
      return record;
    },
    async delete(id) {
      const index = workspaces.findIndex((workspace) => workspace.id === id);
      if (index === -1) return false;
      workspaces.splice(index, 1);
      return true;
    },
    async archiveSession(id) { archived.add(id); },
    async unarchiveSession(id) { archived.delete(id); },
    async pinSession(id) { if (!pinned.includes(id)) pinned.unshift(id); },
    async unpinSession(id) { const i = pinned.indexOf(id); if (i !== -1) pinned.splice(i, 1); },
  };

  // 原生管理器的替身：只实现 `describeUnload` 真正读的两张表。
  // `mode` 模拟宿主已经落盘的事实（停用先写 patch 再重载，所以 dispose 时读到的就是终态）：
  //   enabled / plugin-disabled / bundle-disabled / removed / absent（进程退出时服务已消失）
  const manager = {
    mode: 'enabled',
    async listPlugins() {
      if (this.mode === 'absent') throw new Error('pluginManager unavailable');
      if (this.mode === 'removed' || this.mode === 'bundle-disabled') return [];
      return [{
        entryId: 'include:chat-sessions',
        moduleName: 'dsh-chat-sessions',
        enabled: this.mode !== 'plugin-disabled',
        fiberPhase: this.mode === 'plugin-disabled' ? 'unloading' : 'active',
      }];
    },
    async listBundles() {
      if (this.mode === 'absent') throw new Error('pluginManager unavailable');
      // `removed`：包与 bundle 行都消失了 —— 这是唯一能区分「卸载」与「停用」的信号。
      if (this.mode === 'removed') return [];
      return [{ name: 'dsh-chat-sessions', enabled: this.mode !== 'bundle-disabled' }];
    },
  };

  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: (id) => sessions.get(id) },
    sessionPersistence: {
      async list() { return [...sessions.values()].map((header) => ({ header, sizeBytes: 1 })); },
      async flush() {},
      async stat(id) { return sessions.has(id) ? { header: sessions.get(id), sizeBytes: 1 } : undefined; },
    },
    sessionController: {
      async create(options) {
        const id = options.sessionId;
        const workspace = options.workspaceId === undefined ? undefined : workspaces.find((w) => w.id === options.workspaceId);
        if (options.workspaceId !== undefined && options.cwd !== undefined) throw new Error('workspaceId + cwd');
        if (options.workspaceId !== undefined && workspace === undefined) throw new Error('unknown workspace');
        const header = { type: 'session', id, cwd: workspace === undefined ? options.cwd : workspace.path, createdAt: Date.now() };
        sessions.set(id, header);
        if (workspace !== undefined && !workspace.sessionIds.includes(id)) workspace.sessionIds.push(id);
        return { sessionId: id };
      },
    },
    webServer: { register(route) { handler = route.handler; return () => {}; } },
    logger: { info() {}, warn(message) { warnings.push(String(message)); } },
    get(name) {
      // 与真宿主一致：服务通过 ctx.get() 取；dispose 期间 pluginManager 可能已消失。
      if (name === 'profileContext') return { name: profileName, dir: join(home, 'profiles', profileName) };
      if (name === 'pluginManager') return manager.mode === 'absent' ? undefined : manager;
      if (name === 'workspaceRegistry') return registry;
      if (name === 'sessionPersistence') return ctx.sessionPersistence;
      if (name === 'sessions') return ctx.sessions;
      return undefined;
    },
    effect(run, label) {
      if (label) { disposers.push(run); return () => {}; }
      const cleanup = run();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return cleanup;
    },
  };

  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  apply(ctx, { root, ...config });

  async function request(path, body = {}, method = 'POST') {
    return new Promise((resolve, reject) => {
      const req = {
        method,
        url: `/chat-sessions${path}`,
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          if (method === 'GET') return;
          yield Buffer.from(JSON.stringify(body));
        },
      };
      const res = {
        writeHead(status) { this.status = status; },
        end(text) { resolve({ status: this.status, body: JSON.parse(text) }); },
      };
      Promise.resolve(handler(req, res)).catch(reject);
    });
  }

  /** 真按 cordis 的方式卸载：所有 disposer 并发执行，异常只记录。 */
  async function dispose() {
    const pending = disposers.splice(0).map((run) => {
      try {
        const cleanup = run();
        return typeof cleanup === 'function' ? cleanup() : undefined;
      } catch (error) {
        warnings.push(`dispose threw: ${error?.message}`);
        return undefined;
      }
    });
    await Promise.allSettled(pending);
    for (const cleanup of cleanups.splice(0)) await cleanup?.();
  }

  /** 模拟普通重启：卸载后重新 apply（同一 DSH_HOME、同一 root）。 */
  async function relaunch({ profile = profileName } = {}) {
    await dispose();
    profileName = profile;
    apply(ctx, { root, ...config });
    // 宿主的 apply 是同步的，账本对账/恢复是异步的：用 status 路由把它等干净，
    // 否则测试会在恢复写完之前读到中间态（真宿主里 HTTP 写入口同样被这个 await 挡住）。
    await request('/status', {}, 'GET');
  }

  /** 直接塞一个会话头，模拟「外部已有会话」。 */
  function seedSession({ cwd, id = `session-${randomUUID()}`, origin }) {
    // 真宿主的 session header 带 type:'session'（legacy 审计据此判定「日志可用」），
    // 夹具必须同形状，否则审计会把每条会话都当成读不到 header。
    const header = { type: 'session', id, cwd, createdAt: Date.now() };
    if (origin !== undefined) header.origin = origin;
    sessions.set(id, header);
    return header;
  }

  return {
    ctx,
    manager,
    registry,
    workspaces,
    archived,
    pinned,
    sessions,
    warnings,
    request,
    dispose,
    relaunch,
    seedSession,
    get handler() { return handler; },
    async close() {
      process.env.DSH_HOME = previousHome;
    },
  };
}

/** 读账本原文（测试要证明「先落盘再动原生」，所以直接读文件，不走 store 缓存）。 */
export async function readLedgerText(home) {
  const base = join(home, 'storages', 'dsh-chat-sessions-lifecycle');
  const scopes = await readdir(base).catch(() => []);
  const out = [];
  for (const scope of scopes) {
    const text = await readFile(join(base, scope, 'ledger.json'), 'utf8').catch(() => null);
    if (text !== null) out.push({ scope, ledger: JSON.parse(text) });
  }
  return out;
}

/** 目录清单（含空目录与软链接指向），用来证明交接没动用户的文件。 */
export async function manifest(directory) {
  const entries = [];
  async function walk(current, prefix) {
    let list;
    try {
      list = await readdir(current, { withFileTypes: true });
    } catch {
      entries.push({ path: prefix, state: 'missing' });
      return;
    }
    if (list.length === 0) entries.push({ path: prefix, state: 'empty-dir' });
    for (const entry of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        entries.push({ path: relative, state: 'symlink', target: await readlink(absolute) });
        continue;
      }
      if (entry.isDirectory()) {
        entries.push({ path: relative, state: 'dir' });
        await walk(absolute, relative);
        continue;
      }
      const info = await stat(absolute);
      entries.push({ path: relative, state: 'file', size: info.size });
    }
  }
  await walk(directory, '');
  return entries;
}

/** 写一个会话日志占位（真宿主下是 zstd，这里只要能证明没被改写）。 */
export async function writeSessionLog(home, sessionId, text) {
  const directory = join(home, 'sessions', 'placeholder', sessionId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'session.v4.jsonl');
  await writeFile(path, text);
  return path;
}
