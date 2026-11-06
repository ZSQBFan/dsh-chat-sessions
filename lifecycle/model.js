/**
 * dsh-chat-sessions — 生命周期账本纯模型（L1）。
 *
 * 职责：常量、scope 身份、账本校验/归一化、房间与成员分类、状态迁移与计数。
 *
 * 不变量：
 *  1. 本文件不调用任何 fs API；唯一的外部效果是 sha256 哈希。
 *  2. 账本只允许出现 ID／路径／阶段／错误码／时间；不得写入对话内容、提示词、
 *     token、模型输出或草稿正文。
 *  3. `normalizeLedger` 是唯一校验入口：非法输入抛 `LedgerInvalidError`，绝不
 *     静默重置成 `{}`；未知附加字段按原样保留（向前兼容），已知字段逐项校验。
 *  4. 进入账本的路径一律绝对化；缺失目录只做分类，绝不 mkdir。
 *
 * 契约：docs/lifecycle/04-IMPLEMENTATION-CONTRACT.md §3、§4、§6。
 */
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

/** 账本格式版本；不兼容修改必须同时更新契约与 CHANGELOG。 */
export const LEDGER_SCHEMA_VERSION = 1;
/** 缺省插件标识，与 package.json 的 name 尾部一致。 */
export const DEFAULT_PLUGIN_ID = 'chat-sessions';
/** 宿主拿不到稳定 profile 名时的占位值（端口/PID/时间戳一律不得参与身份）。 */
export const DEFAULT_PROFILE_ID = 'unknown';

/** 房间状态（契约 §4）。 */
export const ROOM_STATE = Object.freeze({
  MANAGED: 'MANAGED',
  DETACHING: 'DETACHING',
  DETACHED: 'DETACHED',
  RESTORING: 'RESTORING',
  PARTIAL: 'PARTIAL',
  RELEASED: 'RELEASED',
  CONFLICT: 'CONFLICT',
});

/** 进程状态（契约 §4）：只有 READY 接受正常插件写操作。 */
export const PROCESS_STATE = Object.freeze({
  STARTING: 'STARTING',
  READY: 'READY',
  QUIESCING: 'QUIESCING',
  DISPOSED: 'DISPOSED',
  DEGRADED: 'DEGRADED',
});

/** 阶段操作类型（契约 §4）。 */
export const OPERATION_KIND = Object.freeze({
  CREATE: 'CREATE',
  DETACH: 'DETACH',
  RESTORE: 'RESTORE',
  RECONCILE: 'RECONCILE',
});

/** 新建意图状态（契约 §4、设计 §6.2）。 */
export const INTENT_STATE = Object.freeze({
  PENDING: 'PENDING',
  ADOPTED: 'ADOPTED',
  ABANDONED: 'ABANDONED',
});

/** 成员资格（契约 §4、§6）。 */
export const ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'eligible',
  ATTACHED: 'attached',
  USER_OWNED: 'user-owned',
  MISSING_SESSION: 'missing-session',
  CONFLICT: 'conflict',
});

/**
 * 固定原因码集合（设计 §14）。
 * `lastError.code`、`process.lastDetach.reason` 只能取这里的值；新增必须登记。
 */
