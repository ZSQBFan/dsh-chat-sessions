/**
 * dsh-chat-sessions — 旧数据审计与迁移候选（L3）。
 *
 * 职责：只读取证。把 `<root>/.sessions` 下的旧房间目录、原生 workspace 登记、宿主持久
 * 会话头三者对齐，产出「可迁移 / 有歧义 / 账本丢失 / 明确拒绝」四类候选。本模块是
 * 设计 §8.2 的 audit 步骤：**不写账本、不碰原生 registry、不写任何文件**。
 *
 * 不变量：
 *  1. 只读：只用 lstat/stat/readdir/readFile/realpath/readlink/open+read，不 mkdir、
 *     不 unlink、不 rename、不写 .links.json、不改会话日志（测试用目录快照比对）。
 *  2. 三条独立证据（设计 §8.2）：①原生 registry 里 path 落在 root 下的 workspace 及其
 *     成员；②root 下真实目录（含已归档空目录）；③成员会话头 `header.cwd` 与目录路径
 *     一致、日志存在、非子代理。三者缺一即为 ambiguous，绝不乐观 adopt。
 *  3. 首次升级与「迁移后账本丢失」必须区分：无账本时，只要出现「曾被 adopt 过」的硬
 *     证据（scope 级 `migration.json` / `quarantine/` 残留 / 房间目录内插件标记文件
 *     `.dsh-chat-sessions.json`），一律判 `ledger-missing`：不自动 adopt，只作冲突候选
 *     交人工。标题链接（`.links.json` + 软链接）默认只作辅助佐证——v0.1.1 每个房间都有
 *     标题链接，把它当硬证据会让首次升级永远无法迁移；严格模式传
 *     `linksAreAdoptionEvidence: true`。
 *  4. 绝不因为审计而删除/重建目录：空目录、已归档空目录都是候选，`preserve` 恒为 true。
 *  5. 路径判定分两层：`canonicalCwd` 用 model.canonicalPath（仅 resolve，与成员分类口径
 *     一致）；`realPath` 用 realpath，只用于「软链接是否越出 root」与目录身份核对。
 *
 * 契约（本文件对外的唯一接口）：
 *
 *   auditLegacyRooms({
 *     root,                     // 必填，插件 chatRoot()，即 <...>/chats
 *     dshHome,                  // 可空，缺省 DSH_HOME 或 ~/.dsh
 *     now,                      // 可空，时间戳（写入 generatedAt）
 *     recordedIdentities,       // 可空，{ [目录路径]: {dev, ino} } 或 [{path, dev, ino}]
 *     linksAreAdoptionEvidence, // 可空，默认 false（见不变量 3）
 *     detect: {                 // 可空，全部只读；缺省用真实磁盘探测器
 *       readSessionHeader?,     // (sessionId) => {header, logPath}
 *                               //              | {header: null, logPath, reason}
 *                               //              | null（日志不存在）
 *       listRegistry?,          // () => {workspaces:[{id,path,sessionIds}], archivedSessionIds?} | null
 *       readScopeState?,        // () => {ledgerExists, migrationCompleted, residue, weakResidue, sources}
 *     },
 *   }) => Promise<AuditResult>
 *
 *   legacyRoomDraft(room, { now }) => object | null   // 仅 adoptable 房间返回账本草稿
 *
 * `detect` 返回 `null` 一律视为「证据缺失」（日志不存在 / registry 不可读），不是错误；
 * 探测器自身抛错只记 diagnostics，不让审计整体失败。
 *
 * AuditResult：
 *   { generatedAt, root, canonicalRoot, rootResolved, sessionsRoot,
 *     scope: { ledgerExists, migrationCompleted, residue, weakResidue, migrationSources,
 *              registryAvailable, registryWorkspaces, registryOutsideRoot,
 *              registryRoomMissing, registryRoomMissingArchived },
 *     counts: { rooms, adoptable, ambiguous, ledgerMissing, rejected, preserved },
 *     rooms, adoptable, ledgerMissing, rejected, diagnostics }
 *
 * 对账：`rooms.length === counts.rooms`，且 `adoptable + ambiguous + ledgerMissing` 三项
 * 计数之和等于 `counts.rooms`（设计 §14 的候选 = 成功 + 跳过 + 冲突 + 失败）。
 *
 * 成员口径：房间级阻塞只由 owner（目录 basename 对应会话）决定；非 owner 成员的子代理、
 * 已删日志、cwd 不符只把该成员列入 `memberExclusions` 并排除出认领范围（设计 R14），
 * 不影响房间本身能否迁移；但「被另一个 workspace 认领」仍阻塞整个房间。
 *
 * 契约来源：docs/lifecycle/01-DESIGN.md §8.2、§13；04-IMPLEMENTATION-CONTRACT.md §2、§6。
 */
