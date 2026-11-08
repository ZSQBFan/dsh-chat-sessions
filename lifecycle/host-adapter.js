/**
 * 宿主适配层：把「原生管理器 / 工作区注册表 / 会话持久化」收敛成生命周期需要的少数几个动作。
 *
 * 这里只做两件事：
 *  1. 把宿主能力（尤其是「能不能判断这次卸载是用户显式停用」）如实暴露出来，供上层降级；
 *  2. 把原生调用包成带错误捕获的异步动作，绝不抛出到宿主 disposer 之外。
 *
 * G0 实测（RUN-20261107-0410，dsh 0.2.2-rc.1）：
 *  - 插件停用/包停用时，原生管理器会 await 异步 disposer（barrier 1500ms → 操作耗时 1683ms）。
 *  - dispose 期间 `pluginManager` 仍然可用；`shutdown` 期间它已经不存在。
 *    因此「拿不到 pluginManager」= 进程退出，不交接。
 *  - 显式停用会先把 `disabled: true` 写进 profile 的 patch 层再重载，
 *    所以 dispose 时读 `listPlugins()` 看到的是**已经落盘的事实**，不是事后猜测。
 *  - disposer 抛错时原生只记日志，仍然完成卸载（fiber 进入 DISPOSED），
 *    所以失败必须由我们自己记进账本，而不能指望宿主回报。
 */

/** 本插件在宿主里的包名；用于在插件行里认出自己。 */
export const PACKAGE_NAME = 'dsh-chat-sessions';

/** 卸载原因：只有前三项意味着「用户显式要求解除登记」。 */
export const UNLOAD = Object.freeze({
  PLUGIN_DISABLE: 'PLUGIN_DISABLE',
  BUNDLE_DISABLE: 'BUNDLE_DISABLE',
  BUNDLE_REMOVE: 'BUNDLE_REMOVE',
  RELOAD: 'RELOAD',
  UNKNOWN: 'UNKNOWN',
});

/** 需要交接的原因集合。 */
export const DETACH_REASONS = Object.freeze([UNLOAD.PLUGIN_DISABLE, UNLOAD.BUNDLE_DISABLE, UNLOAD.BUNDLE_REMOVE]);

/**
 * 宿主能力矩阵。`conditionalDelete: false` 是实测结论而不是保守估计：
 * `workspaceRegistry` 只暴露 `delete(id)`，没有「按快照比对后再删」的原子入口，
 * `Workspace.mutate` 只能串行写单个房间、也不能删除房间本身。
 * 因此「原生条件校验」只能退化为「删除前立刻复读 + 删除后复读」，窗口存在但极窄。
 */
export const HOST_CAPABILITY = Object.freeze({
  conditionalDelete: false,
  conditionalAttach: false,
  disposeReasonBridge: 'plugin-manager-state',
  ungroupedSessionChat: true,
});

/** 宿主调用失败的统一包装：保留 code，绝不把原始堆栈写进账本。 */
function hostError(action, cause) {
  const code = typeof cause?.code === 'string' && cause.code !== '' ? cause.code : 'HOST_CALL_FAILED';
  return {action, code, message: typeof cause?.message === 'string' ? cause.message : String(cause)};
}

/** 安全取服务：dispose 期间服务可能已经消失，取值本身也可能抛错。 */
function service(ctx, name) {
  try {
    return ctx?.get?.(name);
  } catch {
    return undefined;
  }
}

/** 读取插件行的模块名（不同版本字段名略有差异）。 */
function moduleNameOf(row) {
  return row?.moduleName ?? row?.name ?? row?.meta?.name ?? '';
}

/** 判断一行插件记录是不是本插件。 */
function isOwnRow(row, moduleName) {
  const name = moduleNameOf(row);
  if (name === moduleName) return true;
  return String(row?.entryId ?? '').includes(moduleName);
}

/**
 * 判断这次 dispose 的原因。
 *
 * 判定顺序（全部基于宿主**已经持久化**的事实）：
 *  1. `pluginManager` 不可用 → UNKNOWN（进程退出 / 根 fiber 卸载），不交接；
 *  2. 插件行存在且 `enabled === false` → PLUGIN_DISABLE；
 *  3. 插件行存在且 `enabled === true` → RELOAD（HMR / 依赖重启），保留登记；
 *  4. 插件行消失：bundle 行 `enabled === false` → BUNDLE_DISABLE；
 *  5. 插件行与 bundle 行都消失 → BUNDLE_REMOVE（包已被移除）；
 *  6. 其余 → UNKNOWN。
 *
 * 注意：这里不订阅 `plugin-manager/changed` 之类的**事后**事件——那些事件在
 * disposer 之后才到，不能作为「用户显式停用」的前置证据。
 * @param {object} ctx 插件上下文。
 * @param {{moduleName?: string}} [options]
 * @returns {Promise<{reason: string, managerAvailable: boolean, detail: object}>}
 */
