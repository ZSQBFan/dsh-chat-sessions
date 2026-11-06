/**
 * 生命周期协调器：把「账本（store）」和「原生宿主（host-adapter）」缝在一起。
 *
 * 三条硬规则，任何改动都不能破坏：
 *  1. **先落盘再动原生**：任何房间在调用原生删除/挂接之前，状态已经写进账本；
 *     进程在原生调用后崩溃，下次启动能凭 `DETACHING`/`RESTORING` 续跑。
 *  2. **冻结后才允许改原生**：`detach()` 一开始就把进程状态切到 `QUIESCING`，
 *     并在 `generation` 上 +1；之后所有插件写入口都拿不到闸门。
 *  3. **失败不吞**：每个房间的失败写进 `lastError`（固定 reasonCode），
 *     单房间失败不影响其它房间，也不阻止宿主完成卸载。
 *
 * 明确不做的：不在恢复时 mkdir、不搬动任务目录、不改标题软链接、不自动发消息、
 * 不自动取消归档、不接管用户停用期间新收编的会话。
 */
import {randomUUID} from 'node:crypto';
import path from 'node:path';

import {
  ELIGIBILITY,
  OPERATION_KIND,
  PROCESS_STATE,
  REASON,
  ROOM_STATE,
  classifyDirectory,
  classifyMember,
  createLedger,
  roomTransition,
  summarizeRooms,
} from './model.js';
import {
  DETACH_REASONS,
  HOST_CAPABILITY,
  UNLOAD,
  attachSessions,
  createWorkspace,
  deleteWorkspace,
  describeUnload,
  readRegistry,
  readSessionHeader,
  statDirectory,
} from './host-adapter.js';

/** 把任意异常压成账本里能长期保存的结构（不写堆栈、不写对话内容）。 */
function toErrorRecord(phase, error, reason = REASON.ATTACH_FAILED) {
  return {
    phase,
    code: typeof error?.code === 'string' && error.code !== '' ? error.code : reason,
    reason,
    message: typeof error?.message === 'string' ? error.message.slice(0, 300) : String(error).slice(0, 300),
    at: new Date().toISOString(),
  };
}

/** 目录 dev/ino 身份；拿不到就记 null，由 `classifyDirectory` 放行（不做伪否决）。 */
function directoryIdentityOf(stat) {
  if (stat === null || stat === undefined) return null;
  return {dev: String(stat.dev), ino: String(stat.ino)};
}