export const REASON = Object.freeze({
  USER_CLAIMED: 'USER_CLAIMED',
  FOREIGN_MEMBERS: 'FOREIGN_MEMBERS',
  CWD_MISMATCH: 'CWD_MISMATCH',
  DIRECTORY_MISSING: 'DIRECTORY_MISSING',
  DIRECTORY_IDENTITY_CHANGED: 'DIRECTORY_IDENTITY_CHANGED',
  SCOPE_MISMATCH: 'SCOPE_MISMATCH',
  LEDGER_INVALID: 'LEDGER_INVALID',
  LEDGER_WRITE_FAILED: 'LEDGER_WRITE_FAILED',
  LOCK_HELD: 'LOCK_HELD',
  UNKNOWN_UNLOAD_REASON: 'UNKNOWN_UNLOAD_REASON',
  REGISTRY_DELETE_FAILED: 'REGISTRY_DELETE_FAILED',
  ATTACH_FAILED: 'ATTACH_FAILED',
  HOST_ATOMIC_GUARD_MISSING: 'HOST_ATOMIC_GUARD_MISSING',
  HOST_UI_UNSUPPORTED: 'HOST_UI_UNSUPPORTED',
  // 交接原因（写入 process.lastDetach.reason，与错误码共用同一命名空间）。
  USER_DISABLE: 'USER_DISABLE',
  USER_REMOVE: 'USER_REMOVE',
  RESTART: 'RESTART',
  RELOAD: 'RELOAD',
  // 与 host-adapter 的 UNLOAD 五值同名：交接判定直接落账本，诊断时不用二次翻译。
  PLUGIN_DISABLE: 'PLUGIN_DISABLE',
  BUNDLE_DISABLE: 'BUNDLE_DISABLE',
  BUNDLE_REMOVE: 'BUNDLE_REMOVE',
  UNKNOWN: 'UNKNOWN',
});

const ROOM_STATES = new Set(Object.values(ROOM_STATE));
const PROCESS_STATES = new Set(Object.values(PROCESS_STATE));
const OPERATION_KINDS = new Set(Object.values(OPERATION_KIND));
const INTENT_STATES = new Set(Object.values(INTENT_STATE));
const ELIGIBILITIES = new Set(Object.values(ELIGIBILITY));
const REASONS = new Set(Object.values(REASON));

/** 账本结构非法；store 的 open() 据此把状态标成 invalid 并保留原件。 */
export class LedgerInvalidError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LedgerInvalidError';
    this.code = 'LEDGER_INVALID';
  }
}

/**
 * 纯路径规范化：resolve 相对段、去掉尾斜杠、折叠 `.`/`..`。
 *
 * 刻意不做 realpath —— 本模块不得触 fs。真实路径由 `LedgerStore.open()` 在
 * 调用 `scopeIdentity` 之前完成（契约 §3），因此同一台机器上 canonical(dshHome)
 * 在真实路径不变时保持稳定。
 * @param {unknown} path 任意待规范化的路径。
 * @returns {string} 绝对路径；空输入返回空串。
 */
export function canonicalPath(path) {
  const text = typeof path === 'string' ? path : String(path ?? '');
  if (text === '') return '';
  return resolve(text);
}

/**
 * scope 身份：`sha256(pluginId\nprofileId\ncanonical(dshHome)\ncanonical(root))` 前 32 位。
 *
 * 端口、PID、进程启动时间、时间戳、插件版本均不得参与（契约 §3），否则同一份
 * 数据会因一次重启换账本。
 * @param {{pluginId?: string, profileId?: string, dshHome?: string, canonicalRoot?: string}} identity
 * @returns {string} 32 位小写十六进制。
 */