export async function describeUnload(ctx, {moduleName = PACKAGE_NAME} = {}) {
  const manager = service(ctx, 'pluginManager');
  if (manager === undefined || typeof manager.listPlugins !== 'function') {
    return {reason: UNLOAD.UNKNOWN, managerAvailable: false, detail: {why: 'pluginManager-unavailable'}};
  }
  let rows;
  let bundles;
  try {
    [rows, bundles] = await Promise.all([
      manager.listPlugins(),
      typeof manager.listBundles === 'function' ? manager.listBundles() : Promise.resolve([]),
    ]);
  } catch (error) {
    return {reason: UNLOAD.UNKNOWN, managerAvailable: true, detail: hostError('list-plugins', error)};
  }

  const bundle = (Array.isArray(bundles) ? bundles : []).find((entry) => {
    if (entry?.name === moduleName) return true;
    if (Array.isArray(entry?.rows) && entry.rows.some((row) => isOwnRow(row, moduleName))) return true;
    return String(entry?.source ?? '').includes(moduleName);
  });
  // removeBundle 的 disposer 可能先于 plugin row 清理执行；bundle 已消失时，
  // own row 仍可能短暂保留 enabled:true，包状态优先于插件行状态。
  if (bundle === undefined && Array.isArray(bundles)) {
    return {reason: UNLOAD.BUNDLE_REMOVE, managerAvailable: true, detail: {why: 'bundle-absent'}};
  }
  if (bundle?.enabled === false) {
    return {reason: UNLOAD.BUNDLE_DISABLE, managerAvailable: true, detail: {bundle: bundle.name ?? null}};
  }

  const own = (Array.isArray(rows) ? rows : []).filter((row) => isOwnRow(row, moduleName));
  if (own.length > 0) {
    const disabled = own.every((row) => row?.enabled === false);
    return {
      reason: disabled ? UNLOAD.PLUGIN_DISABLE : UNLOAD.RELOAD,
      managerAvailable: true,
      detail: {rows: own.map((row) => ({entryId: row.entryId, enabled: row.enabled, fiberPhase: row.fiberPhase}))},
    };
  }

  if (bundle === undefined) {
    return {reason: UNLOAD.BUNDLE_REMOVE, managerAvailable: true, detail: {why: 'bundle-absent'}};
  }
  return {reason: UNLOAD.UNKNOWN, managerAvailable: true, detail: {why: 'rows-absent-bundle-enabled'}};
}

/**
 * 读取原生工作区登记快照。
 *
 * 只取「登记事实」，不做任何归属推断：调用方拿它和账本比对。
 * @param {object} ctx 插件上下文。
 * @returns {Promise<{ok: boolean, workspaces: object[], claimedBy: Map<string, string>, error?: object}>}
 */
export async function readRegistry(ctx) {
  const registry = service(ctx, 'workspaceRegistry');
  if (registry === undefined || typeof registry.list !== 'function') {
    return {ok: false, workspaces: [], claimedBy: new Map(), error: {action: 'registry', code: 'HOST_CALL_FAILED', message: 'workspaceRegistry unavailable'}};
  }
  try {
    const entities = await registry.list();
    const workspaces = [];
    const claimedBy = new Map();
    for (const entity of Array.isArray(entities) ? entities : []) {
      const sessionIds = Array.isArray(entity?.sessionIds) ? [...entity.sessionIds] : [];
      workspaces.push({
        id: entity?.id ?? '',
        path: entity?.path ?? entity?.canonicalPath ?? '',
        title: entity?.title ?? '',
        sessionIds,
      });
      for (const sessionId of sessionIds) claimedBy.set(sessionId, entity?.id ?? '');
    }
    return {ok: true, workspaces, claimedBy};
  } catch (error) {
    return {ok: false, workspaces: [], claimedBy: new Map(), error: hostError('registry-list', error)};
  }
}

