/**
 * dsh-chat-sessions — 生命周期账本存储（L1）。
 *
 * 职责：账本目录与 scopeId 定位、原子读写、单 writer 锁、坏账本隔离、快照。
 *
 * 不变量：
 *  1. `open()` 对损坏内容不抛错：状态置为 `invalid`，把原件**复制**到
 *     `quarantine/`（不覆盖、不删除），随后 `read()`／`update()` 抛
 *     `LEDGER_INVALID`，等待人工干预。
 *  2. 写路径只在 `<effectiveDSHHome>/storages/dsh-chat-sessions-lifecycle/<scopeId>/`
 *     内：临时文件同目录、`rename` 原子替换、fsync 父目录；失败时原文件不变。
 *  3. 锁只在「pid 不存活」或「租约过期」时回收；锁文件不可解析等不确定状态一律
 *     视为被持有，绝不删除别人的锁。长事务用心跳续租，提交前再做 token／revision
 *     fencing：锁易主或基线 revision 变了就抛 `LOCK_LOST`／`REVISION_CONFLICT`，
 *     绝不覆盖别人已提交的内容。
 *  4. 首次安装完成后写独立的 `initialized.json` 标记（fsync + rename）。标记在、
 *     账本却缺失或损坏 → `invalid`（诊断码 `LEDGER_MISSING_AFTER_INIT`），绝不
 *     静默按首次安装重建 generation=1。只有「标记也没有」才是真正的首次安装。
 *  5. 目录 fsync 的错误分开处理：平台不支持（EPERM／EINVAL／ENOTSUP／EBADF 等）
 *     降级为已知限制 `limitations`；真实 I/O 故障（EIO／ENOSPC／EDQUOT 等）抛
 *     `LEDGER_DURABILITY_UNKNOWN`——此时 rename 已发生、提交持久性不确定，
 *     调用方应进入 DEGRADED 并对账。
 *  6. 账本只记录 ID／路径／阶段／错误码／时间，绝不写入对话内容。
 *
 * 契约：docs/lifecycle/04-IMPLEMENTATION-CONTRACT.md §2、§4、§5。
 */
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  DEFAULT_PLUGIN_ID,
  DEFAULT_PROFILE_ID,
  REASON,
  LedgerInvalidError,
  canonicalPath,
  createLedger,
  normalizeLedger,
  scopeIdentity,
} from './model.js';

export { LedgerInvalidError };

/** 缺省锁租约：30 秒（契约 §5）。 */
export const DEFAULT_LOCK_LEASE_MS = 30_000;
/** 账本目录相对 `<effectiveDSHHome>` 的固定层级。 */
const LEDGER_HOME_SEGMENTS = ['storages', 'dsh-chat-sessions-lifecycle'];
/**
 * 「本 scope 曾经完成过初始化」的独立标记文件名（与 ledger.json 分离）。
 *
 * 存在性即证据：内容损坏、scopeId 不匹配、无读权限都按「曾经初始化」处理，
 * 宁可让 store 进 invalid 等人工干预，也不能把丢账本当首次安装重建。
 */
const INITIALIZATION_MARKER_FILE = 'initialized.json';
const INITIALIZATION_MARKER_SCHEMA_VERSION = 1;
/** 诊断码：标记在而账本缺失（等价于设计 §8.2 的「丢失 ≠ 新安装」）。 */
export const LEDGER_MISSING_AFTER_INIT = 'LEDGER_MISSING_AFTER_INIT';
/**
 * 目录 fsync 的「平台不支持」错误码白名单。
 *
 * 命中的话 rename 语义仍然成立（同目录原子替换），只是无法再确认目录项落盘，
 * 降级为已知限制；不在白名单里的一律当真实 I/O 故障上报（fail-safe）。
 */
/** 提交历史：每次成功提交追加一行完整状态，用于「提交后才发现锁易主」时回滚到接管者的内容。 */
const HISTORY_FILE = 'history.jsonl';
/** 历史最多保留的条目数（打开时裁剪，只留最近若干条）。 */
const HISTORY_LIMIT = 10;

const DIRECTORY_FSYNC_UNSUPPORTED_CODES = new Set([
  'EPERM',
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EBADF',
  'EISDIR',
  'EACCES',
  'ENOSYS',
]);

/** 锁被其他存活 writer 持有（或无法判定时保守拒绝）。 */
export class LockHeldError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LockHeldError';
    this.code = 'LOCK_HELD';
  }
}

/** `LedgerWriteError.code` 的固定取值（契约 §5 之外新增的失败语义）。 */
export const WRITE_ERROR_CODE = Object.freeze({
  /** 写入没有发生，磁盘内容未变。 */
  WRITE_FAILED: 'LEDGER_WRITE_FAILED',
  /** 锁已易主或租约过期：本次事务不再持有写权限，未提交。 */
  LOCK_LOST: 'LOCK_LOST',
  /** 基线 revision 已被其他 writer 推进：拒绝覆盖，未提交。 */
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  /** rename 已发生，但目录持久性无法确认：调用方应进 DEGRADED 并对账。 */
  DURABILITY_UNKNOWN: 'LEDGER_DURABILITY_UNKNOWN',
});

/**
 * 账本写入失败。
 *
 * `code` 默认 `LEDGER_WRITE_FAILED`（磁盘未变）；fencing 与持久性失败用
 * `WRITE_ERROR_CODE` 里的其它值，`durabilityUnknown` 表示 rename 已发生。
 */