export function scopeIdentity(identity = {}) {
  const pluginId = nonEmptyOrDefault(identity.pluginId, DEFAULT_PLUGIN_ID);
  const profileId = nonEmptyOrDefault(identity.profileId, DEFAULT_PROFILE_ID);
  const dshHome = canonicalPath(identity.dshHome ?? '');
  const canonicalRoot = canonicalPath(identity.canonicalRoot ?? '');
  if (dshHome === '' || canonicalRoot === '') throw new TypeError('scopeIdentity 需要 dshHome 与 canonicalRoot');
  if (!isAbsolute(dshHome) || !isAbsolute(canonicalRoot)) throw new TypeError('scopeIdentity 的路径必须是绝对路径');
  return createHash('sha256')
    .update([pluginId, profileId, dshHome, canonicalRoot].join('\n'), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * 新建一份空账本（`revision = 0`，`schemaVersion = 1`）。
 * @param {object} identity 已解析的 `{pluginId, profileId, dshHome, canonicalRoot, rootResolved?}`。
 * @param {{now?: number|Date}} [options] 可注入的时钟，便于测试。
 * @returns {object} 通过 `normalizeLedger` 的完整账本。
 */
export function createLedger(identity, { now = Date.now() } = {}) {
  const normalized = normalizeIdentity(identity);
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    scopeId: scopeIdentity(normalized),
    revision: 0,
    updatedAt: toIso(now, 'now'),
    identity: normalized,
    migration: { version: 1, completed: false, at: null, evidence: null },
    generation: 0,
    process: { state: PROCESS_STATE.STARTING, lastDetach: null },
    rooms: [],
    creationIntents: [],
  };
}

/**
 * 校验并补默认值；非法输入抛 `LedgerInvalidError`。
 *
 * 默认值只用于「字段缺失且语义安全」的可选项（如 `generation`、`migration`），
 * 必填字段缺失一律报错——不做静默重置，避免把坏账本洗成新账本。
 * @param {unknown} raw 从磁盘或 mutator 得到的账本草稿。
 * @returns {object} 深拷贝后的新账本，调用方可以安全持有。
 */
export function normalizeLedger(raw) {
  const source = assertObject(cloneJson(raw), 'ledger');
  if (source.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new LedgerInvalidError(`未知 schemaVersion: ${String(source.schemaVersion)}`);
  }
  const scopeId = requireScopeId(source.scopeId, 'scopeId');
  const revision = requireInteger(source.revision, 'revision', 0);
  const updatedAt = requireIso(source.updatedAt, 'updatedAt');
  const identity = normalizeIdentity(source.identity);
  const migration = normalizeMigration(source.migration);
  const generation = requireInteger(source.generation ?? 0, 'generation', 0);
  const process = normalizeProcess(source.process);
  const rooms = normalizeRooms(source.rooms);
  const creationIntents = normalizeIntents(source.creationIntents);
  return {
    ...source,
    schemaVersion: LEDGER_SCHEMA_VERSION,
    scopeId,
    revision,
    updatedAt,
    identity,
    migration,
    generation,
    process,
    rooms,
    creationIntents,
  };
}

/**
 * 目录分类：账本身份与当前 stat 是否仍指同一目录。
 *
 * `stat` 为 `null` 表示 ENOENT。账本未记录 dev/ino 时不做否决（返回 `ok`），
 * 由调用方决定是否补写身份；缺失目录绝不 mkdir（契约 §6）。
 * @param {object} room 账本房间。
 * @param {{isDirectory?: () => boolean, dev?: number|string, ino?: number|string}|null} stat
 * @returns {'ok'|'missing'|'not-directory'|'identity-changed'}
 */
export function classifyDirectory(room, stat) {
  if (stat === null || stat === undefined) return 'missing';
  if (typeof stat.isDirectory !== 'function' || stat.isDirectory() !== true) return 'not-directory';
  const recorded = room?.directoryIdentity ?? null;
  if (recorded === null || recorded.dev === null || recorded.dev === undefined || recorded.ino === null || recorded.ino === undefined) {
    return 'ok';
  }
  const same = String(recorded.dev) === String(stat.dev) && String(recorded.ino) === String(stat.ino);
  return same ? 'ok' : 'identity-changed';
}

/**
 * 成员分类（契约 §6）：日志缺失 → missing-session；子代理 → conflict；
 * header.cwd 与房间 canonicalCwd 不一致 → conflict；被其它 workspace 认领 →
 * user-owned；否则 eligible。
 *
 * 契约签名未包含房间本身，这里额外接受 `room`／`canonicalCwd`／`workspaceId`
 * 注入点，避免把 cwd 混进成员记录。
 * @param {{member?: object, header?: object|null, claimedBy?: string|null, isSubagent?: boolean,
 *          room?: object|null, canonicalCwd?: string|null, workspaceId?: string|null}} [options]
 * @returns {'eligible'|'user-owned'|'missing-session'|'conflict'}
 */
export function classifyMember(options = {}) {
  const { member = {}, header = null, claimedBy = null, isSubagent = false, room = null } = options;
  if (header === null || header === undefined) return ELIGIBILITY.MISSING_SESSION;
  if (isSubagent === true) return ELIGIBILITY.CONFLICT;
  const expectedCwd = options.canonicalCwd ?? room?.canonicalCwd ?? member.canonicalCwd ?? member.cwd ?? null;
  if (typeof expectedCwd !== 'string' || expectedCwd === '') {
    throw new TypeError('classifyMember 需要房间 canonicalCwd（room 或 canonicalCwd）');
  }
  const headerCwd = typeof header.cwd === 'string' ? canonicalPath(header.cwd) : '';
  if (headerCwd !== canonicalPath(expectedCwd)) return ELIGIBILITY.CONFLICT;
  const ownWorkspaceId = options.workspaceId ?? room?.workspaceId ?? member.workspaceId ?? null;
  const claimed = claimedBy === null || claimedBy === undefined || claimedBy === '';
  if (!claimed && claimedBy !== ownWorkspaceId) return ELIGIBILITY.USER_OWNED;
  return ELIGIBILITY.ELIGIBLE;
}

/**
 * 房间状态迁移：返回新对象，不改输入。
 *
 * `operation`／`error` 只在显式传入时覆盖（传 `null` 表示清除）；这样
 * DETACHING 里记录的 `REGISTRY_DELETE_FAILED` 不会因为一次普通迁移被抹掉，
 * 需要清除时必须显式 `error: null`（契约 §7）。
 * @param {object} room 原房间。
 * @param {string} next `ROOM_STATE` 之一。
 * @param {{now?: number|Date, operation?: object|null, error?: object|null}} [options]
 * @returns {object} 新房间对象。
 */
export function roomTransition(room, next, options = {}) {
  if (!ROOM_STATES.has(next)) throw new RangeError(`未知房间状态: ${String(next)}`);
  const result = { ...(room ?? {}), state: next, updatedAt: toIso(options.now ?? Date.now(), 'now') };
  if (Object.prototype.hasOwnProperty.call(options, 'operation')) result.operation = options.operation ?? null;
  if (Object.prototype.hasOwnProperty.call(options, 'error')) result.lastError = options.error ?? null;
  return result;
}

/**
 * 房间计数。契约要求的六个键之外补 `detaching` 与 `total`，否则交接中的房间
 * 会在「候选 = 成功 + 跳过 + 冲突 + 失败」的对账里凭空消失（设计 §14）。
 * @param {object[]} rooms
 * @returns {{managed: number, detaching: number, detached: number, restoring: number,
 *            partial: number, released: number, conflict: number, total: number}}
 */
export function summarizeRooms(rooms = []) {
  const summary = {
    managed: 0,
    detaching: 0,
    detached: 0,
    restoring: 0,
    partial: 0,
    released: 0,
    conflict: 0,
    total: 0,
  };
  for (const room of Array.isArray(rooms) ? rooms : []) {
    summary.total += 1;
    const key = typeof room?.state === 'string' ? room.state.toLowerCase() : '';
    if (key !== 'total' && Object.prototype.hasOwnProperty.call(summary, key)) summary[key] += 1;
  }
  return summary;
}

// ── 内部校验工具 ────────────────────────────────────────────────────────────

function cloneJson(value) {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new LedgerInvalidError(`账本包含不可序列化的值: ${error.message}`, { cause: error });
  }
}