/** 账本房间的最小骨架。 */
function roomRecord({ownerSessionId, cwd, canonicalCwd, directoryIdentity, workspaceId}) {
  return {
    ownerSessionId,
    cwd,
    canonicalCwd,
    directoryIdentity,
    workspaceId,
    state: ROOM_STATE.MANAGED,
    sessionIds: ownerSessionId === '' ? [] : [ownerSessionId],
    operation: null,
    members: ownerSessionId === '' ? [] : [{sessionId: ownerSessionId, eligibility: ELIGIBILITY.ELIGIBLE}],
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export class LifecycleCoordinator {
  #ctx;
  #config;
  #store;
  #clock;
  #state = PROCESS_STATE.STARTING;
  #generation = 0;
  #inFlight = new Set();
  #frozen = false;
  #lastDetach = null;
  #diagnostics = [];
  #log;

  /**
   * @param {{ctx: object, config?: object, store: object, log?: Function, clock?: () => number}} options
   */
  constructor({ctx, config = {}, store, log = () => {}, clock = () => Date.now()}) {
    this.#ctx = ctx;
    this.#config = config;
    this.#store = store;
    this.#clock = clock;
    this.#log = log;
  }

  get state() {
    return this.#state;
  }

  get generation() {
    return this.#generation;
  }

  get frozen() {
    return this.#frozen;
  }

  get diagnostics() {
    return [...this.#diagnostics];
  }

  /** 只有 READY 且未冻结时，插件才接受新的写请求。 */
  canWrite() {
    return this.#state === PROCESS_STATE.READY && this.#frozen === false;
  }

  /**
   * 登记一个已接收的插件任务，供停用时排空。
   * 调用方负责在 `finally` 里 `settle()`；这里不杀 Agent 回合，只等它自己结束。
   * @param {Promise<unknown>} promise
   * @returns {Promise<unknown>} 原 promise，方便直接 `return track(...)`。
   */
  track(promise) {
    const guarded = Promise.resolve(promise).catch(() => {});
    this.#inFlight.add(guarded);
    guarded.finally(() => this.#inFlight.delete(guarded));
    return promise;
  }

  /** 等已接收的任务结束；超时只记录诊断，不阻塞宿主卸载。 */
  async drain({timeoutMs = 15_000} = {}) {
    if (this.#inFlight.size === 0) return {drained: true, pending: 0};
    const pending = [...this.#inFlight];
    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs, 'timeout'));
    const outcome = await Promise.race([Promise.allSettled(pending).then(() => 'settled'), timeout]);
    return {drained: outcome === 'settled', pending: this.#inFlight.size};
  }

  /** 读账本；坏账本返回 `null` 并把原因记进诊断，绝不静默重建。 */
  async #read() {
    try {
      return await this.#store.read();
    } catch (error) {
      this.#diagnostics.push({code: REASON.LEDGER_INVALID, message: String(error?.message ?? error).slice(0, 300)});
      return null;
    }
  }

  /** 写账本；失败只记录，不抛出到宿主。 */
  async #update(mutator, {required = false} = {}) {
    try {
      const result = await this.#store.update(mutator);
      return result;
    } catch (error) {
      const code = error?.code === 'LOCK_HELD' ? REASON.LOCK_HELD : REASON.LEDGER_WRITE_FAILED;
      this.#diagnostics.push({code, message: String(error?.message ?? error).slice(0, 300)});
      if (required) throw error;
      return null;
    }
  }

  /**
   * 启动：开账本 → 对账 creation intent → 恢复上次未完成的交接/恢复 → 开放写入口。
   * @returns {Promise<{ok: boolean, summary?: object, blocked?: string}>}
   */
  async start() {
    const ledger = await this.#read();
    if (this.#store.status === 'invalid') {
      this.#state = PROCESS_STATE.DEGRADED;
      return {ok: false, blocked: REASON.LEDGER_INVALID};
    }
    this.#generation = ledger?.generation ?? 0;
    this.#lastDetach = ledger?.process?.lastDetach ?? null;

    const reconcile = await this.#reconcileCreationIntents(ledger);
    const restore = await this.#restore(ledger);

    await this.#update((state) => {
      state.process = {...(state.process ?? {}), state: PROCESS_STATE.READY, lastDetach: this.#lastDetach};
      state.generation = this.#generation;
    });

    this.#state = PROCESS_STATE.READY;
    return {ok: true, summary: {...reconcile, ...restore, rooms: summarizeRooms(ledger?.rooms ?? [])}};
  }

  /**
   * 新建意图：先落 `PENDING` 再建原生对象。
   *
   * 崩溃在「落盘之后、原生创建之前」只会留下一条 `PENDING` 意图，下次启动由
   * `#reconcileCreationIntents` 判成 `ABANDONED`，不会把半成品当成房间。
   * @param {{sessionId: string, cwd: string, canonicalCwd?: string}} intent
   * @returns {Promise<{ok: boolean, intentId?: string}>}
   */
  async beginCreate({sessionId, cwd, canonicalCwd}) {
    if (!this.canWrite()) return {ok: false, code: 'LIFECYCLE_NOT_READY'};
    const canonical = canonicalCwd ?? cwd;
    const intentId = `intent-${sessionId}`;
    const result = await this.#update((state) => {
      state.creationIntents = (state.creationIntents ?? []).filter((entry) => entry.id !== intentId);
      state.creationIntents.push({
        id: intentId,
        ownerSessionId: sessionId,
        sessionId,
        cwd,
        canonicalCwd: canonical,
        state: 'PENDING',
        at: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      });
    });
    return {ok: result !== null, intentId};
  }

  /** 原生对象建成后收尾：登记房间并把意图标成 ADOPTED。 */
  async finishCreate({sessionId, cwd, canonicalCwd, workspaceId, directoryIdentity}) {
    const canonical = canonicalCwd ?? cwd;
    const result = await this.#update((state) => {
      state.creationIntents = (state.creationIntents ?? []).filter((entry) => entry.sessionId !== sessionId);
      const rooms = Array.isArray(state.rooms) ? state.rooms : [];
      const index = rooms.findIndex((room) => room.workspaceId === workspaceId);
      const room = roomRecord({ownerSessionId: sessionId, cwd, canonicalCwd: canonical, directoryIdentity, workspaceId});
      if (index === -1) rooms.push(room);
      else rooms[index] = {...rooms[index], ...room, state: ROOM_STATE.MANAGED, lastError: null};
      state.rooms = rooms;
    });
    return {ok: result !== null};
  }

  /** 原生创建失败：把意图删掉，不留半条记录。 */
  async abortCreate({sessionId}) {
    await this.#update((state) => {
      state.creationIntents = (state.creationIntents ?? []).filter((entry) => entry.sessionId !== sessionId);
    });
  }

  /** 启动对账：超过 10 分钟仍是 PENDING 的意图判为 ABANDONED（不猜结果、不重启创建）。 */
  async #reconcileCreationIntents(ledger) {
    const intents = Array.isArray(ledger?.creationIntents) ? ledger.creationIntents : [];
    if (intents.length === 0) return {intentsAbandoned: 0};
    const now = this.#clock();
    const stale = intents.filter((entry) => {
      const at = Date.parse(entry.createdAt ?? '');
      return Number.isFinite(at) && now - at > 10 * 60 * 1000;
    });
    if (stale.length === 0) return {intentsAbandoned: 0};
    const ids = new Set(stale.map((entry) => entry.id));
    await this.#update((state) => {
      for (const entry of state.creationIntents ?? []) if (ids.has(entry.id)) entry.state = 'ABANDONED';
    });
    return {intentsAbandoned: stale.length};
  }

  /**
   * 停用/卸载交接：冻结 → 排空 → 逐房间条件删除原生登记。
   *
   * 失败写进 `lastError` 并保留房间，下次启用时按 `DETACHING` 续跑；绝不抛出去。
   * @returns {Promise<{reason: string, detached: string[], skipped: string[], conflicts: string[], failed: string[]}>}
   */
  async detach({reason = null} = {}) {
    this.#frozen = true;
    this.#state = PROCESS_STATE.QUIESCING;
    this.#generation += 1;
    const drained = await this.drain();

    const resolved = reason ?? (await describeUnload(this.#ctx)).reason;
    const ledger = await this.#read();
    const result = {reason: resolved, detached: [], skipped: [], conflicts: [], failed: [], drained: drained.drained};

    if (ledger === null) {
      this.#state = PROCESS_STATE.DEGRADED;
      result.blocked = REASON.LEDGER_INVALID;
      return result;
    }
    if (!DETACH_REASONS.includes(resolved)) {
      // RELOAD / UNKNOWN：保留登记，只记一条诊断——这就是「普通重启不解绑」。
      await this.#update((state) => {
        state.process = {...(state.process ?? {}), state: PROCESS_STATE.DISPOSED};
        state.generation = this.#generation;
        state.process.lastDetach = {
          reason: resolved,
          operationId: `detach-${randomUUID()}`,
          at: new Date().toISOString(),
          outcome: 'skipped',
          skipped: true,
        };
      });
      this.#state = PROCESS_STATE.DISPOSED;
      return result;
    }

    const registry = await readRegistry(this.#ctx);
    if (registry.ok === false) {
      result.failed.push({code: registry.error?.code ?? REASON.REGISTRY_DELETE_FAILED});
      this.#state = PROCESS_STATE.DEGRADED;
      return result;
    }

    for (const room of ledger.rooms ?? []) {
      if (room.state !== ROOM_STATE.MANAGED && room.state !== ROOM_STATE.DETACHING && room.state !== ROOM_STATE.PARTIAL) {
        result.skipped.push(room.ownerSessionId);
        continue;
      }
      const live = registry.workspaces.find((workspace) => workspace.id === room.workspaceId);
      if (live === undefined) {
        // 登记已经不在了（用户自己删了，或上次删成功但没落盘）：直接补一条 DETACHED。
        await this.#transitionRoom(room.workspaceId, ROOM_STATE.DETACHED, {operation: null, error: null});
        result.detached.push(room.ownerSessionId);
        continue;
      }
      const own = new Set(room.sessionIds ?? []);
      const foreign = await this.#foreignMembers(room, live.sessionIds, own);
      if (foreign.length > 0) {
        // 外来成员：整个房间留登记，交给用户自己决定——这就是「用户收编优先」。
        await this.#transitionRoom(room.workspaceId, ROOM_STATE.CONFLICT, {
          error: {phase: 'detach', code: REASON.FOREIGN_MEMBERS, reason: REASON.FOREIGN_MEMBERS, at: new Date().toISOString(), members: foreign},
        });
        result.conflicts.push(room.ownerSessionId);
        continue;
      }

      const persisted = await this.#update((state) => {
        const index = (state.rooms ?? []).findIndex((entry) => entry.workspaceId === room.workspaceId);
        if (index === -1) return;
        state.rooms[index] = roomTransition(state.rooms[index], ROOM_STATE.DETACHING, {
          operation: {
            id: `detach-${randomUUID()}`,
            kind: OPERATION_KIND.DETACH,
            reason: resolved,
            from: state.rooms[index].state,
            to: ROOM_STATE.DETACHING,
            startedAt: new Date().toISOString(),
          },
          error: null,
        });
      });
      if (persisted === null) {
        result.failed.push({sessionId: room.ownerSessionId, code: REASON.LEDGER_WRITE_FAILED});
        continue;
      }

      // 原生没有「按快照条件删除」的原子入口，这里用「删除前最后一次复读」把窗口压到最小。
      const confirmation = await readRegistry(this.#ctx);
      const latest = confirmation.workspaces.find((workspace) => workspace.id === room.workspaceId);
      const lateForeign = latest === undefined ? [] : await this.#foreignMembers(room, latest.sessionIds, own);
      if (latest !== undefined && lateForeign.length > 0) {
        await this.#transitionRoom(room.workspaceId, ROOM_STATE.CONFLICT, {
          error: {phase: 'detach', code: REASON.FOREIGN_MEMBERS, reason: REASON.FOREIGN_MEMBERS, at: new Date().toISOString(), members: lateForeign},
        });
        result.conflicts.push(room.ownerSessionId);
        continue;
      }

      const removed = await deleteWorkspace(this.#ctx, room.workspaceId);
      if (removed.ok === false) {
        await this.#transitionRoom(room.workspaceId, ROOM_STATE.MANAGED, {
          error: toErrorRecord('detach', removed.error, REASON.REGISTRY_DELETE_FAILED),
        });
        result.failed.push({sessionId: room.ownerSessionId, code: removed.error?.code ?? REASON.REGISTRY_DELETE_FAILED});
        continue;
      }

      const after = await readRegistry(this.#ctx);
      const leftover = after.workspaces.some((workspace) => workspace.id === room.workspaceId);
      if (leftover) {
        await this.#transitionRoom(room.workspaceId, ROOM_STATE.DETACHING, {
          error: {phase: 'detach', code: REASON.REGISTRY_DELETE_FAILED, reason: REASON.REGISTRY_DELETE_FAILED, at: new Date().toISOString(), message: '登记仍存在'},
        });
        result.failed.push({sessionId: room.ownerSessionId, code: REASON.REGISTRY_DELETE_FAILED});
        continue;
      }
      await this.#transitionRoom(room.workspaceId, ROOM_STATE.DETACHED, {operation: null, error: null});
      result.detached.push(room.ownerSessionId);
    }

    this.#lastDetach = {
      reason: resolved,
      operationId: `detach-${randomUUID()}`,
      at: new Date().toISOString(),
      detached: result.detached.length,
      conflicts: result.conflicts.length,
      failed: result.failed.length,
      atomicGuard: HOST_CAPABILITY.conditionalDelete ? 'native' : 're-read-only',
    };
    await this.#update((state) => {
      state.process = {...(state.process ?? {}), state: PROCESS_STATE.DISPOSED, lastDetach: this.#lastDetach};
      state.generation = this.#generation;
    });
    this.#state = PROCESS_STATE.DISPOSED;
    this.#log({event: 'detach', ...result, lastDetach: this.#lastDetach});
    return result;
  }

  /** 单房间状态迁移（不存在则跳过）。 */
  /**
   * 房间里哪些成员「不是这个房间的」。
   *
   * 房间的身份是目录（R05：共享 cwd 按房间处理），所以判据不是「账本里有没有记过」，而是
   * 「它的 header.cwd 是不是这个房间的 canonical 路径」：
   * - 账本登记过的成员：自己人；
   * - 同目录的派生会话（宿主直接 create、继承了 cwd）：仍是这个房间的成员，不阻挡交接；
   * - 目录不同、或读不到 header 的未知成员：才是不确定归属的外来成员，整房间留登记。
   */
  async #foreignMembers(room, sessionIds, own) {
    const foreign = [];
    for (const sessionId of sessionIds) {
      if (own.has(sessionId)) continue;
      const header = await readSessionHeader(this.#ctx, sessionId);
      const cwd = header.ok === true ? header.header?.cwd : undefined;
      if (typeof cwd === 'string' && canonicalPath(cwd) === room.canonicalCwd) continue;
      foreign.push(sessionId);
    }
    return foreign;
  }

  async #transitionRoom(workspaceId, next, {operation, error} = {}) {
    await this.#update((state) => {
      const index = (state.rooms ?? []).findIndex((entry) => entry.workspaceId === workspaceId);
      if (index === -1) return;
      const options = {now: this.#clock()};
      if (operation !== undefined) options.operation = operation;
      if (error !== undefined) options.error = error;
      state.rooms[index] = roomTransition(state.rooms[index], next, options);
    });
  }

  /**
   * 恢复：只对「仍未分组、目录身份匹配、所有权明确」的旧房间重新登记并挂回成员。
   *
   * 顺序严格按设计 §10：目录分类（不 mkdir）→ 成员分类 → 落 RESTORING → 注册目录 →
   * 逐个 attach（每次前复查）→ 落终态。`RELEASED`（用户已收编）与 `CONFLICT`（目录/成员异常）
   * 都不会被强行改回 MANAGED。
   */
  async #restore(ledger) {
    const candidates = (ledger?.rooms ?? []).filter((room) =>
      room.state === ROOM_STATE.RESTORING || room.state === ROOM_STATE.DETACHED || room.state === ROOM_STATE.DETACHING);
    const summary = {restored: [], partial: [], released: [], conflicts: [], skipped: []};
    if (candidates.length === 0) return summary;

    const registry = await readRegistry(this.#ctx);
    if (registry.ok === false) {
      summary.blocked = REASON.LEDGER_WRITE_FAILED;
      return summary;
    }

    for (const room of candidates) {
      const stat = await statDirectory(room.cwd);
      const directory = classifyDirectory(room, stat);
      if (directory !== 'ok') {
        const reason = directory === 'missing' ? REASON.DIRECTORY_MISSING : REASON.DIRECTORY_IDENTITY_CHANGED;
        await this.#transitionRoom(room.workspaceId, ROOM_STATE.CONFLICT, {
          error: {phase: 'restore', code: reason, reason, at: new Date().toISOString()},
        });
        summary.conflicts.push(room.ownerSessionId);
        continue;
      }

      // 已被别的房间认领的成员一律不抢。
      const members = [];
      for (const sessionId of room.sessionIds ?? []) {
        const header = await readSessionHeader(this.#ctx, sessionId);
        const claimedBy = registry.claimedBy.get(sessionId) ?? null;
        const eligibility = classifyMember({header, claimedBy, canonicalCwd: room.canonicalCwd, workspaceId: room.workspaceId});
        members.push({sessionId, eligibility});
      }
      const eligible = members.filter((member) => member.eligibility === ELIGIBILITY.ELIGIBLE).map((member) => member.sessionId);
      const userOwned = members.filter((member) => member.eligibility === ELIGIBILITY.USER_OWNED);
      const conflicted = members.filter((member) => member.eligibility === ELIGIBILITY.CONFLICT || member.eligibility === ELIGIBILITY.MISSING_SESSION);

      if (eligible.length === 0 && userOwned.length > 0) {
        await this.#transitionRoom(room.workspaceId, ROOM_STATE.RELEASED, {
          error: {phase: 'restore', code: REASON.USER_CLAIMED, reason: REASON.USER_CLAIMED, at: new Date().toISOString()},
        });
        summary.released.push(room.ownerSessionId);
        continue;
      }
      if (eligible.length === 0) {
        await this.#transitionRoom(room.workspaceId, ROOM_STATE.CONFLICT, {
          error: {phase: 'restore', code: REASON.CWD_MISMATCH, reason: REASON.CWD_MISMATCH, at: new Date().toISOString()},
        });
        summary.conflicts.push(room.ownerSessionId);
        continue;
      }

      await this.#update((state) => {
        const index = (state.rooms ?? []).findIndex((entry) => entry.workspaceId === room.workspaceId);
        if (index === -1) return;
        state.rooms[index] = roomTransition(state.rooms[index], ROOM_STATE.RESTORING, {
          operation: {
            id: `restore-${randomUUID()}`,
            kind: OPERATION_KIND.RESTORE,
            from: state.rooms[index].state,
            to: ROOM_STATE.RESTORING,
            startedAt: new Date().toISOString(),
          },
          error: null,
        });
        state.rooms[index].members = members;
        state.rooms[index].directoryIdentity = directoryIdentityOf(stat) ?? state.rooms[index].directoryIdentity;
      });

      const live = registry.workspaces.find((workspace) => workspace.path === room.cwd);
      let workspaceId = live?.id ?? room.workspaceId;
      if (live === undefined) {
        const created = await createWorkspace(this.#ctx, room.cwd, room.cwd.split(path.sep).pop() ?? '');
        if (created.ok === false) {
          await this.#transitionRoom(room.workspaceId, ROOM_STATE.DETACHED, {
            error: toErrorRecord('restore', created.error, REASON.LEDGER_WRITE_FAILED),
          });
          summary.conflicts.push(room.ownerSessionId);
          continue;
        }
        workspaceId = created.workspaceId;
      }

      const attached = await attachSessions(this.#ctx, workspaceId, eligible);
      const failedIds = new Set(attached.failed.map((entry) => entry.sessionId));
      if (attached.missing) {
        await this.#transitionRoom(room.workspaceId, ROOM_STATE.DETACHED, {
          error: {phase: 'restore', code: REASON.ATTACH_FAILED, reason: REASON.ATTACH_FAILED, at: new Date().toISOString(), message: 'workspace missing after create'},
        });
        summary.conflicts.push(room.ownerSessionId);
        continue;
      }

      const allAttached = attached.attached.length === eligible.length;
      const nextState = allAttached && conflicted.length === 0 && userOwned.length === 0
        ? ROOM_STATE.MANAGED
        : allAttached ? ROOM_STATE.PARTIAL : ROOM_STATE.PARTIAL;
      await this.#update((state) => {
        const index = (state.rooms ?? []).findIndex((entry) => entry.workspaceId === room.workspaceId);
        if (index === -1) return;
        state.rooms[index] = roomTransition(state.rooms[index], nextState, {
          operation: null,
          error: failedIds.size > 0
            ? {phase: 'restore', code: REASON.ATTACH_FAILED, reason: REASON.ATTACH_FAILED, at: new Date().toISOString(), members: [...failedIds]}
            : null,
        });
        state.rooms[index].workspaceId = workspaceId;
        state.rooms[index].members = members.map((member) => ({
          ...member,
          eligibility: failedIds.has(member.sessionId) ? ELIGIBILITY.CONFLICT : ELIGIBILITY.ATTACHED,
        }));
      });
      if (nextState === ROOM_STATE.MANAGED) summary.restored.push(room.ownerSessionId);
      else summary.partial.push(room.ownerSessionId);
    }
    return summary;
  }

  /** 关账本（释放单 writer 锁）。卸载路径上必须调用，否则下次启动会撞 LOCK_HELD。 */
  async close() {
    try {
      await this.#store.close();
    } catch (error) {
      this.#diagnostics.push({code: REASON.LEDGER_WRITE_FAILED, message: String(error?.message ?? error).slice(0, 300)});
    }
  }

  /** 前端消费的托管集合：只含本插件仍在管的房间，不做路径形状推断。 */
  managedSets(ledger) {
    const rooms = Array.isArray(ledger?.rooms) ? ledger.rooms : [];
    const workspaceIds = [];
    const sessionIds = [];
    for (const room of rooms) {
      if (room.state !== ROOM_STATE.MANAGED && room.state !== ROOM_STATE.PARTIAL && room.state !== ROOM_STATE.RESTORING) continue;
      if (typeof room.workspaceId === 'string' && room.workspaceId !== '') workspaceIds.push(room.workspaceId);
      for (const sessionId of room.sessionIds ?? []) sessionIds.push(sessionId);
    }
    return {workspaceIds, sessionIds};
  }

  /**
   * 这个会话是不是本插件仍在管的房间成员（或正处在创建意图里）。
   *
   * `sweep()`/`ensureSessionWorkspace()` 用它做闸门：未经账本确认的会话——包括用户自己
   * 建的普通工作区会话、子代理会话、停用期间被收编的会话——都不许被这条路径重建目录或补登记。
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async ownsSession(sessionId) {
    const ledger = await this.#read();
    if (ledger === null) return false;
    const inIntent = (ledger.creationIntents ?? []).some((entry) => entry.sessionId === sessionId);
    if (inIntent) return true;
    return (ledger.rooms ?? []).some((room) =>
      (room.sessionIds ?? []).includes(sessionId) || room.ownerSessionId === sessionId);
  }

  /** 供 HTTP status 使用的摘要（不含任何对话内容）。 */
  async describe() {
    const ledger = await this.#read();
    return {
      state: this.#state,
      generation: this.#generation,
      frozen: this.#frozen,
      capability: HOST_CAPABILITY,
      rooms: summarizeRooms(ledger?.rooms ?? []),
      managed: ledger === null ? {workspaceIds: [], sessionIds: []} : this.managedSets(ledger),
      lastDetach: ledger?.process?.lastDetach ?? this.#lastDetach,
      diagnostics: this.diagnostics,
      clock: new Date(this.#clock()).toISOString(),
    };
  }
}

export {UNLOAD, DETACH_REASONS};
