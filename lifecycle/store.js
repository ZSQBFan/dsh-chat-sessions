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
 *     内：临时文件同目录、`rename` 原子替换、尽力 fsync 父目录；失败时原文件不变。
 *  3. 锁只在「pid 不存活」或「租约过期」时回收；锁文件不可解析等不确定状态一律
 *     视为被持有，绝不删除别人的锁。
 *  4. 账本只记录 ID／路径／阶段／错误码／时间，绝不写入对话内容。
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

/** 锁被其他存活 writer 持有（或无法判定时保守拒绝）。 */
export class LockHeldError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LockHeldError';
    this.code = 'LOCK_HELD';
  }
}

/** 账本写入失败；调用方应假定磁盘内容未变。 */
export class LedgerWriteError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LedgerWriteError';
    this.code = 'LEDGER_WRITE_FAILED';
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
  #clock;
  #leaseMs;
  #status = 'absent';
  #state = null;
  #diagnostics = [];
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
    this.#clock = clock;
    this.#leaseMs = Number.isFinite(leaseMs) && leaseMs > 0 ? leaseMs : DEFAULT_LOCK_LEASE_MS;
  }

  /** `ledger.json` 的绝对路径。 */
  get path() {
    return this.#path;
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
    let raw;
    try {
      raw = await readFile(this.#path);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#status = 'absent';
        return;
      }
      this.#status = 'invalid';
      this.#diagnostics.push({ code: REASON.LEDGER_INVALID, message: `无法读取账本: ${error.message}` });
      return;
    }
    await this.#adopt(raw);
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
    try {
      await this.#reload();
      if (this.#status === 'invalid') throw this.#invalidError();
      const base = this.#status === 'absent' ? createLedger(this.#identity, { now: this.#now() }) : this.#state;
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
      await this.#writeAtomic(normalized);
      this.#state = normalized;
      this.#status = 'ready';
      return { state: structuredClone(normalized), revision: normalized.revision };
    } finally {
      await this.#releaseLock(token);
    }
  }

  /** 在锁内重读磁盘，吸收其他 writer 已提交的 revision。 */
  async #reload() {
    let raw;
    try {
      raw = await readFile(this.#path);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#state = null;
        this.#status = 'absent';
        return;
      }
      this.#status = 'invalid';
      this.#state = null;
      this.#diagnostics = [{ code: REASON.LEDGER_INVALID, message: `无法读取账本: ${error.message}` }];
      return;
    }
    await this.#adopt(raw);
  }

  // ── 原子写 ────────────────────────────────────────────────────────────────

  async #writeAtomic(state) {
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
      await rename(temporary, this.#path);
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error instanceof LedgerWriteError
        ? error
        : new LedgerWriteError(`账本写入失败: ${error.message}`, { cause: error });
    }
    await this.#syncDirectory();
  }

  async #syncDirectory() {
    let handle = null;
    try {
      handle = await open(this.#directory, 'r');
      await handle.sync();
    } catch {
      // 部分平台不允许 fsync 目录；rename 已保证同目录原子替换，这里只尽力而为。
    } finally {
      if (handle !== null) await handle.close().catch(() => {});
    }
  }

  // ── 单 writer 锁 ──────────────────────────────────────────────────────────

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

// ── 内部工具 ────────────────────────────────────────────────────────────────

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
  if (lease <= now) return false;
  const pid = lock.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
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