function nonEmptyOrDefault(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function assertObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LedgerInvalidError(`${label} 必须是对象`);
  }
  return value;
}

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new LedgerInvalidError(`${label} 必须是非空字符串`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new LedgerInvalidError(`${label} 必须是布尔值`);
  return value;
}

function requireInteger(value, label, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new LedgerInvalidError(`${label} 必须是 >= ${minimum} 的整数`);
  }
  return value;
}

function requireAbsolute(value, label) {
  const text = requireNonEmpty(value, label);
  if (!isAbsolute(text)) throw new LedgerInvalidError(`${label} 必须是绝对路径: ${text}`);
  return text;
}

function requireIso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new LedgerInvalidError(`${label} 必须是 ISO 时间字符串`);
  }
  return value;
}

function requireScopeId(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{32}$/u.test(value)) {
    throw new LedgerInvalidError(`${label} 必须是 32 位小写十六进制`);
  }
  return value;
}

function requireEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new LedgerInvalidError(`${label} 非法: ${String(value)}`);
  }
  return value;
}

function requireReasonCode(value, label) {
  const text = requireNonEmpty(value, label);
  if (!REASONS.has(text)) throw new LedgerInvalidError(`${label} 未在 REASON 登记: ${text}`);
  return text;
}

function toIso(value, label) {
  const time = value instanceof Date ? value.getTime() : value;
  if (typeof time !== 'number' || !Number.isFinite(time)) {
    throw new LedgerInvalidError(`${label} 必须是有限的毫秒时间戳`);
  }
  return new Date(time).toISOString();
}

