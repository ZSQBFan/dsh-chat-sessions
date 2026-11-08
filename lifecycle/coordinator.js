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
import {realpath} from 'node:fs/promises';
import path from 'node:path';

import {
  ELIGIBILITY,
  OPERATION_KIND,
  PROCESS_STATE,
  REASON,
  ROOM_STATE,
  canonicalPath,
  classifyDirectory,
  classifyMember,
  createLedger,
  isSubagentHeader,
  roomTransition,
  summarizeRooms,
} from './model.js';
import {auditLegacyRooms, legacyRoomDraft} from './legacy.js';
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

/**
 * 从 header 里取 cwd。
 *
 * `host-adapter.readSessionHeader()` 返回的是**裸 header**（宿主 `persistence.stat()` 的 `header` 字段）；
 * 历史调用方还写过 `{ok, header}` 包装。这里两种都认，避免因为形状不一致把同房间的派生会话
 * 误判成外来成员（验收 F01）。
 * @param {object|null|undefined} header
 * @returns {string|undefined}
 */
function headerCwd(header) {
  if (header === null || header === undefined || typeof header !== 'object') return undefined;
  const raw = header.ok !== undefined && header.header !== undefined ? header.header : header;
  return typeof raw?.cwd === 'string' ? raw.cwd : undefined;
}

async function canonicalExistingPath(value) {
  const canonical = canonicalPath(value ?? '');
  if (canonical === '') return canonical;
  try { return canonicalPath(await realpath(canonical)); } catch { return canonical; }
}