/**
 * 读取会话 header；日志不存在时返回 `null`（不创建、不修复）。
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
export async function readSessionHeader(ctx, sessionId) {
  const persistence = service(ctx, 'sessionPersistence');
  if (persistence === undefined || typeof persistence.stat !== 'function') return null;
  try {
    const result = await persistence.stat(sessionId);
    const header = result?.header ?? result ?? null;
    if (header === null || typeof header !== 'object') return header;
    // 真实 DSH 的 stat 结果在不同版本分别出现过 identity.cwd 与 record.identity.cwd；
    // 生命周期模型统一消费顶层 cwd，避免把同 cwd 派生会话误判为 FOREIGN。
    const identityCwd = header.identity?.cwd ?? header.record?.identity?.cwd;
    const cwd = typeof header.cwd === 'string' ? header.cwd : identityCwd;
    // stat().header 是逻辑元数据，真实宿主会去掉 JSONL 行的 type；只对有身份、版本、cwd 的
    // 持久 header 补上该判别字段，不把空对象或任意 stat 结果伪装成会话头。
    const logicalHeader = header.type === undefined && header.id === sessionId
      && Number.isInteger(header.version) && typeof cwd === 'string';
    return {...header, ...(typeof cwd === 'string' ? {cwd} : {}), ...(logicalHeader ? {type: 'session'} : {})};
  } catch {
    return null;
  }
}

/** 目录 stat；`null` 表示不存在（绝不 mkdir）。 */
export async function statDirectory(path) {
  try {
    const {stat} = await import('node:fs/promises');
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * 删除一份原生工作区登记。只删登记，目录与日志一律保留。
 * @returns {Promise<{ok: boolean, error?: object}>}
 */
export async function deleteWorkspace(ctx, workspaceId) {
  const registry = service(ctx, 'workspaceRegistry');
  if (registry === undefined || typeof registry.delete !== 'function') {
    return {ok: false, error: {action: 'delete', code: 'HOST_CALL_FAILED', message: 'workspaceRegistry unavailable'}};
  }
  try {
    await registry.delete(workspaceId);
    return {ok: true};
  } catch (error) {
    return {ok: false, error: hostError('delete-workspace', error)};
  }
}

/**
 * 创建（或复用原生已有的）工作区登记。
 *
 * 宿主对同一 canonical 路径返回既有实体且不改标题，所以**返回值的 `created`
 * 必须由调用方用删除前的快照判断**——这里只报告「调用是否成功」与「拿到的 id」。
 * @returns {Promise<{ok: boolean, workspaceId?: string, error?: object}>}
 */
export async function createWorkspace(ctx, path, title) {
  const registry = service(ctx, 'workspaceRegistry');
  if (registry === undefined || typeof registry.create !== 'function') {
    return {ok: false, error: {action: 'create', code: 'HOST_CALL_FAILED', message: 'workspaceRegistry unavailable'}};
  }
  try {
    const entity = await registry.create(path, title);
    return {ok: true, workspaceId: entity?.id ?? ''};
  } catch (error) {
    return {ok: false, error: hostError('create-workspace', error)};
  }
}

/**
 * 把成员挂回工作区。逐个成员单独判定，失败只影响该成员。
 *
 * 宿主没有「条件挂接」入口，所以每挂一个之前先跑调用方的 `verify(sessionId)`（重新读原生
 * 快照，确认这个会话还没被别人认领、目标工作区仍是同一个）。`verify` 返回 false 时该成员
 * 记为失败而不是硬挂上去。
 * @param {{verify?: (sessionId: string) => Promise<boolean>}} [options]
 * @returns {Promise<{attached: string[], failed: Array<{sessionId: string, error: object}>, missing: boolean}>}
 */
export async function attachSessions(ctx, workspaceId, sessionIds, options = {}) {
  const verify = typeof options.verify === 'function' ? options.verify : null;
  const registry = service(ctx, 'workspaceRegistry');
  const attached = [];
  const failed = [];
  if (registry === undefined || typeof registry.get !== 'function') {
    return {attached, failed: sessionIds.map((sessionId) => ({sessionId, error: {action: 'attach', code: 'HOST_CALL_FAILED', message: 'workspaceRegistry unavailable'}})), missing: true};
  }
  for (const sessionId of sessionIds) {
    try {
      if (verify !== null && (await verify(sessionId)) === false) {
        failed.push({sessionId, error: {action: 'attach', code: 'ATTACH_PRECONDITION_FAILED', message: 'member or workspace changed before attach'}});
        continue;
      }
      const entity = await registry.get(workspaceId);
      if (entity === undefined || entity === null) return {attached, failed, missing: true};
      if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)) {
        attached.push(sessionId);
        continue;
      }
      await entity.attachSession(sessionId);
      attached.push(sessionId);
    } catch (error) {
      failed.push({sessionId, error: hostError('attach-session', error)});
    }
  }
  return {attached, failed, missing: false};
}