function normalizeIdentity(raw) {
  const source = assertObject(raw, 'identity');
  return {
    ...source,
    pluginId: requireNonEmpty(source.pluginId, 'identity.pluginId'),
    profileId: requireNonEmpty(source.profileId, 'identity.profileId'),
    dshHome: requireAbsolute(source.dshHome, 'identity.dshHome'),
    canonicalRoot: requireAbsolute(source.canonicalRoot, 'identity.canonicalRoot'),
    rootResolved: source.rootResolved === undefined ? true : requireBoolean(source.rootResolved, 'identity.rootResolved'),
  };
}

function normalizeMigration(raw) {
  if (raw === undefined || raw === null) return { version: 1, completed: false, at: null, evidence: null };
  const source = assertObject(raw, 'migration');
  return {
    ...source,
    version: requireInteger(source.version ?? 1, 'migration.version', 1),
    completed: source.completed === undefined ? false : requireBoolean(source.completed, 'migration.completed'),
    at: source.at === undefined || source.at === null ? null : requireIso(source.at, 'migration.at'),
    evidence: source.evidence === undefined || source.evidence === null ? null : assertObject(source.evidence, 'migration.evidence'),
  };
}

function normalizeProcess(raw) {
  if (raw === undefined || raw === null) return { state: PROCESS_STATE.STARTING, lastDetach: null };
  const source = assertObject(raw, 'process');
  return {
    ...source,
    state: requireEnum(source.state ?? PROCESS_STATE.STARTING, PROCESS_STATES, 'process.state'),
    lastDetach: source.lastDetach === undefined || source.lastDetach === null ? null : normalizeDetach(source.lastDetach),
  };
}

function normalizeDetach(raw) {
  const source = assertObject(raw, 'process.lastDetach');
  return {
    ...source,
    reason: requireReasonCode(source.reason, 'process.lastDetach.reason'),
    operationId: requireNonEmpty(source.operationId, 'process.lastDetach.operationId'),
    at: requireIso(source.at, 'process.lastDetach.at'),
    outcome: source.outcome === undefined || source.outcome === null ? null : requireNonEmpty(source.outcome, 'process.lastDetach.outcome'),
  };
}

function normalizeRooms(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new LedgerInvalidError('rooms 必须是数组');
  const seen = new Set();
  return raw.map((room, index) => {
    const normalized = normalizeRoom(room, `rooms[${index}]`);
    if (seen.has(normalized.ownerSessionId)) {
      throw new LedgerInvalidError(`rooms 中 ownerSessionId 重复: ${normalized.ownerSessionId}`);
    }
    seen.add(normalized.ownerSessionId);
    return normalized;
  });
}

function normalizeRoom(raw, label) {
  const source = assertObject(raw, label);
  const cwd = requireAbsolute(source.cwd, `${label}.cwd`);
  return {
    ...source,
    ownerSessionId: requireNonEmpty(source.ownerSessionId, `${label}.ownerSessionId`),
    cwd,
    canonicalCwd: requireAbsolute(source.canonicalCwd ?? cwd, `${label}.canonicalCwd`),
    directoryIdentity: normalizeDirectoryIdentity(source.directoryIdentity, `${label}.directoryIdentity`),
    workspaceId: source.workspaceId === undefined || source.workspaceId === null
      ? null
      : requireNonEmpty(source.workspaceId, `${label}.workspaceId`),
    state: requireEnum(source.state, ROOM_STATES, `${label}.state`),
    operation: source.operation === undefined || source.operation === null
      ? null
      : normalizeOperation(source.operation, `${label}.operation`),
    sessionIds: normalizeSessionIds(source.sessionIds, `${label}.sessionIds`),
    members: normalizeMembers(source.members, `${label}.members`),
    lastError: source.lastError === undefined || source.lastError === null
      ? null
      : normalizeError(source.lastError, `${label}.lastError`),
    updatedAt: source.updatedAt === undefined || source.updatedAt === null
      ? null
      : requireIso(source.updatedAt, `${label}.updatedAt`),
  };
}