import { open, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import * as zlib from 'node:zlib';

import {
  ELIGIBILITY,
  ROOM_STATE,
  canonicalPath,
  classifyDirectory,
  classifyMember,
} from './model.js';
import { effectiveDshHome } from './store.js';

/** 房间目录形状：index.js 用 `session-` 前缀 + randomUUID 建目录。 */
const SESSION_DIR_PATTERN = /^session-[0-9a-z][0-9a-z-]{6,}$/u;

/** 新插件 adopt 成功后写入房间目录的标记文件（只读探测，不存在即无证据）。 */
const ROOM_MARKER_FILE = '.dsh-chat-sessions.json';

/** 与 store.js 一致的账本存储区名字，用于扫描 scope 级迁移标记。 */
const LEDGER_STORAGE_DIRNAME = 'dsh-chat-sessions-lifecycle';
const LEDGER_FILE = 'ledger.json';
const MIGRATION_FILE = 'migration.json';
const QUARANTINE_DIR = 'quarantine';
const LOCK_FILE = 'lock.json';

/** 会话日志前缀读取上限：截断的 zstd 帧也能解出首个 header 行。 */
const HEADER_READ_LIMITS = Object.freeze([8 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024]);

/** 审计分类（与账本 ROOM_STATE 不同，是「迁移候选」的审计结论）。 */
export const LEGACY_CLASSIFICATION = Object.freeze({
  ADOPTABLE: 'adoptable',
  AMBIGUOUS: 'ambiguous',
  LEDGER_MISSING: 'ledger-missing',
  REJECTED: 'rejected',
});

/**
 * 审计原因码：**独立命名空间**，不要和 model.REASON 混用。
 * model.REASON 只承载账本 `lastError.code`，审计结论不进账本。
 */
export const LEGACY_REASON = Object.freeze({
  /** 三条证据齐全（仅用于标注，不作为阻塞原因）。 */
  EVIDENCE_COMPLETE: 'EVIDENCE_COMPLETE',
  /** 目录在，成员会话日志不在（或成员列表为空）。 */
  SESSION_MISSING: 'SESSION_MISSING',
  /** 日志在，但首个 header 行读不出来（截断/压缩不可用/格式未知）。 */
  HEADER_UNREADABLE: 'HEADER_UNREADABLE',
  /** header 可解析但不是 session 头（缺 type/id/cwd）。 */
  HEADER_INVALID: 'HEADER_INVALID',
  /** header.id 与请求的 sessionId 不一致，说明取到了别人的日志。 */
  HEADER_ID_MISMATCH: 'HEADER_ID_MISMATCH',
  /** header.cwd 与房间目录不一致（含祖先软链接拼写差异）。 */
  CWD_MISMATCH: 'CWD_MISMATCH',
  /** 成员是子代理（origin/source/delegationDepth/parentSession 任一成立）。 */
  SUBAGENT_MEMBER: 'SUBAGENT_MEMBER',
  /** 成员被另一个 workspace 认领。 */
  USER_OWNED: 'USER_OWNED',
  /** 成员资格冲突但原因不属于上面任何一条。 */
  MEMBER_CONFLICT: 'MEMBER_CONFLICT',
  /** 目录没有对应的原生 workspace 登记。 */
  REGISTRY_MISSING: 'REGISTRY_MISSING',
  /** workspace 登记存在但 sessionIds 为空，凑不出「workspace 及其成员」。 */
  REGISTRY_MEMBERS_MISSING: 'REGISTRY_MEMBERS_MISSING',
  /** registry 有登记，但目录 dev/ino 与历史记录不符（被整体替换）。 */
  DIRECTORY_IDENTITY_CHANGED: 'DIRECTORY_IDENTITY_CHANGED',
  /** 空目录且没有任何日志，但有归档链接（已归档空房间）。 */
  ARCHIVED_EMPTY_DIRECTORY: 'ARCHIVED_EMPTY_DIRECTORY',
  /** 空目录且没有任何日志、也没有归档链接。 */
  EMPTY_DIRECTORY: 'EMPTY_DIRECTORY',
  /** 无账本，但存在「曾被 adopt 过」的硬证据：账本丢失，不得自动 adopt。 */
  LEDGER_MISSING: 'LEDGER_MISSING',
  /** 账本已存在：迁移已走过，本审计不接管，交 coordinator 对账。 */
  LEDGER_PRESENT: 'LEDGER_PRESENT',
  /** 路径形状不是房间目录（含 root 内非 `.sessions/session-*` 的普通工作区）。 */
  NOT_SESSION_DIRECTORY: 'NOT_SESSION_DIRECTORY',
  /** `.sessions/<id>` 是软链接，且指向 root 之外。 */
  SYMLINK_ESCAPES_ROOT: 'SYMLINK_ESCAPES_ROOT',
  /** `.sessions/<id>` 是软链接但目标不存在。 */
  SYMLINK_UNRESOLVED: 'SYMLINK_UNRESOLVED',
  /** `.sessions/<id>` 是软链接且指向 root 内：不是 v0.1.x 的产物，交人工。 */
  SYMLINK_DIRECTORY: 'SYMLINK_DIRECTORY',
  /** 登记路径在 root 之外。 */
  OUTSIDE_ROOT: 'OUTSIDE_ROOT',
});

/** 诊断码（人类排障用，不参与分类）。 */
export const LEGACY_DIAGNOSTIC = Object.freeze({
  ROOT_MISSING: 'ROOT_MISSING',
  SESSIONS_UNREADABLE: 'SESSIONS_UNREADABLE',
  DIRECTORY_UNREADABLE: 'DIRECTORY_UNREADABLE',
  REGISTRY_UNREADABLE: 'REGISTRY_UNREADABLE',
  REGISTRY_INVALID: 'REGISTRY_INVALID',
  REGISTRY_READ_FAILED: 'REGISTRY_READ_FAILED',
  REGISTRY_AMBIGUOUS_CLAIM: 'REGISTRY_AMBIGUOUS_CLAIM',
  REGISTRY_ROOM_MISSING: 'REGISTRY_ROOM_MISSING',
  HEADER_READ_FAILED: 'HEADER_READ_FAILED',
  LINK_READ_FAILED: 'LINK_READ_FAILED',
  SCOPE_UNREADABLE: 'SCOPE_UNREADABLE',
});

/** 原因码展示优先级：`room.reason` 取其中第一个命中项。 */
const REASON_ORDER = Object.freeze([
  LEGACY_REASON.SYMLINK_ESCAPES_ROOT,
  LEGACY_REASON.SYMLINK_UNRESOLVED,
  LEGACY_REASON.SYMLINK_DIRECTORY,
  LEGACY_REASON.OUTSIDE_ROOT,
  LEGACY_REASON.NOT_SESSION_DIRECTORY,
  LEGACY_REASON.LEDGER_MISSING,
  LEGACY_REASON.LEDGER_PRESENT,
  LEGACY_REASON.DIRECTORY_IDENTITY_CHANGED,
  LEGACY_REASON.ARCHIVED_EMPTY_DIRECTORY,
  LEGACY_REASON.EMPTY_DIRECTORY,
  LEGACY_REASON.REGISTRY_MISSING,
  LEGACY_REASON.REGISTRY_MEMBERS_MISSING,
  LEGACY_REASON.SESSION_MISSING,
  LEGACY_REASON.HEADER_UNREADABLE,
  LEGACY_REASON.HEADER_INVALID,
  LEGACY_REASON.HEADER_ID_MISMATCH,
  LEGACY_REASON.SUBAGENT_MEMBER,
  LEGACY_REASON.CWD_MISMATCH,
  LEGACY_REASON.USER_OWNED,
  LEGACY_REASON.MEMBER_CONFLICT,
]);

// ── 小工具 ────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/** `child` 是否等于 `parent` 或位于其下（纯字符串比较，两侧都应是 resolve 后的路径）。 */
function isUnder(parent, child) {
  if (!isNonEmptyString(parent) || !isNonEmptyString(child)) return false;
  const base = parent.endsWith(sep) ? parent.slice(0, -sep.length) : parent;
  if (base === '') return false;
  return child === base || child.startsWith(`${base}${sep}`);
}

function toIso(now) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function firstReason(reasons) {
  for (const reason of REASON_ORDER) {
    if (reasons.includes(reason)) return reason;
  }
  return reasons.length > 0 ? reasons[0] : LEGACY_REASON.EVIDENCE_COMPLETE;
}

/** 目录路径的两种拼写：resolve 口径（canonical）与 realpath 口径（真实边界）。 */
function pathVariants(...paths) {
  const set = new Set();
  for (const path of paths) {
    if (!isNonEmptyString(path)) continue;
    set.add(canonicalPath(path));
    if (path.endsWith(sep) && path.length > 1) set.add(canonicalPath(path.slice(0, -sep.length)));
  }
  return [...set];
}

/** 从目录里挑出会话日志文件名：版本号大者优先，zstd 与明文一视同仁。 */
function pickLogFile(names) {
  let best = null;
  let bestVersion = -1;
  for (const name of names) {
    const match = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/u.exec(name);
    if (match === null) continue;
    const version = Number.parseInt(match[1], 10);
    if (version > bestVersion) {
      bestVersion = version;
      best = name;
    }
  }
  return best;
}

/** 取首个非空行的 JSON 对象（截断前缀只可能拿到半行，解析失败返回 null）。 */
function firstJsonLine(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('{')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

function isSessionHeader(header) {
  return isPlainObject(header) && header.type === 'session' && isNonEmptyString(header.cwd);
}

/**
 * 子代理判定：按宿主 header 的实际字段来。
 * `origin`/`source` 为 `subagent`、`delegationDepth > 0`、`parentSession` 非空，任一成立
 * 即视为子代理；字段读不到（header 为空）由调用方按「证据不足」处理。
 */
function isSubagentHeader(header) {
  if (!isPlainObject(header)) return false;
  if (header.origin === 'subagent' || header.source === 'subagent') return true;
  if (Number.isInteger(header.delegationDepth) && header.delegationDepth > 0) return true;
  if (isNonEmptyString(header.parentSession)) return true;
  return false;
}

/** 读取文件开头 `limit` 字节；文件不存在返回 null。 */
async function readPrefix(path, limit) {
  let handle = null;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// ── 探测器：会话日志头 ────────────────────────────────────────────────────────

/**
 * 真实磁盘 header 读取器：扫 `<dshHome>/sessions/<bucket>/<sessionId>/session.v*.jsonl[.zstd]`。
 * 索引只建一次（惰性），之后按 sessionId 命中；读取走渐进前缀，截断 zstd 也能解出首行。
 * @param {{dshHome: string, diagnostics: object[]}} options
 */
function createHeaderReader({ dshHome, diagnostics }) {
  const cache = new Map();
  let indexPromise = null;

  async function buildIndex() {
    const index = new Map();
    const base = join(dshHome, 'sessions');
    let buckets = [];
    try {
      buckets = await readdir(base, { withFileTypes: true });
    } catch {
      return index;
    }
    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;
      const bucketPath = join(base, bucket.name);
      let children = [];
      try {
        children = await readdir(bucketPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        const directory = join(bucketPath, child.name);
        let names = [];
        try {
          names = await readdir(directory);
        } catch {
          continue;
        }
        const log = pickLogFile(names);
        if (log === null) continue;
        // 同名目录出现在多个 bucket 时保留先遇到的（宿主不会这样，但不猜）。
        if (!index.has(child.name)) index.set(child.name, join(directory, log));
      }
    }
    return index;
  }

  async function readHeaderFile(path) {
    const compressed = path.endsWith('.zstd');
    for (const limit of HEADER_READ_LIMITS) {
      let buffer = null;
      try {
        buffer = await readPrefix(path, limit);
      } catch (error) {
        diagnostics.push({ code: LEGACY_DIAGNOSTIC.HEADER_READ_FAILED, path, detail: String(error?.code ?? error) });
        return { header: null, logPath: path, reason: LEGACY_REASON.HEADER_UNREADABLE };
      }
      if (buffer === null) return null;
      let text = null;
      if (compressed) {
        if (typeof zlib.zstdDecompressSync !== 'function') {
          return { header: null, logPath: path, reason: LEGACY_REASON.HEADER_UNREADABLE };
        }
        try {
          text = zlib.zstdDecompressSync(buffer).toString('utf8');
        } catch {
          continue; // 前缀还不够解出一帧，继续加长
        }
      } else {
        text = buffer.toString('utf8');
      }
      const parsed = firstJsonLine(text);
      if (parsed === null) continue; // 首个 header 行被截断
      if (!isSessionHeader(parsed)) {
        return { header: null, logPath: path, reason: LEGACY_REASON.HEADER_INVALID };
      }
      return { header: parsed, logPath: path };
    }
    return { header: null, logPath: path, reason: LEGACY_REASON.HEADER_UNREADABLE };
  }

  return {
    /** @returns {Promise<{header: object|null, logPath: string, reason?: string}|null>} */
    async read(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      if (cache.has(sessionId)) return cache.get(sessionId);
      const index = await (indexPromise ??= buildIndex());
      const path = index.get(sessionId) ?? index.get(sessionId.replace(/^session-/u, '')) ?? null;
      const result = path === null ? null : await readHeaderFile(path);
      cache.set(sessionId, result);
      return result;
    },
  };
}

// ── 探测器：原生 registry ─────────────────────────────────────────────────────

/** 读 `<dshHome>/storages/workspace.json`，兼容单位化对象与数组两种表形状。 */
async function readRegistryFromDisk(dshHome) {
  const raw = await readJsonFile(join(dshHome, 'storages', 'workspace.json'));
  if (raw === null) return null;
  const table = isPlainObject(raw?.tables?.workspaces)
    ? raw.tables.workspaces
    : Array.isArray(raw?.tables?.workspaces)
      ? raw.tables.workspaces
      : isPlainObject(raw?.workspaces)
        ? raw.workspaces
        : null;
  if (table === null) return null;
  const workspaces = [];
  const entries = Array.isArray(table) ? table.map((value, index) => [String(index), value]) : Object.entries(table);
  for (const [id, value] of entries) {
    if (!isPlainObject(value)) continue;
    if (!isNonEmptyString(value.path)) continue;
    const sessionIds = Array.isArray(value.sessionIds)
      ? value.sessionIds.filter((sessionId) => isNonEmptyString(sessionId))
      : [];
    workspaces.push({ id: isNonEmptyString(value.id) ? value.id : id, path: value.path, sessionIds });
  }
  const archivedSessionIds = Array.isArray(raw?.global?.archivedSessionIds)
    ? raw.global.archivedSessionIds.filter((sessionId) => isNonEmptyString(sessionId))
    : [];
  return { workspaces, archivedSessionIds };
}

/**
 * 归一化 registry 快照，并建「sessionId → workspaceId」认领表。
 * 同一会话被多个 workspace 登记时不猜，记 diagnostic 并保留首个认领者。
 */
function normalizeRegistry(snapshot, diagnostics) {
  const workspaces = [];
  const claims = new Map();
  for (const workspace of Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : []) {
    if (!isPlainObject(workspace) || !isNonEmptyString(workspace.path)) continue;
    workspaces.push(workspace);
    for (const sessionId of workspace.sessionIds ?? []) {
      const existing = claims.get(sessionId);
      if (existing === undefined) {
        claims.set(sessionId, workspace.id);
      } else if (existing !== workspace.id) {
        diagnostics.push({
          code: LEGACY_DIAGNOSTIC.REGISTRY_AMBIGUOUS_CLAIM,
          sessionId,
          detail: `${existing} 与 ${workspace.id} 同时登记`,
        });
      }
    }
  }
  const archivedSessionIds = new Set(
    (Array.isArray(snapshot?.archivedSessionIds) ? snapshot.archivedSessionIds : []).filter(isNonEmptyString),
  );
  return { workspaces, claims, archivedSessionIds };
}

// ── 探测器：scope 级账本状态 ──────────────────────────────────────────────────

/**
 * 扫 `<dshHome>/storages/dsh-chat-sessions-lifecycle/<scopeId>/`，只读判断：
 *  - `ledgerExists`：任意 scope 有 ledger.json（迁移已走过，本审计不接管）；
 *  - `migrationCompleted`：migration.json 或 ledger.migration.completed 为 true；
 *  - `residue`：存在 quarantine/ 或 migration.json（曾经有过账本/迁移动作）；
 *  - `weakResidue`：只有 lock.json（可能是首次启动崩溃，不能单独当「曾被 adopt」）。
 */
async function readScopeStateFromDisk({ dshHome, diagnostics }) {
  const state = {
    ledgerExists: false,
    migrationCompleted: false,
    residue: false,
    weakResidue: false,
    migrationSources: [],
  };
  const base = join(dshHome, 'storages', LEDGER_STORAGE_DIRNAME);
  let scopes = [];
  try {
    scopes = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      diagnostics.push({ code: LEGACY_DIAGNOSTIC.SCOPE_UNREADABLE, path: base, detail: String(error?.code ?? error) });
    }
    return state;
  }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const directory = join(base, scope.name);
    let names = [];
    try {
      names = await readdir(directory);
    } catch (error) {
      diagnostics.push({ code: LEGACY_DIAGNOSTIC.SCOPE_UNREADABLE, path: directory, detail: String(error?.code ?? error) });
      continue;
    }
    if (names.includes(LEDGER_FILE)) {
      state.ledgerExists = true;
      state.migrationSources.push(join(directory, LEDGER_FILE));
      const ledger = await readJsonFile(join(directory, LEDGER_FILE));
      if (ledger?.migration?.completed === true) state.migrationCompleted = true;
    }
    if (names.includes(MIGRATION_FILE)) {
      state.residue = true;
      state.migrationSources.push(join(directory, MIGRATION_FILE));
      const migration = await readJsonFile(join(directory, MIGRATION_FILE));
      if (migration?.completed === true) state.migrationCompleted = true;
    }
    if (names.includes(QUARANTINE_DIR)) {
      state.residue = true;
      state.migrationSources.push(join(directory, QUARANTINE_DIR));
    }
    if (names.includes(LOCK_FILE)) state.weakResidue = true;
  }
  return state;
}

// ── 探测器：链接索引（标题入口 / 归档入口）──────────────────────────────────

/** 扫一个目录里的软链接，返回 `Map<目标 canonical 路径, 链接名[]>`。 */
async function scanSymlinks(directory, diagnostics) {
  const map = new Map();
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    let target = null;
    try {
      target = await readlink(path);
    } catch (error) {
      diagnostics.push({ code: LEGACY_DIAGNOSTIC.LINK_READ_FAILED, path, detail: String(error?.code ?? error) });
      continue;
    }
    const resolved = canonicalPath(join(directory, target));
    const real = await realpath(resolved).then(
      (value) => canonicalPath(value),
      () => null,
    );
    for (const key of pathVariants(resolved, real)) {
      const names = map.get(key) ?? [];
      names.push(entry.name);
      map.set(key, names);
    }
  }
  return map;
}