async function sameExistingPath(left, right) {
  const [a, b] = await Promise.all([canonicalExistingPath(left), canonicalExistingPath(right)]);
  return a !== '' && a === b;
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
    members: ownerSessionId === '' ? [] : [{sessionId: ownerSessionId, eligibility: ELIGIBILITY.ATTACHED}],
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
  #identity;
  #log;

  /**
   * @param {{ctx: object, config?: object, store: object, log?: Function, clock?: () => number}} options
   */
  constructor({ctx, config = {}, store, identity = {}, log = () => {}, clock = () => Date.now()}) {
    this.#ctx = ctx;
    this.#config = config;
    this.#store = store;
    this.#clock = clock;
    this.#log = log;
    // 旧数据迁移要用与账本同源的 scope 身份（root / profile / DSH_HOME），不能用端口或时间冒充。
    this.#identity = {
      root: identity.root ?? config.root ?? '',
      profileId: identity.profileId ?? 'unknown-profile',
      dshHome: identity.dshHome ?? '',
      pluginId: identity.pluginId ?? 'dsh-chat-sessions',
    };
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
   * 关键路径写账本：失败时必须让调用方知道，不能像 `#update` 那样返回 null 了事。
   * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
   */
  async #updateRequired(mutator) {
    try {
      await this.#store.update(mutator);
      return {ok: true};
    } catch (error) {
      const code = error?.code === 'LOCK_HELD' ? 'LOCK_HELD' : (typeof error?.code === 'string' && error.code !== '' ? error.code : 'LEDGER_WRITE_FAILED');
      this.#diagnostics.push({code, message: String(error?.message ?? error).slice(0, 300)});
      return {ok: false, code, message: String(error?.message ?? error).slice(0, 300)};
    }
  }

  /**
   * 元数据不可靠时停止自动写：进程状态降到 DEGRADED，`canWrite()` 随之为 false。
   * 已接收的请求按各自语义回报失败，不假装成功（验收 F04 / R16）。
   */
  degrade(code = REASON.LEDGER_WRITE_FAILED, message = '') {
    this.#state = PROCESS_STATE.DEGRADED;
    this.#frozen = false;
    this.#diagnostics.push({code, message: String(message).slice(0, 300)});
  }

  /**
   * 启动：开账本 → 对账 creation intent → 恢复上次未完成的交接/恢复 → 开放写入口。
   * @returns {Promise<{ok: boolean, summary?: object, blocked?: string}>}
   */
  async start() {
    const ledger = await this.#read();
    if (this.#store.recoveryState === 'blocked') {
      this.degrade(REASON.RECOVERY_BLOCKED, '账本历史恢复未完成，禁止开放生命周期写入口');
      return {ok: false, blocked: REASON.RECOVERY_BLOCKED};
    }
    if (this.#store.status === 'invalid') {
      this.#state = PROCESS_STATE.DEGRADED;
      return {ok: false, blocked: REASON.LEDGER_INVALID};
    }
    this.#generation = ledger?.generation ?? 0;
    this.#lastDetach = ledger?.process?.lastDetach ?? null;

    const migration = await this.#migrateLegacy(ledger);
    if (migration.blocked !== undefined) {
      // 迁移失败时状态已经是 DEGRADED，不能再被后面的 READY 写入覆盖。
      return {ok: false, blocked: migration.blocked};
    }
    let current = await this.#read();
    if (current === null && this.#store.status !== undefined && this.#store.status !== 'absent') {
      this.degrade(REASON.LEDGER_INVALID, '迁移后账本不可读');
      return {ok: false, blocked: REASON.LEDGER_INVALID};
    }
    const reconcile = await this.#reconcileCreationIntents(current);
    if (reconcile.blocked !== undefined) {
      this.#state = PROCESS_STATE.DEGRADED;
      await this.#updateRequired((state) => {
        state.process = {...(state.process ?? {}), state: PROCESS_STATE.DEGRADED, lastDetach: this.#lastDetach};
        state.generation = this.#generation;
      });
      return {ok: false, blocked: reconcile.blocked, summary: {...migration, ...reconcile}};
    }
    current = await this.#read();
    if (current === null && this.#store.status !== undefined && this.#store.status !== 'absent') {
      this.degrade(REASON.LEDGER_INVALID, '创建意图对账后账本不可读');
      return {ok: false, blocked: REASON.LEDGER_INVALID};
    }
    const restore = await this.#restore(current);
    const summary = {...migration, ...reconcile, ...restore, rooms: summarizeRooms(current?.rooms ?? [])};

    // 恢复阶段读不到原生登记 / 写不进账本时不能对外宣告 READY：那会让插件在没有恢复依据的
    // 情况下继续接受新建与复用（验收 K04 / R07）。
    if (restore.blocked !== undefined) {
      this.#state = PROCESS_STATE.DEGRADED;
      const degraded = await this.#updateRequired((state) => {
        state.process = {...(state.process ?? {}), state: PROCESS_STATE.DEGRADED, lastDetach: this.#lastDetach};
        state.generation = this.#generation;
      });
      return {ok: false, blocked: restore.blocked ?? degraded.code, summary};
    }

    const ready = await this.#updateRequired((state) => {
      state.process = {...(state.process ?? {}), state: PROCESS_STATE.READY, lastDetach: this.#lastDetach};
      state.generation = this.#generation;
    });
    if (ready.ok === false) {
      this.#state = PROCESS_STATE.DEGRADED;
      return {ok: false, blocked: ready.code ?? REASON.LEDGER_WRITE_FAILED, summary};
    }

    this.#state = PROCESS_STATE.READY;
    return {ok: true, summary};
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
    // 意图必须真的落盘：写不进去就不许再建原生对象（验收 F04 / R10）。
    const result = await this.#updateRequired((state) => {
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
    if (result.ok === false) return {ok: false, code: result.code, intentId};
    return {ok: true, intentId};
  }

  /** 原生对象建成后收尾：登记房间并把意图标成 ADOPTED。 */
  async finishCreate({sessionId, cwd, canonicalCwd, workspaceId, directoryIdentity}) {
    const canonical = canonicalCwd ?? cwd;
    // 收尾写失败不能静默：意图保留在账本里，调用方据此把进程切 DEGRADED 并如实回报。
    const result = await this.#updateRequired((state) => {
      state.creationIntents = (state.creationIntents ?? []).filter((entry) => entry.sessionId !== sessionId);
      const rooms = Array.isArray(state.rooms) ? state.rooms : [];
      const index = rooms.findIndex((room) => room.workspaceId === workspaceId);
      const room = roomRecord({ownerSessionId: sessionId, cwd, canonicalCwd: canonical, directoryIdentity, workspaceId});
      if (index === -1) rooms.push(room);
      else rooms[index] = {...rooms[index], ...room, state: ROOM_STATE.MANAGED, lastError: null};
      state.rooms = rooms;
    });
    if (result.ok === false) return {ok: false, code: result.code};
    return {ok: true};
  }

  /** 原生创建失败：把意图删掉，不留半条记录。 */
  async abortCreate({sessionId}) {
    await this.#update((state) => {
      state.creationIntents = (state.creationIntents ?? []).filter((entry) => entry.sessionId !== sessionId);
    });
  }

  /**
   * 首次升级迁移：账本里还没有房间、也还没有完成过迁移时，用多证据只读审计认领旧房间。
   *
   * 这是「旧版本房间也能被交接」的唯一入口（K01）。判据全部来自 `legacy.js` 的三方证据
   * （registry 登记 + 真实目录 + session header），证据不足的房间不认领、只留诊断；
   * 迁移完成后写 `migration.completed` 作为可验证标记，账本后来丢失不会静默重跑。
   * @returns {Promise<{legacy?: object}>}
   */
  /** 显式补接管已审计的旧登记；不重置迁移标记，不接管未指定或已释放的房间。 */
  async recoverLegacy({workspaceIds} = {}) {
    if (!this.canWrite()) return {ok: false, blocked: 'LIFECYCLE_NOT_READY'};
    if (!Array.isArray(workspaceIds) || workspaceIds.length === 0 || workspaceIds.length > 100
      || workspaceIds.some((id) => typeof id !== 'string' || id === '')) {
      return {ok: false, blocked: 'WORKSPACE_IDS_REQUIRED'};
    }
    const generation = this.#generation;
    this.#frozen = true;
    try {
      const ledger = await this.#read();
      if (ledger === null || this.#store.status === 'invalid' || this.#store.recoveryState === 'blocked') {
        this.degrade(REASON.LEDGER_INVALID, 'legacy recovery requires a valid existing ledger');
        return {ok: false, blocked: REASON.LEDGER_INVALID};
      }
      const result = await this.#migrateLegacy(ledger, {workspaceIds: new Set(workspaceIds)});
      return {ok: result.blocked === undefined, ...result};
    } finally {
      if (this.#state === PROCESS_STATE.READY && this.#generation === generation) this.#frozen = false;
    }
  }

  async #migrateLegacy(ledger, {workspaceIds = null} = {}) {
    const rooms = Array.isArray(ledger?.rooms) ? ledger.rooms : [];
    if (workspaceIds === null && rooms.length > 0) return {};
    if (workspaceIds === null && ledger?.migration?.completed === true) return {};
    if (this.#identity.root === '' || this.#identity.dshHome === '') return {};

    let audit;
    /** 迁移时看到的原生成员表：用来把「本来就在房间里」的成员标成 attached。 */
    const attachedByWorkspace = new Map();
    try {
      audit = await auditLegacyRooms({
        root: this.#identity.root,
        dshHome: this.#identity.dshHome,
        profileId: this.#identity.profileId,
        pluginId: this.#identity.pluginId,
        recordedIdentities: [],
        detect: {
          // legacy 审计要的是 {header, logPath} 信封，host-adapter 给的是裸 header。
          readSessionHeader: async (sessionId) => {
            const header = await readSessionHeader(this.#ctx, sessionId);
            return header === null ? null : {header, logPath: null, logFound: true};
          },
          listRegistry: async () => {
            const registry = await readRegistry(this.#ctx);
            if (registry.ok === false) return null;
            for (const workspace of registry.workspaces) {
              attachedByWorkspace.set(workspace.id, new Set(workspace.sessionIds ?? []));
            }
            return {workspaces: registry.workspaces, archivedSessionIds: []};
          },
          // 走到这里就说明「账本里没有房间、迁移也没完成」，对审计而言等同一个全新的
          // 安装：若把 ledgerExists 报成 true，审计会把每个旧房间都判成 LEDGER_PRESENT
          // 而永远不认领（v0.1.1 升级就彻底失效）。真正的「账本丢失」由 store 的初始化
          // 标记拦在更外层，不会走到这里。
          readScopeState: async () => ({ledgerExists: false, migrationCompleted: false}),
        },
      });
    } catch (error) {
      this.degrade(REASON.LEDGER_WRITE_FAILED, `legacy audit failed: ${String(error?.message ?? error).slice(0, 200)}`);
      return {blocked: REASON.LEDGER_WRITE_FAILED};
    }

    // 显式恢复也须走完整三方审计；已有账本条目（包括 RELEASED/CONFLICT）是持久决定，
    // 不得因路径相同就再次认领。审计后复读成员与目录身份，过期结果留待重试。
    const registry = await readRegistry(this.#ctx);
    if (registry.ok === false || audit.scope?.registryAvailable === false) {
      this.degrade(REASON.LEDGER_WRITE_FAILED, 'legacy registry unavailable');
      return {blocked: REASON.LEDGER_WRITE_FAILED};
    }
    const drafts = [];
    const skipped = [];
    for (const room of audit.adoptable ?? []) {
      if (workspaceIds !== null && !workspaceIds.has(room.workspaceId)) continue;
      if (rooms.some((known) => known.workspaceId === room.workspaceId || known.canonicalCwd === room.canonicalCwd)) continue;
      const draft = legacyRoomDraft(room, {now: this.#clock()});
      if (draft === null || typeof draft.workspaceId !== 'string' || draft.workspaceId === '') continue;
      const live = registry.workspaces.find((entry) => entry.id === draft.workspaceId);
      const previousMembers = attachedByWorkspace.get(draft.workspaceId) ?? new Set();
      const info = await statDirectory(draft.canonicalCwd);
      if (live === undefined || !(await sameExistingPath(live.path, draft.canonicalCwd))
        || live.sessionIds.length !== previousMembers.size || live.sessionIds.some((id) => !previousMembers.has(id))
        || classifyDirectory(draft, info) !== 'ok') {
        skipped.push({workspaceId: draft.workspaceId, reason: 'EVIDENCE_CHANGED'});
        continue;
      }
      const qualified = await this.#qualifyMembers({sessionIds: live.sessionIds, ownerSessionId: draft.ownerSessionId,
        canonicalCwd: draft.canonicalCwd, workspaceId: draft.workspaceId, registry});
      if (!qualified.ownerQualified) { skipped.push({workspaceId: draft.workspaceId, reason: 'OWNER_NOT_ELIGIBLE'}); continue; }
      // 只对合格成员标 attached，不能把审计排除的子代理重新提升为托管成员。
      draft.members = qualified.members.map((member) => ({...member, eligibility: ELIGIBILITY.ATTACHED}));
      draft.sessionIds = draft.members.map((member) => member.sessionId);
      drafts.push(draft);
    }
    const ambiguous = (audit.rooms ?? []).filter((room) => room.classification === 'ambiguous').length;
    const rejected = (audit.rejected ?? []).length;
    const evidence = {
      auditAt: new Date(this.#clock()).toISOString(),
      adopted: drafts.length,
      ambiguous,
      rejected,
      roomsSeen: (audit.rooms ?? []).length,
      skipped,
      ...(workspaceIds === null ? {} : {requested: [...workspaceIds]}),
    };
    // 有歧义证据时仍记为「已审计」，否则每次启动都会重扫；歧义房间只留计数，不猜归属。
    const result = await this.#updateRequired((state) => {
      state.rooms = Array.isArray(state.rooms) ? state.rooms : [];
      const known = new Set(state.rooms.map((room) => room.workspaceId));
      const knownPaths = new Set(state.rooms.map((room) => room.canonicalCwd));
      for (const draft of drafts) {
        if (known.has(draft.workspaceId) || knownPaths.has(draft.canonicalCwd)) continue;
        state.rooms.push(draft); known.add(draft.workspaceId); knownPaths.add(draft.canonicalCwd);
      }
      if (workspaceIds === null) {
        state.migration = {version: 1, completed: true, at: new Date(this.#clock()).toISOString(), evidence};
      } else {
        state.migration = {...state.migration, evidence: {...(state.migration?.evidence ?? {}), lastRecovery: evidence}};
      }
    });
    if (result.ok === false) {
      // 迁移没落盘就不能让启动流程继续走到 READY：旧房间还没有可靠的管理依据（复审 R2-F03）。
      this.degrade(result.code ?? REASON.LEDGER_WRITE_FAILED, 'legacy migration could not be persisted');
      return {blocked: result.code ?? REASON.LEDGER_WRITE_FAILED};
    }
    if (drafts.length > 0) this.#log({event: 'legacy-migrated', ...evidence});
    return {legacy: evidence};
  }

  async #qualifyMembers({sessionIds, ownerSessionId, canonicalCwd, workspaceId, registry}) {
    const comparisonCwd = await canonicalExistingPath(canonicalCwd);
    const members = [];
    const rejected = [];
    for (const sessionId of sessionIds ?? []) {
      const header = await readSessionHeader(this.#ctx, sessionId);
      const claimedBy = registry.claimedBy.get(sessionId) ?? null;
      const eligibility = classifyMember({
        header,
        claimedBy,
        isSubagent: isSubagentHeader(header),
        canonicalCwd: comparisonCwd,
        workspaceId,
      });
      if (eligibility === ELIGIBILITY.ELIGIBLE) {
        members.push({
          sessionId,
          eligibility: sessionId === ownerSessionId ? ELIGIBILITY.ATTACHED : ELIGIBILITY.ELIGIBLE,
        });
      } else {
        rejected.push({sessionId, eligibility});
      }
    }
    return {
      members,
      rejected,
      ownerQualified: members.some((member) => member.sessionId === ownerSessionId),
    };
  }

  /**
   * 启动对账：PENDING 意图必须先看原生事实，再决定收敛方式（复审 R2-F04）。
   *
   * 「原生对象已建成、只是收尾没落盘」是现实中间态：把已经存在的房间补进账本，
   * 否则插件对该 Workspace 一无所知，停用时也无法解除登记（R01/R10/R17）。
   * - 登记里有这个 cwd 且成员含该会话 → 补成 MANAGED 房间，意图 ADOPTED；
   * - 只有会话、没有登记 → 意图 ABANDONED（未分组会话本来就不需要交接）；
   * - 什么都没有且已过 10 分钟 → ABANDONED；其余保持 PENDING 等下一次启动。
   */
  async #reconcileCreationIntents(ledger) {
    const intents = Array.isArray(ledger?.creationIntents) ? ledger.creationIntents : [];
    if (intents.length === 0) return {intentsAbandoned: 0, intentsAdopted: 0};
    const registry = await readRegistry(this.#ctx);
    if (registry.ok === false) {
      // 读不到原生登记就无法判断「对象是否已建成」，不能猜：直接停写。
      this.degrade(REASON.LEDGER_WRITE_FAILED, 'creation intents could not be reconciled: registry unreadable');
      return {blocked: REASON.LEDGER_WRITE_FAILED};
    }
    const now = this.#clock();
    const adopted = [];
    const abandoned = [];
    for (const entry of intents) {
      if (entry.state !== 'PENDING') continue;
      const canonical = typeof entry.canonicalCwd === 'string' && entry.canonicalCwd !== ''
        ? entry.canonicalCwd
        : canonicalPath(entry.cwd ?? '');
      let room;
      for (const workspace of registry.workspaces) {
        if (typeof workspace.path !== 'string' || !Array.isArray(workspace.sessionIds) || !workspace.sessionIds.includes(entry.sessionId)) continue;
        if (await sameExistingPath(workspace.path, canonical)) {
          room = workspace;
          break;
        }
      }
      if (room !== undefined) {
        const stat = await statDirectory(entry.cwd);
        const qualified = await this.#qualifyMembers({
          sessionIds: room.sessionIds,
          ownerSessionId: entry.sessionId,
          canonicalCwd: canonical,
          workspaceId: room.id,
          registry,
        });
        // owner 不满足资格时保留 PENDING，等待下一次原生快照，而不是猜测 ADOPTED。
        if (!qualified.ownerQualified) continue;
        adopted.push({
          entry,
          workspaceId: room.id,
          directoryIdentity: directoryIdentityOf(stat),
          members: qualified.members,
        });
        continue;
      }
      const header = await readSessionHeader(this.#ctx, entry.sessionId);
      const sessionCwd = headerCwd(header);
      const sessionExists = typeof sessionCwd === 'string' && sessionCwd !== '';
      const at = Date.parse(entry.createdAt ?? entry.at ?? '');
      if (sessionExists || (Number.isFinite(at) && now - at > 10 * 60 * 1000)) abandoned.push(entry);
    }
    for (const item of adopted) {
      const fresh = await readRegistry(this.#ctx);
      if (fresh.ok === false) {
        this.degrade(REASON.LEDGER_WRITE_FAILED, 'creation intent workspace changed: registry unreadable');
        return {blocked: REASON.LEDGER_WRITE_FAILED};
      }
      const current = fresh.workspaces.find((workspace) => workspace.id === item.workspaceId);
      if (current === undefined
        || !Array.isArray(current.sessionIds)
        || !current.sessionIds.includes(item.entry.sessionId)
        || typeof current.path !== 'string'
        || !(await sameExistingPath(current.path, item.entry.cwd))) {
        this.degrade(REASON.LEDGER_WRITE_FAILED, 'creation intent workspace changed before adoption');
        return {blocked: REASON.LEDGER_WRITE_FAILED};
      }
    }
    if (adopted.length === 0 && abandoned.length === 0) return {intentsAbandoned: 0, intentsAdopted: 0};

    const adoptedIds = new Set(adopted.map((item) => item.entry.id));
    const abandonedIds = new Set(abandoned.map((entry) => entry.id));
    const written = await this.#updateRequired((state) => {
      state.rooms = Array.isArray(state.rooms) ? state.rooms : [];
      const known = new Set(state.rooms.map((room) => room.workspaceId));
      for (const item of adopted) {
        if (known.has(item.workspaceId)) continue;
        const room = roomRecord({
          ownerSessionId: item.entry.sessionId,
          cwd: item.entry.cwd,
          canonicalCwd: item.entry.canonicalCwd ?? item.entry.cwd,
          directoryIdentity: item.directoryIdentity,
          workspaceId: item.workspaceId,
        });
        room.members = item.members;
        room.sessionIds = item.members.map((member) => member.sessionId);
        state.rooms.push(room);
        known.add(item.workspaceId);
      }
      for (const entry of state.creationIntents ?? []) {
        if (adoptedIds.has(entry.id)) entry.state = 'ADOPTED';
        else if (abandonedIds.has(entry.id)) entry.state = 'ABANDONED';
      }
      // 意图本身保留（只改状态）：它是「这次收尾为什么没落盘」的审计证据，删掉就查不到了。
    });
    if (written.ok === false) {
      this.degrade(written.code ?? REASON.LEDGER_WRITE_FAILED, 'creation intents could not be persisted');
      return {blocked: written.code ?? REASON.LEDGER_WRITE_FAILED};
    }
    if (adopted.length > 0) this.#log({event: 'creation-intents-adopted', count: adopted.length});
    return {intentsAbandoned: abandoned.length, intentsAdopted: adopted.length};
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
      if (room.state !== ROOM_STATE.MANAGED
        && room.state !== ROOM_STATE.DETACHING
        && room.state !== ROOM_STATE.PARTIAL
        && room.state !== ROOM_STATE.RESTORING) {
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
      const derived = await this.#derivedMembers(room, live.sessionIds, own);
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
        // 同目录派生会话在交接前补进账本：它们和 owner 是同一个房间（R05），
        // 不补的话「原生 create 出来的第二会话」下次又会被当陌生人。
        if (derived.length > 0) {
          const known = new Set(state.rooms[index].sessionIds ?? []);
          const merged = [...known, ...derived.filter((sessionId) => !known.has(sessionId))];
          state.rooms[index].sessionIds = merged;
          const memberIds = new Set((state.rooms[index].members ?? []).map((member) => member.sessionId));
          state.rooms[index].members = [
            ...(state.rooms[index].members ?? []),
            ...derived.filter((sessionId) => !memberIds.has(sessionId)).map((sessionId) => ({sessionId, eligibility: ELIGIBILITY.ELIGIBLE})),
          ];
        }
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

      // 最后确认里看到的新同目录成员必须先进账本，再删登记：否则「已经读到、却没记下」
      // 的成员会在重新启用时丢掉（复审 R2-F06）。这一步写失败就不删。
      const knownIds = new Set([...(room.sessionIds ?? []), ...derived]);
      const lateDerived = latest === undefined ? [] : await this.#derivedMembers(room, latest.sessionIds, knownIds);
      if (lateDerived.length > 0) {
        const recorded = await this.#updateRequired((state) => {
          const index = (state.rooms ?? []).findIndex((entry) => entry.workspaceId === room.workspaceId);
          if (index === -1) return;
          const roomIds = new Set(state.rooms[index].sessionIds ?? []);
          for (const sessionId of lateDerived) roomIds.add(sessionId);
          state.rooms[index].sessionIds = [...roomIds];
          const memberIds = new Set((state.rooms[index].members ?? []).map((member) => member.sessionId));
          state.rooms[index].members = [
            ...(state.rooms[index].members ?? []),
            ...lateDerived.filter((sessionId) => !memberIds.has(sessionId)).map((sessionId) => ({sessionId, eligibility: ELIGIBILITY.ELIGIBLE})),
          ];
        });
        if (recorded.ok === false) {
          result.failed.push({sessionId: room.ownerSessionId, code: recorded.code ?? REASON.LEDGER_WRITE_FAILED});
          continue;
        }
        result.lateMembers = [...(result.lateMembers ?? []), ...lateDerived];
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
      // 子代理与宿主共享 cwd，但它不归插件托管（R14）：既不算外来成员，也不补账。
      if (isSubagentHeader(header)) continue;
      const cwd = headerCwd(header);
      if (typeof cwd === 'string' && await sameExistingPath(cwd, room.canonicalCwd)) continue;
      foreign.push(sessionId);
    }
    return foreign;
  }

  /**
   * 房间实际成员里，同目录派生出来、但账本还没记过的会话。
   *
   * 宿主允许直接 `sessionController.create({workspaceId})`，这类会话与房间同 cwd，属于同一个
   * 房间（R05），必须补进账本，否则下次停用又会把它们当陌生人（验收 F01 的后半句）。
   * @returns {Promise<string[]>}
   */
  async #derivedMembers(room, sessionIds, own) {
    const derived = [];
    for (const sessionId of sessionIds) {
      if (own.has(sessionId)) continue;
      const header = await readSessionHeader(this.#ctx, sessionId);
      if (isSubagentHeader(header)) continue;
      const cwd = headerCwd(header);
      if (typeof cwd === 'string' && await sameExistingPath(cwd, room.canonicalCwd)) derived.push(sessionId);
    }
    return derived;
  }

  async #transitionRoom(workspaceId, next, {operation, error} = {}) {
    return this.#update((state) => {
      const index = (state.rooms ?? []).findIndex((entry) => entry.workspaceId === workspaceId);
      if (index === -1) return;
      const options = {now: this.#clock()};
      if (operation !== undefined) options.operation = operation;
      if (error !== undefined) options.error = error;
      state.rooms[index] = roomTransition(state.rooms[index], next, options);
    });
  }

  async #transitionRoomRequired(workspaceId, next, options = {}) {
    const result = await this.#updateRequired((state) => {
      const index = (state.rooms ?? []).findIndex((entry) => entry.workspaceId === workspaceId);
      if (index === -1) return;
      const transition = {now: this.#clock()};
      if (options.operation !== undefined) transition.operation = options.operation;
      if (options.error !== undefined) transition.error = options.error;
      state.rooms[index] = roomTransition(state.rooms[index], next, transition);
    });
    if (result.ok === false) this.degrade(result.code ?? REASON.LEDGER_WRITE_FAILED, 'restore room transition could not be persisted');
    return result;
  }

  /**
   * 恢复：只对「仍未分组、目录身份匹配、所有权明确」的旧房间重新登记并挂回成员。
   *
   * 顺序严格按设计 §10：目录分类（不 mkdir）→ 成员分类 → 落 RESTORING → 注册目录 →
   * 逐个 attach（每次前复查）→ 落终态。`RELEASED`（用户已收编）与 `CONFLICT`（目录/成员异常）
   * 都不会被强行改回 MANAGED。
   */
  async #restore(ledger) {
    // PARTIAL 也要进候选：上次某成员临时挂载失败时，下一次启用必须能把它补齐（复审 R2-F08）。
    const candidates = (ledger?.rooms ?? []).filter((room) =>
      room.state === ROOM_STATE.RESTORING
      || room.state === ROOM_STATE.DETACHED
      || room.state === ROOM_STATE.DETACHING
      || room.state === ROOM_STATE.PARTIAL);
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
        const transitioned = await this.#transitionRoomRequired(room.workspaceId, ROOM_STATE.CONFLICT, {
          error: {phase: 'restore', code: reason, reason, at: new Date().toISOString()},
        });
        if (transitioned.ok === false) {
          summary.blocked = transitioned.code ?? REASON.LEDGER_WRITE_FAILED;
          return summary;
        }
        summary.conflicts.push(room.ownerSessionId);
        continue;
      }

      // 已被别的房间认领的成员一律不抢。
      const comparisonCwd = await canonicalExistingPath(room.canonicalCwd);
      const members = [];
      for (const sessionId of room.sessionIds ?? []) {
        const header = await readSessionHeader(this.#ctx, sessionId);
        const claimedBy = registry.claimedBy.get(sessionId) ?? null;
        const eligibility = classifyMember({
          header,
          claimedBy,
          isSubagent: isSubagentHeader(header),
          canonicalCwd: comparisonCwd,
          workspaceId: room.workspaceId,
        });
        members.push({sessionId, eligibility});
      }
      const eligible = members.filter((member) => member.eligibility === ELIGIBILITY.ELIGIBLE).map((member) => member.sessionId);
      const userOwned = members.filter((member) => member.eligibility === ELIGIBILITY.USER_OWNED);
      const conflicted = members.filter((member) => member.eligibility === ELIGIBILITY.CONFLICT || member.eligibility === ELIGIBILITY.MISSING_SESSION);

      // 已经没有可重试成员（都挂上了或都成了用户收编）：保持原状，不把 PARTIAL 降级成 CONFLICT。
      if (room.state === ROOM_STATE.PARTIAL && eligible.length === 0) {
        summary.skipped.push(room.ownerSessionId);
        continue;
      }
      if (eligible.length === 0 && userOwned.length > 0) {
        const transitioned = await this.#transitionRoomRequired(room.workspaceId, ROOM_STATE.RELEASED, {
          error: {phase: 'restore', code: REASON.USER_CLAIMED, reason: REASON.USER_CLAIMED, at: new Date().toISOString()},
        });
        if (transitioned.ok === false) {
          summary.blocked = transitioned.code ?? REASON.LEDGER_WRITE_FAILED;
          return summary;
        }
        summary.released.push(room.ownerSessionId);
        continue;
      }
      if (eligible.length === 0) {
        const transitioned = await this.#transitionRoomRequired(room.workspaceId, ROOM_STATE.CONFLICT, {
          error: {phase: 'restore', code: REASON.CWD_MISMATCH, reason: REASON.CWD_MISMATCH, at: new Date().toISOString()},
        });
        if (transitioned.ok === false) {
          summary.blocked = transitioned.code ?? REASON.LEDGER_WRITE_FAILED;
          return summary;
        }
        summary.conflicts.push(room.ownerSessionId);
        continue;
      }

      // 恢复意图必须真的落盘：写不进去就停在这个房间，不创建原生工作区、不挂成员（复审 R2-F02）。
      const intent = await this.#updateRequired((state) => {
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
      if (intent.ok === false) {
        this.degrade(intent.code ?? REASON.LEDGER_WRITE_FAILED, 'restore intent could not be persisted');
        // 意图没落盘就等于这次恢复没有持久阶段依据：整个启动不许走到 READY（复审 R2-F02）。
        summary.blocked = intent.code ?? REASON.LEDGER_WRITE_FAILED;
        summary.conflicts.push(room.ownerSessionId);
        continue;
      }

      // 同路径登记分三种：自己的（id 与账本一致）、别人的（用户新登记）、没有。
      // 只有「id 与账本一致」才能复用；用户自己登记的同路径工作区说明这个 cwd 已被收编，
      // 绝不能把旧会话挂进去（验收 F02 / R08 / R09）。
      const samePath = [];
      for (const workspace of registry.workspaces) {
        if (typeof workspace.path === 'string' && await sameExistingPath(workspace.path, room.cwd)) samePath.push(workspace);
      }
      const ours = samePath.find((workspace) => workspace.id === room.workspaceId);
      const foreignSamePath = samePath.filter((workspace) => workspace.id !== room.workspaceId);
      if (foreignSamePath.length > 0) {
        const transitioned = await this.#transitionRoomRequired(room.workspaceId, ROOM_STATE.RELEASED, {
          error: {phase: 'restore', code: REASON.USER_CLAIMED, reason: REASON.USER_CLAIMED, at: new Date().toISOString(), workspaceId: foreignSamePath[0].id},
        });
        if (transitioned.ok === false) {
          summary.blocked = transitioned.code ?? REASON.LEDGER_WRITE_FAILED;
          return summary;
        }
        summary.released.push(room.ownerSessionId);
        continue;
      }

      let workspaceId = ours?.id;
      if (workspaceId === undefined) {
        const created = await createWorkspace(this.#ctx, room.cwd, room.cwd.split(path.sep).pop() ?? '');
        if (created.ok === false) {
          const transitioned = await this.#transitionRoomRequired(room.workspaceId, ROOM_STATE.DETACHED, {
            error: toErrorRecord('restore', created.error, REASON.LEDGER_WRITE_FAILED),
          });
          if (transitioned.ok === false) {
            summary.blocked = transitioned.code ?? REASON.LEDGER_WRITE_FAILED;
            return summary;
          }
          summary.conflicts.push(room.ownerSessionId);
          continue;
        }
        // 宿主对同一 canonical 路径会返回既有实体；返回值不属于我们刚建的那份就说明并发有人
        // 抢先登记了同一个 cwd，此时按用户收编处理，不 attach。
        const afterCreate = await readRegistry(this.#ctx);
        const atPath = [];
         if (afterCreate.ok) {
           for (const workspace of afterCreate.workspaces) {
             if (typeof workspace.path === 'string' && await sameExistingPath(workspace.path, room.cwd)) atPath.push(workspace);
           }
         }
        if (atPath.length > 1 || (atPath.length === 1 && atPath[0].id !== created.workspaceId)) {
          const transitioned = await this.#transitionRoomRequired(room.workspaceId, ROOM_STATE.RELEASED, {
            error: {phase: 'restore', code: REASON.USER_CLAIMED, reason: REASON.USER_CLAIMED, at: new Date().toISOString()},
          });
          if (transitioned.ok === false) {
            summary.blocked = transitioned.code ?? REASON.LEDGER_WRITE_FAILED;
            return summary;
          }
          summary.released.push(room.ownerSessionId);
          continue;
        }
        workspaceId = created.workspaceId;
      }

      // 先记录实际要操作的 Workspace ID，再执行 attach。若终态收尾失败，停用可以依据
      // RESTORING 房间继续删除这个登记，不会留下无法定位的原生工作区。
      const workspaceRecorded = await this.#updateRequired((state) => {
        const index = (state.rooms ?? []).findIndex((entry) => entry.workspaceId === room.workspaceId);
        if (index === -1) return;
        state.rooms[index].workspaceId = workspaceId;
      });
      if (workspaceRecorded.ok === false) {
        this.degrade(workspaceRecorded.code ?? REASON.LEDGER_WRITE_FAILED, 'restore workspace identity could not be persisted');
        summary.blocked = workspaceRecorded.code ?? REASON.LEDGER_WRITE_FAILED;
        summary.conflicts.push(room.ownerSessionId);
        continue;
      }

      // 逐个 attach 前重新读原生快照：宿主没有原子的「条件挂接」，只能把检查贴到每一次挂接前。
      const attached = await attachSessions(this.#ctx, workspaceId, eligible, {
        verify: async (sessionId) => {
          const latest = await readRegistry(this.#ctx);
          if (latest.ok === false) return false;
          const claim = latest.claimedBy.get(sessionId);
          if (claim !== undefined && claim !== '' && claim !== workspaceId) return false;
          const target = latest.workspaces.find((workspace) => workspace.id === workspaceId);
          return target !== undefined && await sameExistingPath(target.path, room.cwd);
        },
      });
      const failedIds = new Set(attached.failed.map((entry) => entry.sessionId));
      if (attached.missing) {
        await this.#transitionRoom(workspaceId, ROOM_STATE.DETACHED, {
          error: {phase: 'restore', code: REASON.ATTACH_FAILED, reason: REASON.ATTACH_FAILED, at: new Date().toISOString(), message: 'workspace missing after create'},
        });
        summary.conflicts.push(room.ownerSessionId);
        continue;
      }

      const allAttached = attached.attached.length === eligible.length;
      const nextState = allAttached && conflicted.length === 0 && userOwned.length === 0
        ? ROOM_STATE.MANAGED
        : allAttached ? ROOM_STATE.PARTIAL : ROOM_STATE.PARTIAL;
      const final = await this.#updateRequired((state) => {
        const index = (state.rooms ?? []).findIndex((entry) => entry.workspaceId === workspaceId);
        if (index === -1) return;
        state.rooms[index] = roomTransition(state.rooms[index], nextState, {
          operation: null,
          error: failedIds.size > 0
            ? {phase: 'restore', code: REASON.ATTACH_FAILED, reason: REASON.ATTACH_FAILED, at: new Date().toISOString(), members: [...failedIds]}
            : null,
        });
        state.rooms[index].workspaceId = workspaceId;
        // 成员资格逐条保留：只有真的挂上去的才是 attached。用户已收编的成员不能因为房间
        // 整体恢复成功就被改写成 attached，否则前端和 ensure/sweep 会把它当托管对象（验收 F03）。
        const attachedIds = new Set(attached.attached);
        state.rooms[index].members = members.map((member) => ({
          ...member,
          eligibility: failedIds.has(member.sessionId)
            ? ELIGIBILITY.CONFLICT
            : attachedIds.has(member.sessionId)
              ? ELIGIBILITY.ATTACHED
              : member.eligibility === ELIGIBILITY.ELIGIBLE
                ? ELIGIBILITY.CONFLICT
                : member.eligibility,
        }));
      });
      if (final.ok === false) {
        this.degrade(final.code ?? REASON.LEDGER_WRITE_FAILED, 'restore terminal state could not be persisted');
        summary.blocked = final.code ?? REASON.LEDGER_WRITE_FAILED;
        summary.conflicts.push(room.ownerSessionId);
        return summary;
      }
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
    const MANAGED_ROOM_STATES = new Set([ROOM_STATE.MANAGED, ROOM_STATE.PARTIAL, ROOM_STATE.RESTORING]);
    for (const room of rooms) {
      if (!MANAGED_ROOM_STATES.has(room.state)) continue;
      if (typeof room.workspaceId === 'string' && room.workspaceId !== '') workspaceIds.push(room.workspaceId);
      // 逐成员过滤：用户收编（user-owned）、冲突、日志缺失的成员不属于托管集合，
      // 否则前端会把用户的会话也压平进「独立对话」（验收 F03）。
      for (const member of room.members ?? []) {
        if (member.eligibility === ELIGIBILITY.ATTACHED) sessionIds.push(member.sessionId);
      }
      // 账本里还没有 members 汇总的旧房间：退回 sessionIds，但仍受房间状态约束。
      if (!Array.isArray(room.members) || room.members.length === 0) {
        for (const sessionId of room.sessionIds ?? []) sessionIds.push(sessionId);
      }
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
    const MANAGED_ROOM_STATES = new Set([ROOM_STATE.MANAGED, ROOM_STATE.PARTIAL, ROOM_STATE.RESTORING]);
    return (ledger.rooms ?? []).some((room) => {
      // RELEASED / CONFLICT / DETACHED 房间不再触发补登记：用户的安排优先（R09）。
      if (!MANAGED_ROOM_STATES.has(room.state)) return false;
      const members = Array.isArray(room.members) ? room.members : null;
      if (members !== null && members.length > 0) {
        const member = members.find((entry) => entry.sessionId === sessionId);
        // 成员表里没有的人，只有 owner 本身还按房间认（旧账本兼容）；其余一律不算托管。
        if (member === undefined) return room.ownerSessionId === sessionId;
        return member.eligibility === ELIGIBILITY.ATTACHED;
      }
      return (room.sessionIds ?? []).includes(sessionId) || room.ownerSessionId === sessionId;
    });
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