export class LedgerWriteError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LedgerWriteError';
    this.code = typeof options.code === 'string' && options.code !== '' ? options.code : WRITE_ERROR_CODE.WRITE_FAILED;
    this.durabilityUnknown = options.durabilityUnknown === true;
  }
}

/**
 * 有效 DSH 数据根：显式参数 > `DSH_HOME` > `~/.dsh`（契约 §2）。
 * @param {unknown} explicit 调用方传入的 dshHome。
 * @returns {string} 绝对路径。
 */
export function effectiveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return canonicalPath(explicit);
  const fromEnvironment = process.env.DSH_HOME;
  if (typeof fromEnvironment === 'string' && fromEnvironment !== '') return canonicalPath(fromEnvironment);
  return canonicalPath(join(homedir(), '.dsh'));
}

/**
 * 一个 scope 的账本目录。
 *
 * `scopeId` 的字符集是白名单，`dshHome` 必须是绝对路径，从根上排除 `..` 越界。
 * @param {{dshHome: string, scopeId: string}} options
 * @returns {string} 绝对目录路径。
 */
export function ledgerDirectory({ dshHome, scopeId } = {}) {
  if (typeof dshHome !== 'string' || dshHome === '' || !isAbsolute(dshHome)) {
    throw new TypeError('ledgerDirectory 需要绝对路径 dshHome');
  }
  if (typeof scopeId !== 'string' || !/^[0-9a-f]{32}$/u.test(scopeId)) {
    throw new TypeError('ledgerDirectory 需要 32 位小写十六进制 scopeId');
  }
  return join(canonicalPath(dshHome), ...LEDGER_HOME_SEGMENTS, scopeId);
}

/** 账本读写、锁与隔离的唯一入口。 */
export class LedgerStore {
  #identity;
  #scopeId;
  #directory;
  #path;
  #markerPath;
  #historyPath;
  #clock;
  #leaseMs;
  #status = 'absent';
  #state = null;
  #diagnostics = [];
  #limitations = [];
  #initializationMarker = 'absent';
  #directoryFsync = 'unknown';
  #queue = Promise.resolve();
  #closed = false;

  /**
   * 打开（或初始化）一个 scope 的账本。
   *
   * 目录不存在时只创建账本目录；`ledger.json` 要到首次 `update()` 才建立，
   * 因此全新 scope 的 `status` 是 `absent` 而不是伪造出的空账本。
   * @param {{dshHome?: string, profileId?: string, canonicalRoot: string,
   *          pluginId?: string, now?: number|Date|(() => number|Date), leaseMs?: number}} options
   * @returns {Promise<LedgerStore>}
   */
  static async open({ dshHome, profileId, canonicalRoot, pluginId, now, leaseMs } = {}) {
    if (typeof canonicalRoot !== 'string' || canonicalRoot === '') throw new TypeError('LedgerStore.open 需要 canonicalRoot');
    const absoluteRoot = canonicalPath(canonicalRoot);
    if (!isAbsolute(absoluteRoot)) throw new TypeError('LedgerStore.open 的 canonicalRoot 必须是绝对路径');

    let resolvedHome = effectiveDshHome(dshHome);
    try {
      resolvedHome = canonicalPath(await realpath(resolvedHome));
    } catch {
      // 数据根尚未建立：保留 resolve 结果，账本目录稍后一并创建。
    }
    let resolvedRoot = absoluteRoot;
    let rootResolved = false;
    try {
      resolvedRoot = canonicalPath(await realpath(absoluteRoot));
      rootResolved = true;
    } catch {
      rootResolved = false;
    }

    const identity = {
      pluginId: typeof pluginId === 'string' && pluginId !== '' ? pluginId : DEFAULT_PLUGIN_ID,
      profileId: typeof profileId === 'string' && profileId !== '' ? profileId : DEFAULT_PROFILE_ID,
      dshHome: resolvedHome,
      canonicalRoot: resolvedRoot,
      rootResolved,
    };
    const store = new LedgerStore({ identity, clock: now, leaseMs });
    await store.#initialize();
    return store;
  }

  constructor({ identity, clock, leaseMs }) {
    this.#identity = identity;
    this.#scopeId = scopeIdentity(identity);
    this.#directory = ledgerDirectory({ dshHome: identity.dshHome, scopeId: this.#scopeId });
    this.#path = join(this.#directory, 'ledger.json');
    this.#markerPath = join(this.#directory, INITIALIZATION_MARKER_FILE);
    this.#historyPath = join(this.#directory, HISTORY_FILE);
    this.#clock = clock;
    this.#leaseMs = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : DEFAULT_LOCK_LEASE_MS;
  }

  /** `ledger.json` 的绝对路径。 */
  get path() {
    return this.#path;
  }

  /** 初始化标记 `initialized.json` 的绝对路径（与账本同目录、互相独立）。 */
  get markerPath() {
    return this.#markerPath;
  }

  /** `'ready' | 'invalid' | 'absent'`。 */
  get status() {
    return this.#status;
  }

  /** 只读诊断副本；`invalid` 时至少一条。 */
  get diagnostics() {
    return this.#diagnostics.map((entry) => ({ ...entry }));
  }

  /**
   * 已知平台限制（不是本次故障）；只读副本。
   *
   * 目前只会出现 `DIRECTORY_FSYNC_UNSUPPORTED`：该平台不允许 fsync 目录，
   * rename 仍原子，但目录项落盘无法确认。
   */
  get limitations() {
    return this.#limitations.map((entry) => ({ ...entry }));
  }