/** 读 `.links.json`（v2 rooms / v1 claims），返回登记过的目标集合与旧认领名。 */
async function readLinksFile(root, diagnostics) {
  const path = join(root, '.links.json');
  const raw = await readJsonFile(path);
  if (raw === null) return { targets: new Set(), claims: new Map(), present: false };
  const targets = new Set();
  const claims = new Map();
  if (isPlainObject(raw.rooms)) {
    for (const target of Object.keys(raw.rooms)) {
      for (const variant of pathVariants(join(root, target), join(root, target.replace(/^\.\.\//u, '')))) {
        targets.add(variant);
      }
    }
  }
  if (isPlainObject(raw.claims)) {
    for (const [sessionId, name] of Object.entries(raw.claims)) {
      if (isNonEmptyString(sessionId)) claims.set(sessionId, String(name ?? ''));
    }
  }
  if (!isPlainObject(raw.rooms) && !isPlainObject(raw.claims)) {
    diagnostics.push({ code: LEGACY_DIAGNOSTIC.LINK_READ_FAILED, path, detail: '无法识别的 .links.json 形状' });
  }
  return { targets, claims, present: true };
}

// ── 目录身份参照 ──────────────────────────────────────────────────────────────

/** 把 `recordedIdentities`（对象或数组）归一化成 `Map<path, {dev, ino}>`。 */
function normalizeRecordedIdentities(input) {
  const map = new Map();
  const push = (path, value) => {
    if (!isNonEmptyString(path) || !isPlainObject(value)) return;
    if (value.dev === undefined || value.ino === undefined) return;
    for (const variant of pathVariants(path)) map.set(variant, { dev: value.dev, ino: value.ino });
  };
  if (Array.isArray(input)) {
    for (const item of input) push(item?.path, item);
  } else if (isPlainObject(input)) {
    for (const [path, value] of Object.entries(input)) push(path, value);
  }
  return map;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

/**
 * 旧数据审计：只读取证，产出迁移候选。
 * @param {object} options 见文件头契约。
 * @returns {Promise<object>} AuditResult。
 */
export async function auditLegacyRooms(options = {}) {
  const diagnostics = [];
  if (!isNonEmptyString(options.root)) throw new TypeError('auditLegacyRooms 需要绝对路径 root');
  const now = options.now ?? Date.now();
  const detect = isPlainObject(options.detect) ? options.detect : {};
  const linksAreAdoptionEvidence = options.linksAreAdoptionEvidence === true;

  const root = canonicalPath(options.root);
  const sessionsRoot = canonicalPath(join(root, '.sessions'));
  const dshHome = canonicalPath(effectiveDshHome(options.dshHome));

  // 真实边界：root 自身可能是软链接，边界比较一律用 realpath。
  const realRoot = await realpath(root).then(canonicalPath, () => null);
  const realSessionsRoot = realRoot === null ? null : canonicalPath(join(realRoot, '.sessions'));

  const headerReader = createHeaderReader({ dshHome, diagnostics });
  const recordedIdentities = normalizeRecordedIdentities(options.recordedIdentities);

  const header = async (sessionId) => {
    let raw = null;
    if (typeof detect.readSessionHeader === 'function') {
      try {
        raw = await detect.readSessionHeader(sessionId);
      } catch (error) {
        diagnostics.push({ code: LEGACY_DIAGNOSTIC.HEADER_READ_FAILED, sessionId, detail: String(error?.code ?? error) });
        raw = null;
      }
    } else {
      raw = await headerReader.read(sessionId);
    }
    if (raw === null || raw === undefined) {
      return { logFound: false, logPath: null, header: null, headerReadable: false, reason: LEGACY_REASON.SESSION_MISSING };
    }
    const parsed = raw.header ?? null;
    if (parsed !== null && !isSessionHeader(parsed)) {
      return { logFound: true, logPath: raw.logPath ?? null, header: null, headerReadable: false, reason: LEGACY_REASON.HEADER_INVALID };
    }
    return {
      logFound: true,
      logPath: raw.logPath ?? null,
      header: parsed,
      headerReadable: parsed !== null,
      reason: parsed === null ? (isNonEmptyString(raw.reason) ? raw.reason : LEGACY_REASON.HEADER_UNREADABLE) : null,
    };
  };

  // ① registry
  let registrySnapshot = null;
  if (typeof detect.listRegistry === 'function') {
    try {
      registrySnapshot = await detect.listRegistry();
    } catch (error) {
      diagnostics.push({ code: LEGACY_DIAGNOSTIC.REGISTRY_READ_FAILED, detail: String(error?.code ?? error) });
    }
  } else {
    try {
      registrySnapshot = await readRegistryFromDisk(dshHome);
    } catch (error) {
      diagnostics.push({ code: LEGACY_DIAGNOSTIC.REGISTRY_UNREADABLE, detail: String(error?.code ?? error) });
    }
  }
  if (Array.isArray(registrySnapshot)) {
    registrySnapshot = { workspaces: registrySnapshot, archivedSessionIds: [] };
  } else if (registrySnapshot !== null && !isPlainObject(registrySnapshot)) {
    diagnostics.push({ code: LEGACY_DIAGNOSTIC.REGISTRY_INVALID, detail: typeof registrySnapshot });
    registrySnapshot = null;
  }
  const registry = normalizeRegistry(registrySnapshot, diagnostics);
  const registryAvailable = registrySnapshot !== null;

  // ② scope 级账本状态
  let scopeState = null;
  if (typeof detect.readScopeState === 'function') {
    try {
      const injected = await detect.readScopeState();
      if (isPlainObject(injected)) {
        scopeState = {
          ledgerExists: injected.ledgerExists === true,
          migrationCompleted: injected.migrationCompleted === true,
          residue: injected.residue === true,
          weakResidue: injected.weakResidue === true,
          migrationSources: (Array.isArray(injected.sources)
            ? injected.sources
            : Array.isArray(injected.migrationSources)
              ? injected.migrationSources
              : []
          ).filter(isNonEmptyString),
        };
      }
    } catch (error) {
      diagnostics.push({ code: LEGACY_DIAGNOSTIC.SCOPE_UNREADABLE, detail: String(error?.code ?? error) });
    }
  }
  scopeState ??= await readScopeStateFromDisk({ dshHome, diagnostics });

  // ③ 链接索引（标题入口 / 归档入口）——只作佐证
  const links = await readLinksFile(root, diagnostics);
  const titleLinks = await scanSymlinks(root, diagnostics);
  const archivedLinks = await scanSymlinks(join(root, '.archive'), diagnostics);

  // registry 索引：先按 resolve 口径建表，realpath 只用于兜底。
  const byPath = new Map();
  for (const workspace of registry.workspaces) {
    const variants = pathVariants(workspace.path);
    for (const variant of variants) {
      if (!byPath.has(variant)) byPath.set(variant, workspace);
    }
  }

  const rooms = [];
  const rejected = [];
  const handled = new Set();
  let registryOutsideRoot = 0;

  /** 找房间对应的 workspace：先 resolve 口径，再 realpath 兜底。 */
  async function findWorkspace(canonicalCwd, realPath) {
    const direct = byPath.get(canonicalCwd) ?? (realPath === null ? undefined : byPath.get(realPath));
    if (direct !== undefined) return direct;
    for (const workspace of registry.workspaces) {
      const resolved = canonicalPath(workspace.path);
      if (!isUnder(root, resolved)) continue;
      const real = await realpath(resolved).then(canonicalPath, () => null);
      if (real !== null && realPath !== null && real === realPath) return workspace;
    }
    return null;
  }

  /** 本次审计的统一成员分类（header 已归一化）。 */
  async function classify({ sessionId, record, canonicalCwd, realPath, workspaceId, claims }) {
    const memberHeader = record.header;
    const subagent = isSubagentHeader(memberHeader);
    // 路径拼写可能不同（祖先软链接），resolve 口径不同时再用 realpath 兜底。
    let cwdMatches = false;
    if (memberHeader !== null) {
      if (canonicalPath(memberHeader.cwd) === canonicalCwd) {
        cwdMatches = true;
      } else if (realPath !== null) {
        const headerReal = await realpath(memberHeader.cwd).then(canonicalPath, () => null);
        cwdMatches = headerReal !== null && headerReal === realPath;
      }
    }
    const eligibility =
      memberHeader === null
        ? ELIGIBILITY.MISSING_SESSION
        : subagent
          ? ELIGIBILITY.CONFLICT
          : cwdMatches
            ? classifyMember({
                header: memberHeader,
                isSubagent: false,
                canonicalCwd,
                workspaceId,
                claimedBy: claims.get(sessionId) ?? null,
              })
            : ELIGIBILITY.CONFLICT;
    const headerIdMismatch = memberHeader !== null && memberHeader.id !== sessionId;
    return {
      sessionId,
      logFound: record.logFound,
      logPath: record.logPath ?? null,
      headerReadable: record.headerReadable,
      headerCwd: memberHeader !== null && isNonEmptyString(memberHeader.cwd) ? memberHeader.cwd : null,
      cwdMatches,
      subagent,
      headerIdMismatch,
      eligibility: headerIdMismatch ? ELIGIBILITY.CONFLICT : eligibility,
      claimedBy: claims.get(sessionId) ?? null,
      reason: record.reason,
    };
  }

  // 扫描 `.sessions`
  let entries = [];
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      diagnostics.push({ code: LEGACY_DIAGNOSTIC.ROOT_MISSING, path: sessionsRoot });
    } else {
      diagnostics.push({ code: LEGACY_DIAGNOSTIC.SESSIONS_UNREADABLE, path: sessionsRoot, detail: String(error?.code ?? error) });
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const path = join(sessionsRoot, entry.name);
    handled.add(canonicalPath(path));
    const reasons = [];
    const memberReasons = [];

    // 非房间形状：root 内但不是本插件的目录（含 `.sessions` 下的普通子目录）。
    const shaped = SESSION_DIR_PATTERN.test(entry.name) && !entry.name.startsWith('.');
    if (!shaped) {
      if (entry.name.startsWith('.')) continue; // .DS_Store 之类的噪声，不列不报
      rejected.push({
        path,
        canonicalPath: canonicalPath(path),
        classification: LEGACY_CLASSIFICATION.REJECTED,
        reason: LEGACY_REASON.NOT_SESSION_DIRECTORY,
        reasons: [LEGACY_REASON.NOT_SESSION_DIRECTORY],
        preserve: true,
      });
      continue;
    }

    // 软链接房间：v0.1.x 在 `.sessions` 下只会建真实目录，链接一律交人工。
    if (entry.isSymbolicLink()) {
      const target = await realpath(path).then(canonicalPath, () => null);
      let reason = LEGACY_REASON.SYMLINK_DIRECTORY;
      if (target === null) {
        reason = LEGACY_REASON.SYMLINK_UNRESOLVED;
      } else if (realRoot === null || (!isUnder(realRoot, target) && !(realSessionsRoot !== null && isUnder(realSessionsRoot, target)))) {
        reason = LEGACY_REASON.SYMLINK_ESCAPES_ROOT;
      }
      rejected.push({
        path,
        canonicalPath: canonicalPath(target ?? path),
        classification: LEGACY_CLASSIFICATION.REJECTED,
        reason,
        reasons: [reason],
        preserve: true,
      });
      continue;
    }

    if (!entry.isDirectory()) {
      rejected.push({
        path,
        canonicalPath: canonicalPath(path),
        classification: LEGACY_CLASSIFICATION.REJECTED,
        reason: LEGACY_REASON.NOT_SESSION_DIRECTORY,
        reasons: [LEGACY_REASON.NOT_SESSION_DIRECTORY],
        preserve: true,
      });
      continue;
    }

    // ② 真实目录
    const canonicalCwd = canonicalPath(path);
    let directoryStat = null;
    let children = [];
    try {
      directoryStat = await stat(path);
      children = await readdir(path, { withFileTypes: true });
    } catch (error) {
      diagnostics.push({ code: LEGACY_DIAGNOSTIC.DIRECTORY_UNREADABLE, path, detail: String(error?.code ?? error) });
    }
    const empty = children.length === 0;
    const roomMarker = children.some((child) => child.name === ROOM_MARKER_FILE);

    // 软链接旁路（root 自身是软链接时 canonicalCwd 与 realPath 不同，边界仍按 realpath）
    const realPath = await realpath(path).then(canonicalPath, () => null);
    const workspace = await findWorkspace(canonicalCwd, realPath);
    const workspaceId = workspace?.id ?? null;
    const registrySessionIds = workspace?.sessionIds ?? [];

    // ③ 成员会话头
    const ownerSessionId = entry.name;
    const memberIds = [];
    if (!memberIds.includes(ownerSessionId)) memberIds.push(ownerSessionId);
    for (const sessionId of registrySessionIds) {
      if (!memberIds.includes(sessionId)) memberIds.push(sessionId);
    }
    const members = [];
    for (const sessionId of memberIds) {
      const record = await header(sessionId);
      const detail = await classify({
        sessionId,
        record,
        canonicalCwd,
        realPath,
        workspaceId,
        claims: registry.claims,
      });
      const role = sessionId === ownerSessionId ? 'owner' : 'member';
      // 非 owner 成员的异常只把这个成员排除出认领范围（设计 R14：子代理、已删会话
      // 不被批量认领），不因此否掉整个房间——房间证据只由 owner 的三条证据决定。
      let excluded = null;
      if (role === 'member') {
        if (detail.eligibility === ELIGIBILITY.USER_OWNED) excluded = LEGACY_REASON.USER_OWNED;
        else if (detail.subagent) excluded = LEGACY_REASON.SUBAGENT_MEMBER;
        else if (!detail.logFound) excluded = LEGACY_REASON.SESSION_MISSING;
        else if (!detail.headerReadable) excluded = detail.reason ?? LEGACY_REASON.HEADER_UNREADABLE;
        else if (detail.headerIdMismatch) excluded = LEGACY_REASON.HEADER_ID_MISMATCH;
        else if (!detail.cwdMatches) excluded = LEGACY_REASON.CWD_MISMATCH;
      }
      members.push({ ...detail, role, excluded });
    }
    const ownerMember = members[0];

    // 链接佐证
    const titleNames = [
      ...(titleLinks.get(canonicalCwd) ?? []),
      ...(realPath === null ? [] : (titleLinks.get(realPath) ?? [])),
      ...(links.targets.has(canonicalCwd) || (realPath !== null && links.targets.has(realPath)) ? ['links.json'] : []),
    ];
    const archivedNames = [
      ...(archivedLinks.get(canonicalCwd) ?? []),
      ...(realPath === null ? [] : (archivedLinks.get(realPath) ?? [])),
    ];
    const legacyClaim = links.claims.get(ownerSessionId) ?? null;

    // 目录身份：registry 有登记但目录被整体替换
    let directoryIdentity = null;
    if (directoryStat !== null) {
      directoryIdentity = { dev: String(directoryStat.dev), ino: String(directoryStat.ino) };
    }
    const recorded =
      recordedIdentities.get(canonicalCwd) ?? (realPath === null ? undefined : recordedIdentities.get(realPath)) ?? null;
    if (recorded !== null && directoryStat !== null) {
      if (classifyDirectory({ directoryIdentity: recorded }, directoryStat) === 'identity-changed') {
        addReason(reasons, LEGACY_REASON.DIRECTORY_IDENTITY_CHANGED);
      }
    }

    // 「曾被 adopt 过」的硬证据：无账本时才用于判 ledger-missing。
    const adoption = {
      scopeMigrated: scopeState.migrationCompleted === true,
      ledgerResidue: scopeState.residue === true,
      roomMarker,
      titleLink: titleNames.length > 0,
      archivedLink: archivedNames.length > 0,
      ledgerExists: scopeState.ledgerExists === true,
    };
    const previouslyAdopted =
      scopeState.ledgerExists === false &&
      (adoption.scopeMigrated ||
        adoption.ledgerResidue ||
        adoption.roomMarker ||
        (linksAreAdoptionEvidence && (adoption.titleLink || adoption.archivedLink || legacyClaim !== null)));

    // 分类：账本状态优先（迁移已走过 / 账本丢失都不许自动 adopt）
    if (scopeState.ledgerExists === true) {
      addReason(reasons, LEGACY_REASON.LEDGER_PRESENT);
    }
    if (previouslyAdopted) {
      addReason(reasons, LEGACY_REASON.LEDGER_MISSING);
    }

    // 空目录且没有任何日志：已归档空房间 / 空目录，保留但不可 adopt
    const ownerLogFound = ownerMember.logFound;
    if (empty && !ownerLogFound) {
      addReason(reasons, archivedNames.length > 0 ? LEGACY_REASON.ARCHIVED_EMPTY_DIRECTORY : LEGACY_REASON.EMPTY_DIRECTORY);
    }

    // registry 证据
    if (workspace === null) {
      addReason(reasons, LEGACY_REASON.REGISTRY_MISSING);
    } else if (registrySessionIds.length === 0) {
      addReason(reasons, LEGACY_REASON.REGISTRY_MEMBERS_MISSING);
    }

    // 房间级证据只认 owner（目录 basename 对应的会话）
    if (!(empty && !ownerLogFound)) {
      if (!ownerMember.logFound) addReason(reasons, LEGACY_REASON.SESSION_MISSING);
    }
    if (ownerMember.headerReadable === false) {
      addReason(reasons, ownerMember.reason ?? LEGACY_REASON.HEADER_UNREADABLE);
    }
    if (ownerMember.headerIdMismatch) addReason(reasons, LEGACY_REASON.HEADER_ID_MISMATCH);
    if (ownerMember.subagent) addReason(reasons, LEGACY_REASON.SUBAGENT_MEMBER);
    if (ownerMember.logFound && ownerMember.headerReadable && !ownerMember.cwdMatches) {
      addReason(reasons, LEGACY_REASON.CWD_MISMATCH);
    }
    if (
      ownerMember.eligibility === ELIGIBILITY.CONFLICT &&
      !ownerMember.subagent &&
      !ownerMember.headerIdMismatch &&
      ownerMember.cwdMatches
    ) {
      addReason(reasons, LEGACY_REASON.MEMBER_CONFLICT);
    }
    // 外来认领（另一个 workspace 已认领 owner）意味着房间归属有争议，仍然阻塞。
    const exclusions = members
      .filter((member) => member.role === 'member' && member.excluded !== null)
      .map((member) => ({ sessionId: member.sessionId, reason: member.excluded }));
    for (const member of members) {
      if (member.eligibility === ELIGIBILITY.USER_OWNED) addReason(reasons, LEGACY_REASON.USER_OWNED);
    }
    for (const exclusion of exclusions) {
      if (!memberReasons.includes(exclusion.reason)) memberReasons.push(exclusion.reason);
    }

    const evidence = {
      directory: {
        present: directoryStat !== null,
        empty,
        symlink: false,
        archivedLink: archivedNames.length > 0,
        titleLink: titleNames.length > 0,
        entryCount: children.length,
        realPath,
      },
      registry: {
        matched: workspace !== null,
        path: workspace?.path ?? null,
        sessionIds: [...registrySessionIds],
        hasMembers: registrySessionIds.length > 0,
      },
      session: {
        logFound: ownerMember.logFound,
        headerReadable: ownerMember.headerReadable,
        cwdMatches: ownerMember.cwdMatches,
        subagent: ownerMember.subagent,
        headerCwd: ownerMember.headerCwd,
        logPath: ownerMember.logPath,
      },
      links: {
        recorded: links.targets.has(canonicalCwd) || (realPath !== null && links.targets.has(realPath)),
        title: titleNames.length > 0,
        archived: archivedNames.length > 0,
        legacyClaim,
      },
      adoption,
    };
    evidence.score = {
      directory: evidence.directory.present,
      registry: evidence.registry.matched && evidence.registry.hasMembers,
      session:
        evidence.session.logFound &&
        evidence.session.headerReadable &&
        evidence.session.cwdMatches &&
        !evidence.session.subagent &&
        ownerMember.eligibility === ELIGIBILITY.ELIGIBLE,
    };

    const adoptable = reasons.length === 0 && Object.values(evidence.score).every(Boolean);
    const classification = previouslyAdopted
      ? LEGACY_CLASSIFICATION.LEDGER_MISSING
      : adoptable
        ? LEGACY_CLASSIFICATION.ADOPTABLE
        : LEGACY_CLASSIFICATION.AMBIGUOUS;

    rooms.push({
      classification,
      adoptable,
      conflictCandidate: classification === LEGACY_CLASSIFICATION.LEDGER_MISSING,
      preserve: true,
      reason: firstReason(reasons),
      reasons: [...reasons],
      memberReasons: [...memberReasons],
      memberExclusions: exclusions,
      ownerSessionId,
      cwd: canonicalCwd,
      canonicalCwd,
      realPath,
      directoryIdentity,
      workspaceId,
      members,
      evidence,
    });
  }

  // registry 里落在 root 内、但不是房间形状的登记：明确拒绝（不当候选）。
  let registryRoomMissing = 0;
  let registryRoomMissingArchived = 0;
  let registryRoomMissingReported = 0;
  for (const workspace of registry.workspaces) {
    const resolved = canonicalPath(workspace.path);
    if (!isUnder(root, resolved)) {
      registryOutsideRoot += 1;
      continue;
    }
    if (handled.has(resolved)) continue;
    if (isUnder(sessionsRoot, resolved)) {
      // `.sessions/<id>` 有登记但磁盘上没有这个目录：不造房间，只计数 + 有限诊断。
      registryRoomMissing += 1;
      const sessionId = resolved.slice(resolved.lastIndexOf(sep) + 1);
      if (registry.archivedSessionIds.has(sessionId)) {
        registryRoomMissingArchived += 1;
        continue;
      }
      if (registryRoomMissingReported < 20) {
        diagnostics.push({ code: LEGACY_DIAGNOSTIC.REGISTRY_ROOM_MISSING, path: resolved, workspaceId: workspace.id });
        registryRoomMissingReported += 1;
      } else if (registryRoomMissingReported === 20) {
        diagnostics.push({
          code: LEGACY_DIAGNOSTIC.REGISTRY_ROOM_MISSING,
          detail: '其余同类登记已省略，见 scope.registryRoomMissing',
        });
        registryRoomMissingReported += 1;
      }
      continue;
    }
    rejected.push({
      path: resolved,
      canonicalPath: resolved,
      classification: LEGACY_CLASSIFICATION.REJECTED,
      reason: LEGACY_REASON.NOT_SESSION_DIRECTORY,
      reasons: [LEGACY_REASON.NOT_SESSION_DIRECTORY],
      workspaceId: workspace.id,
      preserve: true,
    });
    handled.add(resolved);
  }

  // 对账：房间候选 = adoptable + ambiguous + ledger-missing
  const counts = {
    rooms: rooms.length,
    adoptable: rooms.filter((room) => room.classification === LEGACY_CLASSIFICATION.ADOPTABLE).length,
    ambiguous: rooms.filter((room) => room.classification === LEGACY_CLASSIFICATION.AMBIGUOUS).length,
    ledgerMissing: rooms.filter((room) => room.classification === LEGACY_CLASSIFICATION.LEDGER_MISSING).length,
    rejected: rejected.length,
    preserved: rooms.length + rejected.length,
  };
  if (counts.adoptable + counts.ambiguous + counts.ledgerMissing !== counts.rooms) {
    diagnostics.push({ code: 'COUNT_MISMATCH', detail: '房间分类计数与候选数不一致' });
  }

  return {
    generatedAt: toIso(now),
    root,
    canonicalRoot: root,
    rootResolved: realRoot !== null,
    sessionsRoot,
    scope: {
      ledgerExists: scopeState.ledgerExists,
      migrationCompleted: scopeState.migrationCompleted,
      residue: scopeState.residue,
      weakResidue: scopeState.weakResidue,
      migrationSources: [...scopeState.migrationSources],
      registryAvailable,
      registryWorkspaces: registry.workspaces.length,
      registryOutsideRoot,
      registryRoomMissing,
      registryRoomMissingArchived,
    },
    counts,
    rooms,
    adoptable: rooms.filter((room) => room.classification === LEGACY_CLASSIFICATION.ADOPTABLE),
    ledgerMissing: rooms.filter((room) => room.classification === LEGACY_CLASSIFICATION.LEDGER_MISSING),
    rejected,
    diagnostics,
  };
}

/**
 * 把 adoptable 房间转成账本房间草稿（只构造数据，不写账本）。
 *
 * 只有 `classification === 'adoptable'` 才返回；其余一律 `null`——ledger-missing 与
 * ambiguous 必须走人工或 coordinator 的冲突流程，不能借这个函数偷偷接管。
 * @param {object} room `auditLegacyRooms` 的 `rooms[]` 元素。
 * @param {{now?: number|Date}} [options]
 * @returns {object|null}
 */
export function legacyRoomDraft(room, { now = Date.now() } = {}) {
  if (!isPlainObject(room) || room.classification !== LEGACY_CLASSIFICATION.ADOPTABLE) return null;
  if (room.adoptable !== true) return null;
  const eligible = room.members.filter((member) => member.eligibility === ELIGIBILITY.ELIGIBLE);
  return {
    ownerSessionId: room.ownerSessionId,
    cwd: room.cwd,
    canonicalCwd: room.canonicalCwd,
    directoryIdentity: room.directoryIdentity === null ? null : { ...room.directoryIdentity },
    workspaceId: room.workspaceId ?? null,
    state: ROOM_STATE.MANAGED,
    operation: null,
    sessionIds: eligible.map((member) => member.sessionId),
    members: room.members.map((member) => ({
      sessionId: member.sessionId,
      role: member.role,
      eligibility: member.eligibility,
      lastSeenAt: null,
    })),
    lastError: null,
    updatedAt: toIso(now),
  };
}