function normalizeDirectoryIdentity(raw, label) {
  if (raw === undefined || raw === null) return null;
  const source = assertObject(raw, label);
  return {
    ...source,
    dev: source.dev === undefined || source.dev === null ? null : String(source.dev),
    ino: source.ino === undefined || source.ino === null ? null : String(source.ino),
  };
}

function normalizeOperation(raw, label) {
  const source = assertObject(raw, label);
  return {
    ...source,
    kind: requireEnum(source.kind, OPERATION_KINDS, `${label}.kind`),
    id: requireNonEmpty(source.id, `${label}.id`),
    from: source.from === undefined || source.from === null ? null : requireEnum(source.from, ROOM_STATES, `${label}.from`),
    to: source.to === undefined || source.to === null ? null : requireEnum(source.to, ROOM_STATES, `${label}.to`),
    startedAt: requireIso(source.startedAt, `${label}.startedAt`),
  };
}

function normalizeSessionIds(raw, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new LedgerInvalidError(`${label} 必须是数组`);
  const seen = new Set();
  return raw.map((value, index) => {
    const id = requireNonEmpty(value, `${label}[${index}]`);
    if (seen.has(id)) throw new LedgerInvalidError(`${label} 中 sessionId 重复: ${id}`);
    seen.add(id);
    return id;
  });
}

function normalizeMembers(raw, label) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new LedgerInvalidError(`${label} 必须是数组`);
  const seen = new Set();
  return raw.map((member, index) => {
    const source = assertObject(member, `${label}[${index}]`);
    const sessionId = requireNonEmpty(source.sessionId, `${label}[${index}].sessionId`);
    if (seen.has(sessionId)) throw new LedgerInvalidError(`${label} 中 sessionId 重复: ${sessionId}`);
    seen.add(sessionId);
    return {
      ...source,
      sessionId,
      role: source.role === undefined ? 'member' : requireNonEmpty(source.role, `${label}[${index}].role`),
      eligibility: requireEnum(source.eligibility ?? ELIGIBILITY.ELIGIBLE, ELIGIBILITIES, `${label}[${index}].eligibility`),
      lastSeenAt: source.lastSeenAt === undefined || source.lastSeenAt === null
        ? null
        : requireIso(source.lastSeenAt, `${label}[${index}].lastSeenAt`),
    };
  });
}

function normalizeError(raw, label) {
  const source = assertObject(raw, label);
  return {
    ...source,
    code: requireReasonCode(source.code, `${label}.code`),
    message: typeof source.message === 'string' ? source.message : '',
    at: requireIso(source.at, `${label}.at`),
  };
}

function normalizeIntents(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new LedgerInvalidError('creationIntents 必须是数组');
  const seen = new Set();
  return raw.map((intent, index) => {
    const source = assertObject(intent, `creationIntents[${index}]`);
    const id = requireNonEmpty(source.id, `creationIntents[${index}].id`);
    if (seen.has(id)) throw new LedgerInvalidError(`creationIntents 中 id 重复: ${id}`);
    seen.add(id);
    return {
      ...source,
      id,
      ownerSessionId: requireNonEmpty(source.ownerSessionId, `creationIntents[${index}].ownerSessionId`),
      cwd: requireAbsolute(source.cwd, `creationIntents[${index}].cwd`),
      state: requireEnum(source.state ?? INTENT_STATE.PENDING, INTENT_STATES, `creationIntents[${index}].state`),
      at: requireIso(source.at, `creationIntents[${index}].at`),
    };
  });
}