  /** 初始化标记的最近一次读取结果：`'present' | 'absent' | 'unreadable'`。 */
  get initializationMarker() {
    return this.#initializationMarker;
  }

  /**
   * 读取账本深拷贝。
   * @returns {Promise<object|null>} 未建立账本时返回 `null`；`invalid` 时抛 `LedgerInvalidError`。
   */
  async read() {
    if (this.#status === 'invalid') throw this.#invalidError();
    if (this.#status === 'absent') return null;
    return structuredClone(this.#state);
  }

  /**
   * 加锁 → 重读 → mutator → 校验 → 原子写 → 解锁。
   *
   * 同一个 store 上的调用由进程内 promise 链串行；跨 store／跨进程由 `lock.json`
   * 串行。mutator 可以原地修改，也可以返回新对象；抛错时磁盘内容不变。
   * @param {(state: object) => (object|void|Promise<object|void>)} mutator
   * @returns {Promise<{state: object, revision: number}>}
   */
  async update(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('update 需要 mutator 函数');
    if (this.#closed) throw new LedgerWriteError('账本 store 已关闭');
    if (this.#status === 'invalid') throw this.#invalidError();
    const run = () => this.#updateExclusive(mutator);
    const result = this.#queue.then(run, run);
    // 队列吞掉上一次的失败，避免一个被拒绝的 update 卡死后续写入。
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 只读快照；坏账本也能给出字节数与哈希。 */
  async snapshot() {
    let exists = true;
    let raw = null;
    try {
      raw = await readFile(this.#path);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        exists = false;
      } else {
        throw new LedgerWriteError(`读取账本快照失败: ${error.message}`, { cause: error });
      }
    }
    let revision = null;
    let schemaVersion = null;
    let roomCount = 0;
    if (exists) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'));
        revision = Number.isSafeInteger(parsed?.revision) ? parsed.revision : null;
        schemaVersion = parsed?.schemaVersion ?? null;
        roomCount = Array.isArray(parsed?.rooms) ? parsed.rooms.length : 0;
      } catch {
        // 坏账本仍可快照字节数与哈希，结构字段保持 null。
      }
    }
    const lock = await readLockFile(join(this.#directory, 'lock.json'));
    return {
      path: this.#path,
      exists,
      bytes: exists ? raw.length : 0,
      hash: exists ? sha256(raw) : null,
      revision,
      schemaVersion,
      roomCount,
      lockHeld: lockBlocks(lock, Date.now()),
      initializationMarker: this.#initializationMarker,
      directoryFsync: this.#directoryFsync,
    };
  }

  /** 停止接受新的 update；不删除账本、锁或目录。 */
  async close() {
    this.#closed = true;
    await this.#queue;
  }

  // ── 初始化与坏账本隔离 ────────────────────────────────────────────────────

  async #initialize() {
    try {
      await mkdir(this.#directory, { recursive: true });
    } catch (error) {
      this.#status = 'invalid';
      this.#diagnostics.push({
        code: REASON.LEDGER_WRITE_FAILED,
        message: `无法创建账本目录: ${error.message}`,
      });
      return;
    }
    await this.#loadFromDisk();
    await this.#pruneHistory();
  }

  /**
   * 从磁盘判定 ready／absent／invalid，`open()` 与每次 `update()` 共用。
   *
   * 关键区别：`ledger.json` 缺失只有在「初始化标记也不存在」时才算首次安装；
   * 标记在而账本没了 → `LEDGER_MISSING_AFTER_INIT`，保持 invalid，绝不重建。
   */
  async #loadFromDisk({ reconcileHistory = true } = {}) {
    const marker = await this.#readInitializationMarker();
    this.#initializationMarker = marker;
    let raw;
    try {
      raw = await readFile(this.#path);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#state = null;
        if (marker === 'absent') {
          this.#status = 'absent';
          this.#diagnostics = [];
          return;
        }
        this.#status = 'invalid';
        this.#diagnostics = [{
          code: LEDGER_MISSING_AFTER_INIT,
          message: `账本缺失，但初始化标记${marker === 'unreadable' ? '无法读取（按已初始化处理）' : '仍然存在'}：`
            + '不能当作首次安装重建 generation=1，需人工恢复或显式重建',
          ...(marker === 'unreadable' ? {} : { markerPath: this.#markerPath }),
        }];
        return;
      }
      this.#state = null;
      this.#status = 'invalid';
      this.#diagnostics = [{ code: REASON.LEDGER_INVALID, message: `无法读取账本: ${error.message}` }];
      return;
    }
    await this.#adopt(raw);
    // 账本在、标记不在（老版本升级或标记被误删）：账本才是权威，补写标记。
    if (this.#status === 'ready' && marker !== 'present') await this.#repairInitializationMarker();
    // 账本比提交历史更旧：上次提交后崩溃／回滚未完成，按历史恢复（诊断留痕）。
    if (reconcileHistory && this.#status === 'ready') await this.#reconcileWithHistory();
  }

  /**
   * 读初始化标记：只看「能不能读到」。
   * @returns {Promise<'present'|'absent'|'unreadable'>}
   */
  async #readInitializationMarker() {
    try {
      await readFile(this.#markerPath);
      return 'present';
    } catch (error) {
      return error?.code === 'ENOENT' ? 'absent' : 'unreadable';
    }
  }

  /** 账本已在、标记缺失时补写；失败只记诊断，不否决已经可读的账本。 */
  async #repairInitializationMarker() {
    try {
      await this.#writeInitializationMarker(this.#state);
    } catch (error) {
      this.#diagnostics.push({
        code: REASON.LEDGER_WRITE_FAILED,
        message: `初始化标记补写失败（账本本身可读）: ${error.message}`,
      });
    }
  }

  /** 校验一份磁盘内容；坏内容只隔离，不覆盖原件。 */
  async #adopt(raw) {
    let parsed;
    try {
      parsed = normalizeLedger(JSON.parse(raw.toString('utf8')));
    } catch (error) {
      await this.#quarantine(raw, error, REASON.LEDGER_INVALID);
      return;
    }
    if (parsed.scopeId !== this.#scopeId) {
      const message = `账本 scopeId 与本进程不一致: ${parsed.scopeId} != ${this.#scopeId}`;
      await this.#quarantine(raw, new LedgerInvalidError(message), REASON.SCOPE_MISMATCH);
      return;
    }
    this.#state = parsed;
    this.#status = 'ready';
    this.#diagnostics = [];
  }

  async #quarantine(raw, error, code) {
    const directory = join(this.#directory, 'quarantine');
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const target = join(directory, `ledger-${stamp}-${randomBytes(4).toString('hex')}.json`);
    let quarantinePath = null;
    let quarantineError = null;
    try {
      await mkdir(directory, { recursive: true });
      await copyFile(this.#path, target);
      quarantinePath = target;
    } catch (copyError) {
      quarantineError = copyError.message;
    }
    this.#status = 'invalid';
    this.#state = null;
    this.#diagnostics.push({
      code,
      message: error instanceof Error ? error.message : String(error),
      ...(raw === null ? {} : { rawPreview: preview(raw) }),
      ...(quarantinePath === null ? {} : { quarantinePath }),
      ...(quarantineError === null ? {} : { quarantineError }),
    });
  }

  #invalidError() {
    const first = this.#diagnostics[0];
    if (first === undefined) return new LedgerInvalidError('账本不可用');
    return new LedgerInvalidError(`账本不可用（${first.code}）: ${first.message}`);
  }

  // ── 更新事务 ──────────────────────────────────────────────────────────────

  async #updateExclusive(mutator) {
    if (this.#status === 'invalid') throw this.#invalidError();
    const token = await this.#acquireLock();
    const heartbeat = this.#startLeaseHeartbeat(token);
    try {
      await this.#reload();
      if (this.#status === 'invalid') throw this.#invalidError();
      const firstInstall = this.#status === 'absent';
      const base = firstInstall ? createLedger(this.#identity, { now: this.#now() }) : this.#state;
      const draft = structuredClone(base);
      const returned = await mutator(draft);
      const candidate = returned === undefined ? draft : returned;
      let normalized;
      try {
        normalized = normalizeLedger(candidate);
      } catch (error) {
        if (error instanceof LedgerInvalidError) throw error;
        throw new LedgerInvalidError(`mutator 返回的账本非法: ${error.message}`, { cause: error });
      }
      if (normalized.scopeId !== this.#scopeId) throw new LedgerInvalidError('update 不得改写 scopeId');
      normalized.scopeId = this.#scopeId;
      normalized.identity = { ...this.#identity };
      normalized.revision = base.revision + 1;
      normalized.updatedAt = new Date(this.#now()).toISOString();
      // 心跳已经确认失锁（或续租失败）：不再尝试写入，避免覆盖接管者。
      if (heartbeat.lost) throw this.#leaseLostError(heartbeat);
      await this.#writeAtomic(normalized, {
        token,
        expectedRevision: base.revision,
        baseAbsent: firstInstall,
      });
      // 首次安装：账本落盘后补写独立初始化标记；标记失败时账本已提交，
      // 下次 open 会按「账本在、标记缺」补写，不会误判成丢账本。
      if (firstInstall) await this.#writeInitializationMarker(normalized);
      this.#state = normalized;
      this.#status = 'ready';
      return { state: structuredClone(normalized), revision: normalized.revision };
    } finally {
      this.#stopLeaseHeartbeat(heartbeat);
      // 等在途续租落地，再释放锁：否则它可能在 unlink 之后把 lock.json 写回来。
      await heartbeat.settled;
      await this.#releaseLock(token);
    }
  }

  /** 在锁内重读磁盘，吸收其他 writer 已提交的 revision（并复核初始化标记）。 */
  async #reload() {
    await this.#loadFromDisk({ reconcileHistory: false });
  }

  // ── 原子写 ────────────────────────────────────────────────────────────────

  /**
   * 临时文件 → fsync → fencing → rename → 目录 fsync。
   *
   * fencing 放在 rename 之前：确认锁还是自己的、磁盘 revision 仍等于本次基线，
   * 任何一条不成立就抛 `LOCK_LOST`／`REVISION_CONFLICT`，临时文件被清理。
   * @param {object} state 已归一化的新账本。
   * @param {{token: string, expectedRevision: number, baseAbsent: boolean, allowRecovery?: boolean}} fence
   */
  async #writeAtomic(state, fence) {
    const token = randomBytes(8).toString('hex');
    const temporary = join(this.#directory, `ledger.json.tmp-${token}`);
    const text = `${JSON.stringify(state, null, 2)}\n`;
    let handle = null;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this.#fenceCommit(fence);
      // 先写 prepared 记录并 fsync；只有主账本 rename 成功后才写 committed 记录。
      await this.#appendHistory(state, 'prepared');
      if ((await this.#ownsLock(fence.token)) === false) {
        throw new LedgerWriteError('提交前发现锁已易主或消失，拒绝写入（本次事务未提交）', {
          code: WRITE_ERROR_CODE.LOCK_LOST,
        });
      }
      await rename(temporary, this.#path);
      if ((await this.#ownsLock(fence.token)) === false) {
        const rolled = fence.allowRecovery === false ? false : await this.#rollbackToNewestHistory(state);
        throw new LedgerWriteError(
          rolled
            ? '提交后发现锁已易主：已回滚到接管者最后一次提交，本次写入未生效'
            : '提交后发现锁已易主：未取得恢复锁，本次提交结果待接管者或下次启动对账',
          { code: WRITE_ERROR_CODE.LOCK_LOST },
        );
      }
      await this.#appendHistory(state, 'committed');
      // 仅在 history 里确有更新提交时恢复，并如实报告 LOCK_LOST。
      if ((await this.#ownsLock(fence.token)) === false) {
        const rolled = fence.allowRecovery === false ? false : await this.#rollbackToNewestHistory(state);
        throw new LedgerWriteError(
          rolled
            ? '提交后发现锁已易主：已回滚到接管者最后一次提交，本次写入未生效'
            : '提交后发现锁已易主：未取得恢复锁，本次提交结果待接管者或下次启动对账',
          { code: WRITE_ERROR_CODE.LOCK_LOST },
        );
      }
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error instanceof LedgerWriteError
        ? error
        : new LedgerWriteError(`账本写入失败: ${error.message}`, { cause: error });
    }
    await this.#syncDirectory();
  }

  /** 锁文件里的 token 还是不是自己。 */
  async #ownsLock(token) {
    const lock = await readLockFile(join(this.#directory, 'lock.json'));
    return lock !== null && lock !== 'unreadable' && typeof lock === 'object' && !Array.isArray(lock) && lock.token === token;
  }

  /** 追加一行完整状态并 fsync history 文件；失败时主账本尚未替换。 */
  async #appendHistory(state, phase = 'committed') {
    const text = `${JSON.stringify({at: new Date().toISOString(), phase, generation: state.generation, revision: state.revision, state})}\n`;
    let handle = null;
    try {
      handle = await open(this.#historyPath, 'a', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } catch (error) {
      const committed = phase === 'committed';
      throw new LedgerWriteError(
        committed
          ? `提交历史写入失败（主账本已替换，持久性不确定）: ${error.message}`
          : `提交历史准备失败，主账本尚未替换: ${error.message}`,
        {
          cause: error,
          code: committed ? WRITE_ERROR_CODE.DURABILITY_UNKNOWN : WRITE_ERROR_CODE.WRITE_FAILED,
          ...(committed ? {durabilityUnknown: true} : {}),
        },
      );
    } finally {
      if (handle !== null) await handle.close().catch(() => {});
    }
  }

  /** 读历史中最新的已验证提交；generation/revision 都必须与状态信封一致。 */
  async #readNewestHistory() {
    let text;
    try {
      text = await readFile(this.#historyPath, 'utf8');
    } catch {
      return null;
    }
    let best = null;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry === null || typeof entry !== 'object' || entry.state === undefined) continue;
      if (entry.phase === 'prepared') continue;
      if (entry.phase !== undefined && entry.phase !== 'committed') continue;
      try {
        const state = normalizeLedger(entry.state);
        const generation = Number(state.generation);
        const revision = Number(state.revision);
        if (state.scopeId !== this.#scopeId
          || !Number.isSafeInteger(generation)
          || !Number.isSafeInteger(revision)
          || Number(entry.generation) !== generation
          || Number(entry.revision) !== revision) continue;
        const candidate = {generation, revision, state};
        if (best === null || compareCommit(candidate, best) > 0) best = candidate;
      } catch {
        // History is advisory recovery data. Invalid or foreign entries never overwrite a valid ledger.
      }
    }
    return best;
  }

  /** 在新的锁内按历史安全恢复；失锁 writer 自身不能直接 rename。 */
  async #recoverHistorySafely(mine) {
    let token;
    try {
      token = await this.#acquireRecoveryLock();
    } catch {
      return false;
    }
    const heartbeat = this.#startLeaseHeartbeat(token);
    try {
      await this.#reload();
      if (this.#status === 'invalid') return false;
      const current = this.#state;
      const newest = await this.#readNewestHistory();
      const baseline = current ?? mine;
      if (newest === null || compareCommit(newest, commitOf(baseline)) <= 0) return false;
      if (current !== null && compareCommit(commitOf(current), newest) >= 0) return false;
      await this.#writeAtomic(newest.state, {
        token,
        expectedRevision: current?.revision ?? 0,
        baseAbsent: current === null,
        allowRecovery: false,
      });
      this.#state = structuredClone(newest.state);
      this.#status = 'ready';
      this.#diagnostics.push({code: WRITE_ERROR_CODE.LOCK_LOST, message: `已在新锁内恢复到 generation=${newest.generation}, revision=${newest.revision}`});
      return true;
    } catch {
      return false;
    } finally {
      this.#stopLeaseHeartbeat(heartbeat);
      await heartbeat.settled;
      await this.#releaseLock(token);
    }
  }

  /** 失锁后只通过新锁进行补偿，永远不直接覆盖接管者。 */
  async #rollbackToNewestHistory(mine) {
    return this.#recoverHistorySafely(mine);
  }

  /** 打开时裁剪历史，必须与 writer 共享同一把锁并同步目录项。 */
  async #pruneHistory() {
    let token;
    try { token = await this.#acquireLock(); } catch { return; }
    const heartbeat = this.#startLeaseHeartbeat(token);
    try {
      let text;
      try { text = await readFile(this.#historyPath, 'utf8'); } catch { return; }
      const lines = text.split('\n').filter((line) => line.trim() !== '');
      if (lines.length <= HISTORY_LIMIT * 2) return;
      const keep = lines.slice(-HISTORY_LIMIT);
      const temporary = join(this.#directory, `history.jsonl.tmp-${randomBytes(8).toString('hex')}`);
      let handle = null;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(`${keep.join('\n')}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        if (!(await this.#ownsLock(token))) throw new LockHeldError('裁剪历史前锁已易主');
        await rename(temporary, this.#historyPath);
        await this.#syncDirectory();
      } finally {
        if (handle !== null) await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
      }
    } catch (error) {
      this.#diagnostics.push({code: REASON.LEDGER_WRITE_FAILED, message: `历史裁剪失败: ${error.message}`});
    } finally {
      this.#stopLeaseHeartbeat(heartbeat);
      await heartbeat.settled;
      await this.#releaseLock(token);
    }
  }

  /**
   * 打开时的历史对账：必须在独占锁内重新读取当前 ledger，并通过 revision fence 写回。
   */
  async #reconcileWithHistory() {
    const newest = await this.#readNewestHistory();
    if (newest === null) return;
    const current = this.#state;
    if (current !== null && compareCommit(newest, commitOf(current)) <= 0) return;
    let token;
    try { token = await this.#acquireRecoveryLock(); } catch (error) {
      this.#diagnostics.push({code: WRITE_ERROR_CODE.LOCK_LOST, message: `启动历史对账未取得锁: ${error.message}`});
      return;
    }
    const heartbeat = this.#startLeaseHeartbeat(token);
    try {
      await this.#reload();
      if (this.#status === 'invalid') return;
      const latest = this.#state;
      if (latest !== null && compareCommit(newest, commitOf(latest)) <= 0) return;
      const expectedRevision = latest?.revision ?? 0;
      await this.#writeAtomic(newest.state, {
        token,
        expectedRevision,
        baseAbsent: latest === null,
        allowRecovery: false,
      });
      const raw = await readFile(this.#path);
      await this.#adopt(raw);
      this.#diagnostics.push({code: WRITE_ERROR_CODE.LOCK_LOST, message: `启动对账：按历史恢复到 generation=${newest.generation}, revision=${newest.revision}`});
    } catch (error) {
      this.#diagnostics.push({code: REASON.LEDGER_WRITE_FAILED, message: `启动历史对账失败，账本保持原样: ${error.message}`});
    } finally {
      this.#stopLeaseHeartbeat(heartbeat);
      await heartbeat.settled;
      await this.#releaseLock(token);
    }
  }

  /**
   * 提交前 fencing：token 仍是自己、租约未过期、磁盘 revision 仍等于本次基线。
   *
   * 三条都过只说明「此刻」仍独占；rename 与它之间仍有理论窗口（没有 OS 级
   * 条件写原语），但任何已发生的接管都会在这里被拒绝，不会覆盖别人的提交。
   */
  async #fenceCommit({ token, expectedRevision, baseAbsent }) {
    const lockPath = join(this.#directory, 'lock.json');
    const lock = await readLockFile(lockPath);
    if (lock === null || lock === 'unreadable' || typeof lock !== 'object' || Array.isArray(lock) || lock.token !== token) {
      throw new LedgerWriteError('提交前发现锁已易主或消失，拒绝写入（本次事务未提交）', { code: WRITE_ERROR_CODE.LOCK_LOST });
    }
    const lease = typeof lock.leaseExpiresAt === 'string' ? Date.parse(lock.leaseExpiresAt) : Number.NaN;
    if (!Number.isFinite(lease) || lease <= Date.now()) {
      throw new LedgerWriteError('提交前租约已过期，无法确认独占写入权，拒绝写入（本次事务未提交）', { code: WRITE_ERROR_CODE.LOCK_LOST });
    }
    let raw;
    try {
      raw = await readFile(this.#path);
    } catch (error) {
      if (error?.code === 'ENOENT' && baseAbsent) return; // 首次安装：磁盘确实还没有账本
      throw new LedgerWriteError(`提交前无法重读账本，拒绝写入: ${error.message}`, { cause: error });
    }
    if (baseAbsent) {
      throw new LedgerWriteError('提交前发现账本已被其他 writer 建立，拒绝覆盖', { code: WRITE_ERROR_CODE.REVISION_CONFLICT });
    }
    let diskRevision;
    try {
      diskRevision = JSON.parse(raw.toString('utf8'))?.revision;
    } catch {
      diskRevision = undefined;
    }
    if (diskRevision !== expectedRevision) {
      throw new LedgerWriteError(
        `提交前 revision 已变化（磁盘 ${String(diskRevision)} != 本次基线 ${expectedRevision}），拒绝覆盖`,
        { code: WRITE_ERROR_CODE.REVISION_CONFLICT },
      );
    }
  }

  /**
   * fsync 父目录，让 rename 的目录项落盘。
   *
   * 平台不支持目录 fsync → 记一条已知限制后继续；其余错误 → 抛
   * `LEDGER_DURABILITY_UNKNOWN`：rename 已经发生，old-or-new 内容都在，但无法
   * 确认这次提交能挨过掉电／崩溃，调用方应进入 DEGRADED 并对账。
   */
  async #syncDirectory({ durabilityUnknownMessage = '账本目录 fsync 失败（rename 已发生，提交持久性不确定）' } = {}) {
    let handle = null;
    try {
      handle = await open(this.#directory, 'r');
      await handle.sync();
      this.#directoryFsync = 'synced';
    } catch (error) {
      if (DIRECTORY_FSYNC_UNSUPPORTED_CODES.has(error?.code)) {
        this.#directoryFsync = 'unsupported';
        if (!this.#limitations.some((entry) => entry.code === 'DIRECTORY_FSYNC_UNSUPPORTED')) {
          this.#limitations.push({
            code: 'DIRECTORY_FSYNC_UNSUPPORTED',
            message: `平台不允许 fsync 目录（${String(error?.code)}: ${error?.message ?? error}）；rename 仍原子，但目录项落盘无法确认`,
          });
        }
        return;
      }
      this.#directoryFsync = 'unknown';
      const detail = `${String(error?.code ?? 'UNKNOWN')}: ${error?.message ?? error}`;
      this.#diagnostics.push({ code: WRITE_ERROR_CODE.DURABILITY_UNKNOWN, message: detail });
      throw new LedgerWriteError(`${durabilityUnknownMessage}（${detail}）`, {
        cause: error,
        code: WRITE_ERROR_CODE.DURABILITY_UNKNOWN,
        durabilityUnknown: true,
      });
    } finally {
      if (handle !== null) await handle.close().catch(() => {});
    }
  }

  /**
   * 写初始化标记：临时文件 → fsync → rename → 目录 fsync。
   *
   * 只在「账本已经成功落盘」之后调用（首次安装或补写），因此这里的失败意味着
   * 账本已提交、标记可能缺失；错误信息会明确说出来，便于上层判断。
   */
  async #writeInitializationMarker(state) {
    const payload = {
      schemaVersion: INITIALIZATION_MARKER_SCHEMA_VERSION,
      scopeId: this.#scopeId,
      initializedAt: new Date().toISOString(),
      firstRevision: Number.isSafeInteger(state?.revision) ? state.revision : null,
      firstGeneration: Number.isSafeInteger(state?.generation) ? state.generation : null,
    };
    const temporary = join(this.#directory, `${INITIALIZATION_MARKER_FILE}.tmp-${randomBytes(8).toString('hex')}`);
    let handle = null;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.#markerPath);
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw new LedgerWriteError(
        `初始化标记写入失败（账本已提交，标记缺失，下次 open 会补写）: ${error.message}`,
        { cause: error },
      );
    }
    await this.#syncDirectory({ durabilityUnknownMessage: '初始化标记已 rename，但目录持久性不确定' });
    this.#initializationMarker = 'present';
  }

  // ── 单 writer 锁 ──────────────────────────────────────────────────────────

  /** Recovery writes use the same conservative lock acquisition as normal updates. */
  async #acquireRecoveryLock() {
    const deadline = Date.now() + Math.max(1_000, Math.min(this.#leaseMs, 5_000));
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        return await this.#acquireLock();
      } catch (error) {
        lastError = error;
        if (error?.code !== 'LOCK_HELD') throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError ?? new LockHeldError('恢复对账等待锁超时');
  }

  async #acquireLock() {
    const lockPath = join(this.#directory, 'lock.json');
    const token = randomBytes(16).toString('hex');
    const createdAt = Date.now();
    const payload = {
      token,
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date(createdAt).toISOString(),
      leaseExpiresAt: new Date(createdAt + this.#leaseMs).toISOString(),
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await writeFile(lockPath, text, { flag: 'wx', mode: 0o600 });
        return token;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw new LedgerWriteError(`写锁失败: ${error.message}`, { cause: error });
        }
        const existing = await readLockFile(lockPath);
        if (lockBlocks(existing, Date.now())) {
          const holder = existing !== null && typeof existing === 'object' ? existing.pid : 'unknown';
          throw new LockHeldError(`锁被 pid ${String(holder)} 持有（或无法判定）`);
        }
        await this.#reclaimLock(lockPath);
      }
    }
    throw new LockHeldError('回收过期锁后仍无法取得锁');
  }

  // ── 租约心跳与失锁判定 ────────────────────────────────────────────────────

  /**
   * 事务期间按租约 1/3 的节奏续租，避免长 mutator 被别的 writer 合法回收。
   *
   * 定时器 `unref()`：不得因为心跳把进程吊住。续租自身串成一条链（`settled`），
   * 事务结束时先停表、再等这条链落地，最后才释放锁——否则在途续租可能在 unlink
   * 之后把 lock.json 写回来，留下最长一个租约的假锁。
   * @param {string} token 本次事务的锁 token。
   * @returns {{token: string, timer: object|null, lost: boolean, error: Error|null, settled: Promise<void>}}
   */
  #startLeaseHeartbeat(token) {
    const context = { token, timer: null, lost: false, error: null, settled: Promise.resolve() };
    const interval = Math.max(10, Math.min(Math.floor(this.#leaseMs / 3), 10_000));
    context.timer = setInterval(() => {
      // #renewLease 自己吞掉所有异常并置 lost，这里只负责串行化。
      context.settled = context.settled.then(() => this.#renewLease(context));
    }, interval);
    context.timer.unref?.();
    return context;
  }

  #stopLeaseHeartbeat(context) {
    if (context !== null && context !== undefined && context.timer !== null) {
      clearInterval(context.timer);
      context.timer = null;
    }
  }

  /**
   * 续租一次。
   *
   * 先读锁确认 token 仍是自己、租约还没过期，再用「临时文件 + rename」原子替换
   * 锁文件（直接用 writeFile 截断会让并发读者看到半截 JSON）。租约已过期时绝不
   * 写回——那等于「复活」一把可能已被别人回收的锁。
   */
  async #renewLease(context) {
    if (context.lost) return;
    try {
      const lockPath = join(this.#directory, 'lock.json');
      const current = await readLockFile(lockPath);
      if (current === null || current === 'unreadable' || typeof current !== 'object' || Array.isArray(current) || current.token !== context.token) {
        context.lost = true;
        this.#stopLeaseHeartbeat(context);
        return;
      }
      const now = Date.now();
      const expiresAt = typeof current.leaseExpiresAt === 'string' ? Date.parse(current.leaseExpiresAt) : Number.NaN;
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        context.lost = true;
        this.#stopLeaseHeartbeat(context);
        return;
      }
      const payload = {
        ...current,
        leaseExpiresAt: new Date(now + this.#leaseMs).toISOString(),
        renewedAt: new Date(now).toISOString(),
      };
      await this.#writeLockAtomic(lockPath, payload);
    } catch (error) {
      // 续租失败等于「无法证明仍独占」：停表让提交被 fencing 拒绝。
      context.lost = true;
      context.error = error;
      this.#stopLeaseHeartbeat(context);
    }
  }

  /** 原子替换锁文件（同目录临时文件 → rename）。 */
  async #writeLockAtomic(lockPath, payload) {
    const temporary = `${lockPath}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
      await rename(temporary, lockPath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  /** 心跳发现失锁时的统一错误：本次事务未提交，磁盘内容归接管者所有。 */
  #leaseLostError(heartbeat) {
    const cause = heartbeat.error ?? undefined;
    const detail = cause === undefined ? '锁已易主或租约已过期' : `续租失败: ${cause.message}`;
    return new LedgerWriteError(`本事务已失去写锁（${detail}），拒绝提交`, {
      ...(cause === undefined ? {} : { cause }),
      code: WRITE_ERROR_CODE.LOCK_LOST,
    });
  }

  async #reclaimLock(lockPath) {
    const stale = join(this.#directory, `lock.stale-${Date.now()}-${randomBytes(4).toString('hex')}`);
    try {
      await rename(lockPath, stale);
    } catch (error) {
      if (error?.code === 'ENOENT') return; // 持有者刚好释放，直接重试
      throw new LockHeldError(`无法回收锁文件: ${error.message}`, { cause: error });
    }
  }

  async #releaseLock(token) {
    if (token === null || token === undefined) return;
    const lockPath = join(this.#directory, 'lock.json');
    let current;
    try {
      current = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      return; // 锁已消失或被替换：不删除不属于本进程的锁
    }
    if (current?.token !== token) return;
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#diagnostics.push({ code: REASON.LEDGER_WRITE_FAILED, message: `释放锁失败: ${error.message}` });
      }
    }
  }

  #now() {
    const clock = this.#clock;
    const value = typeof clock === 'function' ? clock() : clock;
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return Date.now();
  }
}

function compareCommit(left, right) {
  const revision = Number(left?.revision ?? 0) - Number(right?.revision ?? 0);
  if (revision !== 0) return revision;
  return Number(left?.generation ?? 0) - Number(right?.generation ?? 0);
}

function commitOf(state) {
  return {revision: Number(state?.revision ?? 0), generation: Number(state?.generation ?? 0)};
}


function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function preview(raw) {
  return raw.toString('utf8', 0, Math.min(raw.length, 240)).replace(/[\u0000-\u001f]/gu, ' ');
}

/** @returns {object|null|'unreadable'} */
async function readLockFile(lockPath) {
  let text;
  try {
    text = await readFile(lockPath, 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? null : 'unreadable';
  }
  if (text.trim() === '') return 'unreadable';
  try {
    return JSON.parse(text);
  } catch {
    return 'unreadable';
  }
}

/**
 * 锁是否必须视为「被持有」。
 *
 * 返回 false 只代表证据充分：pid 已不存活，或租约已过期。其余任何不确定情况
 * （不可解析、租约缺失、pid 非法、EPERM）都返回 true，宁可不写也不抢锁。
 */
function lockBlocks(lock, now = Date.now()) {
  if (lock === null) return false;
  if (lock === 'unreadable') return true;
  if (typeof lock !== 'object' || Array.isArray(lock)) return true;
  const lease = typeof lock.leaseExpiresAt === 'string' ? Date.parse(lock.leaseExpiresAt) : Number.NaN;
  if (!Number.isFinite(lease)) return true;
  const pid = lock.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  // Lease expiry is only reclaimable after the recorded owner is confirmed dead.
  // A suspended but live writer must retain ownership; otherwise it can resume after
  // a second process commits and overwrite that commit during rename.
  return processAlive(pid);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EINVAL' || error?.code === 'ERR_OUT_OF_RANGE') return false;
    return true; // EPERM 等：视为存活
  }
}
