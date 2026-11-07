/**
 * dsh-chat-sessions — host half.
 *
 * Mount points by stage:
 *   S2  POST /chat-sessions/create + GET /chat-sessions/status
 *       mint `session-<uuid>`, create <root>/.sessions/<id>/, create the session there
 *   S6  POST /chat-sessions/link — title → relative symlink in <root>            (links.js)
 *   S7  reclamation of empty standalone session directories                      (gc.js)
 *   S8  archive linkage: move the title symlink under <root>/.archive/           (archive.js)
 *
 * Real directory names never change. The cwd is written into the session header and has no
 * public setter (`ApiSessionCwdConflict`), so every user-visible title lives in the symlink
 * layer above <root>/.sessions/ and the real leaf stays `session-<uuid>`.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import {
  dropRoomLink,
  archiveRoomLink,
  ensureRoomLink,
  findArchivedRoomLink,
  findRoomLink,
  linkTarget,
  readSessionLog,
  restoreRoomLink,
  slugify,
  tidyLinks,
} from './links.js';
import { isSessionDirName, sessionDirPath } from './gc.js';
import { PROCESS_STATE, canonicalPath } from './lifecycle/model.js';
import { LedgerStore, effectiveDshHome } from './lifecycle/store.js';
import { LifecycleCoordinator } from './lifecycle/coordinator.js';

export const name = 'chat-sessions';

/** Services used by this stage; extend only when a stage actually calls them. */
export const inject = ['webServer', 'sessions', 'sessionPersistence', 'sessionController', 'workspaceRegistry'];

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/chat-sessions';

/**
 * The one build id this plugin reports anywhere. `GET /chat-sessions/config` publishes it, the
 * client writes it into `<html data-chat-sessions-build>` and echoes it back with every
 * diagnostics sample, so a report can never compare two different stamps again (round 5 item 2).
 */
export const PLUGIN_BUILD = 'blank-draft-preservation-2026-11-06';
/** Every standalone session directory is named after its session id. */
const SESSION_PREFIX = 'session-';
/**
 * How many orphan rows `GET /chat-sessions/status` lists in `orphanSessions`. The count in
 * `orphans` is always the true total; only the row list is capped (see the R22 note there).
 */
const ORPHAN_REPORT_LIMIT = 200;
/** Ownership modes: `workspace` gives the session its own workspace (see README §16). */
const OWNERSHIP_WORKSPACE = 'workspace';
const OWNERSHIP_BARE = 'bare';
/** Defensive cap on a request body; the client only ever sends a title or an id. */
const MAX_BODY_BYTES = 64 * 1024;

/** Describe any thrown value without leaking a stack into an HTTP reply. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the `flattenUngrouped` switch.
 *
 * S5 hides the synthetic "no workspace" bucket header in the sidebar so that
 * workspace-free sessions read as top-level siblings of the real workspace
 * rows. The stylesheet is shipped by the client half; this switch decides
 * whether it is armed, so the shipped sidebar stays available as a fallback.
 * @param config plugin config; omit the key (or pass true) to keep flipping on.
 * @returns whether the client half should arm the flattening rules.
 */
export function flattenUngrouped(config) {
  return config?.flattenUngrouped !== false;
}

/**
 * Read the `glideMotion` switch: `auto` (default) obeys `prefers-reduced-motion`, `force` glides
 * regardless, `off` never glides.
 *
 * `auto` is the product behaviour, but it makes the reorder animation untestable on a machine whose
 * system setting asks for reduced motion: the FLIP then (correctly) does nothing and
 * `data-chat-sessions-glided` stays 0, which reads exactly like a broken animation in a report.
 * `force` is the explicit opt-in for that case (and for people who want the motion anyway).
 * @param config plugin config.
 * @returns `'auto' | 'force' | 'off'`.
 */
export function glideMotion(config) {
  const value = config?.glideMotion;
  return value === 'force' || value === 'off' ? value : 'auto';
}

/**
 * Read the `seedFirstTurn` switch.
 *
 * Off by default: seeding a turn after creation makes the agent write an already-used
 * turn number on its first real turn and the log then fails validation on the next read
 * (see {@link seedFirstTurn}). Kept as an explicit opt-in so the experiments that need a
 * non-blank session stay reproducible without shipping the corruption by default.
 * @param config plugin config; only an explicit `true` arms the seed.
 * @returns whether a created session should get a closed empty first turn.
 */
/**
 * Which ownership model this root uses.
 *
 * `workspace` (default) registers every standalone session directory as a workspace of its own:
 * DSH only unlocks the native composer for a session that belongs to a workspace, and the session
 * row then renders as a normal top-level sidebar row. `bare` keeps the PRD's literal "no workspace"
 * shape, which the host cannot make typeable today.
 * @param config plugin config (`ownership` optional).
 * @returns `'workspace'` or `'bare'`.
 */
/**
 * Title of a receipt workspace before the session has a title of its own.
 * @param config plugin config; `untitledWorkspaceTitle` overrides the default.
 * @returns the label shown in the composer's workspace chip.
 */
export function untitledWorkspaceTitle(config) {
  const configured = config?.untitledWorkspaceTitle;
  return typeof configured === 'string' && configured !== '' ? configured : '独立对话';
}

/**
 * How the sidebar tree marks a standalone session that is nested inside a real workspace (the room
 * directory lives under `~/.dsh/chats/.sessions/`, and `~/.dsh` is a workspace, so the shipped tree
 * nests our rows under it). `tint` is the default; `prefix` and `off` are kept for later.
 */
export function treeBadgeOf(config) {
  const value = config?.treeBadge;
  // `icon` (default) prepends a chat glyph to the row; `tint` only dims it; `off` leaves the tree
  // untouched. Both markers are visual only — no text, layout or behaviour changes.
  return value === 'tint' || value === 'off' ? value : 'icon';
}

export function ownershipOf(config) {
  return config?.ownership === OWNERSHIP_BARE ? OWNERSHIP_BARE : OWNERSHIP_WORKSPACE;
}

export function seedFirstTurnEnabled(config) {
  return config?.seedFirstTurn === true;
}

/**
 * Resolve the standalone-chat root.
 * @param config plugin config; `root` overrides the DSH_HOME-derived default.
 * @returns absolute `<root>`, which is `$DSH_HOME/chats` unless configured otherwise.
 */
function chatRoot(config) {
  const configured = typeof config?.root === 'string' ? config.root.trim() : '';
  if (configured !== '') return configured;
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(home, 'chats');
}

/**
 * Read one JSON object body.
 * @param req the incoming request.
 * @returns the parsed object, or an empty object for a bodyless request.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('request body must be a JSON object');
  }
  return value;
}

/** Reject callers that are not on this machine; the route is served before the Web auth gate. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress;
  return address === undefined
    || address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

/**
 * Is this cwd one of our standalone session directories?
 *
 * `sessionsRoot` arrives as a list because a session header stores the *realpath* of its cwd
 * while the chat root may contain a symlinked component (macOS `/tmp` → `/private/tmp`, a linked
 * home directory, …). Comparing only the configured spelling silently matched nothing there, which
 * made every standalone session invisible to the sweep.
 * @param cwd cwd recorded in the session header.
 * @param roots accepted spellings of `<root>/.sessions`.
 */
function underSessionsRoot(cwd, roots) {
  if (typeof cwd !== 'string') return false;
  return roots.some((sessionsRoot) => cwd === sessionsRoot || cwd.startsWith(`${sessionsRoot}/`));
}

/** Write one JSON reply. */
function answer(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

/**
 * Close an empty first turn so the session stops counting as blank.
 *
 * Known breakage — do not enable outside experiments. `blank` is a host projection and
 * only `turn/start` clears it (`applySessionListMetadata`,
 * dsh-api-session-controller/lib/index.js:1872). A seeded turn is written *after*
 * `sessionController.create` has already constructed the agent, whose driver phase
 * snapshots `phase.lastTurn` from the `turnBoundary` projection at construction
 * (dsh-agent-loop/lib/index.js:784 and :866). The agent therefore still numbers its
 * first real turn `1` (:951), the log ends up with two `turn/start` events for turn 1,
 * and the next read fails validation: `SessionFormatError: turn/start does not open the
 * expected turn` (dsh-session-format-v3-to-v4/lib/index.js:747). Seeding *before*
 * creation is impossible: `create` refuses a stored log that already has a `turn/start`
 * (`reusable` gate, dsh-api-session-controller/lib/index.js:443) and mints a different
 * id instead. Config `seedFirstTurn` stays off until an un-blanking route that keeps the
 * agent's turn counter consistent exists.
 * @param session the live session to seed.
 */
function seedFirstTurn(session) {
  session.append('turn/start', { turn: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
}

/**
 * Mount the host half.
 * @param ctx the plugin context.
 * @param config plugin config (`root` optional).
 */
export function apply(ctx, config) {
  const root = chatRoot(config);
  const sessionsRoot = join(root, '.sessions');
  /** Every spelling of `<root>/.sessions` a cwd may carry; filled on first async use. */
  let sessionsRoots = [sessionsRoot];

  /** Resolve the realpath of the chat root once, so symlinked roots still match. */
  async function knownSessionsRoots() {
    if (sessionsRoots.length > 1) return sessionsRoots;
    try {
      const [resolvedRoot, resolvedSessions] = [await realpath(root), await realpath(sessionsRoot)];
      sessionsRoots = [...new Set([sessionsRoot, resolvedSessions, join(resolvedRoot, '.sessions')])];
    } catch {
      // A missing root keeps the configured spelling; the sweep creates it on first use.
    }
    return sessionsRoots;
  }

  ctx.logger?.info?.(`[chat-sessions] host half loaded; root=${root}`);

  // ── lifecycle scope ───────────────────────────────────────────────────────────
  // 账本按「稳定 profile 名 + canonical root」定位（见 lifecycle/model.js 的 scopeIdentity），
  // 不用端口、PID 或启动时间：普通重启 / HMR / 无关配置刷新必须落进同一个 scope，
  // 否则已经登记的房间会被当成陌生数据，交接与恢复都无从谈起。
  // `profileContext` 由宿主 app-boot 提供（`{name, dir, ...}`），停用期间依然可读。
  const lifecycleLog = (event) => ctx.logger?.info?.(`[chat-sessions] lifecycle ${JSON.stringify(event)}`);
  // 只有真宿主 ctx（有 `get`）才开账本。测试夹具、jsdom、mock dispose 这类没有宿主上下文的
  // 环境必须完全跳过生命周期层：它们拿不到 profile 身份，更不能往真实 `~/.dsh` 写账本。
  const lifecycleEnabled = typeof ctx?.get === 'function';
  const profileContext = lifecycleEnabled ? ctx.get('profileContext') : undefined;
  const profileId = typeof profileContext?.name === 'string' && profileContext.name !== ''
    ? profileContext.name
    : 'unknown-profile';
  let coordinator;
  /** 开账本 → 对账 creation intent → 恢复上次未完成的交接。失败只降级，不阻塞插件装载。 */
  const lifecycleReady = (async () => {
    if (!lifecycleEnabled) return { ok: false, blocked: 'NO_HOST_CONTEXT' };
    const store = await LedgerStore.open({
      dshHome: effectiveDshHome(),
      profileId,
      canonicalRoot: canonicalPath(root),
      pluginId: 'dsh-chat-sessions',
    });
    coordinator = new LifecycleCoordinator({
      ctx,
      config,
      store,
      log: lifecycleLog,
      // 迁移与账本用同一份 scope 身份：root 用 canonical 路径，profile 用宿主给的稳定名字。
      identity: {
        root: canonicalPath(root),
        profileId,
        dshHome: effectiveDshHome(),
        pluginId: 'dsh-chat-sessions',
      },
    });
    const outcome = await coordinator.start();
    if (outcome.ok === false) ctx.logger?.warn?.(`[chat-sessions] lifecycle blocked: ${outcome.blocked}`);
    return outcome;
  })().catch((error) => {
    ctx.logger?.warn?.(`[chat-sessions] lifecycle unavailable: ${messageOf(error)}`);
    return { ok: false, blocked: 'LIFECYCLE_UNAVAILABLE' };
  });

  /** 写入口闸门：启动恢复中、正在停用、账本坏掉或锁被占用时都不接受新写。 */
  async function lifecycleWritable() {
    if (!lifecycleEnabled) return true;
    await lifecycleReady;
    return coordinator !== undefined && coordinator.canWrite();
  }

  /** 账本写入不可用：不是「稍后就绪」，而是这次请求真的没落盘，路由答 503。 */
  function ledgerUnavailableError(cause) {
    const error = new Error(`lifecycle ledger unavailable: ${messageOf(cause)}`);
    error.code = 'LIFECYCLE_LEDGER_UNAVAILABLE';
    return error;
  }

  /** 当前托管的工作区 id 集合；账本不可用时返回 null（调用方据此整体跳过写操作）。 */
  async function managedWorkspaceIdSet() {
    if (!lifecycleEnabled) return null;
    await lifecycleReady;
    if (coordinator === undefined) return null;
    const described = await coordinator.describe();
    // 进程不在 READY（DEGRADED / QUIESCING / DISPOSED）时托管集合一律为空：
    // 维护逻辑据此跳过所有写操作，不再拿「路径形状」或旧账本内容当许可（复审 R2-F05）。
    if (described.state !== PROCESS_STATE.READY) return new Set();
    return new Set(described.managed.workspaceIds);
  }

  /** 当前托管的会话 id 集合；账本不可用时返回 null。 */
  async function managedSessionIdSet() {
    if (!lifecycleEnabled) return null;
    await lifecycleReady;
    if (coordinator === undefined) return null;
    const described = await coordinator.describe();
    // 同上：不可写时没有任何会话是「可维护」的，避免 DEGRADED 下改标题／建软链接。
    if (described.state !== PROCESS_STATE.READY) return new Set();
    return new Set(described.managed.sessionIds);
  }

  /** 统一的「未就绪」错误，路由据此答 409 而不是 500。 */
  function notReadyError() {
    const error = new Error('lifecycle not ready');
    error.code = 'LIFECYCLE_NOT_READY';
    return error;
  }

  // 交接 disposer：注册得早 → 冻结得早，从这一刻起插件不再接受新写；
  // 已接收的任务在 `drain()` 里等它自己结束（不杀 Agent 回合）。
  // 原生管理器确实 await 异步 disposer（G0-01：1683ms ≈ 1500ms barrier + 开销），
  // 所以账本可以写完再让卸载返回；失败只记进账本，绝不抛出到宿主。
  if (lifecycleEnabled) {
    ctx.effect(() => async () => {
      await lifecycleReady;
      if (coordinator === undefined) return;
      try {
        await coordinator.detach();
      } catch (error) {
        ctx.logger?.warn?.(`[chat-sessions] lifecycle detach failed: ${messageOf(error)}`);
      } finally {
        // 释放单 writer 锁：下次启用/重装必须能直接接管同一个 scope。
        await coordinator.close();
      }
    }, 'chat-sessions: lifecycle handoff');
  }

  /**
   * Create one standalone session: real directory first, then the session bound to it.
   * @returns the created session id and its real cwd.
   */
  async function createStandaloneSession() {
    const sessionId = `${SESSION_PREFIX}${randomUUID()}`;
    const cwd = join(sessionsRoot, sessionId);
    const canonicalCwd = canonicalPath(cwd);
    if (!(await lifecycleWritable())) throw notReadyError();
    // 先落创建意图再建原生对象：崩在中间只会留下一条 PENDING 意图（启动对账时判 ABANDONED），
    // 不会出现「目录在、房间没登记」或「房间登记了、成员没挂上」的半个房间。
    if (coordinator !== undefined) {
      const intent = await coordinator.beginCreate({ sessionId, cwd, canonicalCwd });
      if (intent.ok !== true) {
        // 意图没落盘就不建原生对象：否则会留下「目录/会话都在、账本不知道」的孤儿（验收 F04）。
        const error = ledgerUnavailableError(intent.code);
        coordinator.degrade(intent.code ?? 'LEDGER_WRITE_FAILED', error.message);
        throw error;
      }
    }
    let workspaceId;
    let created;
    try {
      await mkdir(cwd, { recursive: true });
      const ownership = ownershipOf(config);
      // `workspace`: the directory is registered as its own workspace and the session joins it —
      // DSH only hands the native composer to a session that belongs to a workspace (README §11),
      // and `create` rejects `workspaceId` + `cwd` together, so exactly one of them is sent.
      if (ownership === OWNERSHIP_WORKSPACE) {
        // The receipt workspace title is what the composer's workspace chip shows before the session
        // has a title of its own; the raw `session-<uuid>` there reads like a bug, so a neutral label
        // is used and later replaced by the session title (`sweep()`).
        workspaceId = (await ctx.workspaceRegistry.create(cwd, untitledWorkspaceTitle(config))).id;
      }
      created = await ctx.sessionController.create(
        workspaceId === undefined ? { sessionId, cwd } : { sessionId, workspaceId },
      );
    } catch (error) {
      // The directory exists for the session's sake: never leave a half-registered workspace behind.
      if (coordinator !== undefined) await coordinator.abortCreate({ sessionId }).catch(() => {});
      if (workspaceId !== undefined) await ctx.workspaceRegistry.delete(workspaceId).catch(() => {});
      throw error;
    }
    const ownership = ownershipOf(config);
    const live = ctx.sessions.get(created.sessionId);
    const seeded = seedFirstTurnEnabled(config) && live !== undefined;
    if (seeded && live !== undefined) seedFirstTurn(live);
    // A created session may still be physically deferred; flush is the durability barrier
    // that materializes it, so it survives a restart and can be listed by another process.
    await ctx.sessionPersistence.flush();
    const stored = await ctx.sessionPersistence.stat(created.sessionId);
    // 原生对象确认落盘后才收尾意图：`bare` 模式没有工作区登记，可交接的东西不存在，故不入账。
    if (coordinator === undefined) {
      // 无宿主上下文（夹具/模拟环境）：没有账本可写，保持 v0.1.1 的创建语义。
    } else if (workspaceId !== undefined) {
      const directory = await stat(cwd).catch(() => undefined);
      const directoryIdentity = directory === undefined
        ? null
        : { dev: String(directory.dev), ino: String(directory.ino) };
      const finished = await coordinator.finishCreate({ sessionId, cwd, canonicalCwd, workspaceId, directoryIdentity });
      if (finished.ok !== true) {
        // 原生对象已存在、意图仍留在账本里（可对账），但本次请求必须如实报失败并停写。
        const error = ledgerUnavailableError(finished.code);
        error.sessionId = created.sessionId;
        error.workspaceId = workspaceId;
        coordinator.degrade(finished.code ?? 'LEDGER_WRITE_FAILED', error.message);
        throw error;
      }
    } else {
      await coordinator.abortCreate({ sessionId }).catch(() => {});
    }
    return {
      sessionId: created.sessionId,
      cwd,
      workspaceId: workspaceId ?? null,
      ownership,
      seeded,
      stored: stored !== undefined,
    };
  }

  /**
   * Find one reusable standalone Session from the native list projection.
   *
   * `blank` is the Host's exact turn-boundary projection; titles and log heuristics are deliberately
   * absent here. Durable cwd/root membership and the registry archive set keep unrelated sessions out.
   */
  async function reusableBlankSession() {
    let listed;
    try {
      listed = await ctx.sessionController.list({}, new AbortController().signal);
    } catch (error) {
      ctx.logger?.warn?.(`[chat-sessions] blank-session list unavailable: ${messageOf(error)}`);
      return undefined;
    }
    const durable = await ctx.sessionPersistence.list();
    const byId = new Map(durable.map((snapshot) => [snapshot.header.id, snapshot]));
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds ?? []);
    const roots = await knownSessionsRoots();
    for (const summary of listed?.items ?? []) {
      const sessionId = summary?.sessionId;
      if (typeof sessionId !== 'string'
        || summary.blank !== true
        || summary.running !== false
        || summary.busy === true
        || summary.archived === true
        || summary.origin === 'subagent'
        || archived.has(sessionId)) continue;
      const snapshot = byId.get(sessionId);
      if (snapshot === undefined || snapshot.header.origin === 'subagent') continue;
      const cwd = typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : summary.cwd;
      if (!underSessionsRoot(cwd, roots)) continue;
      const live = ctx.sessions.get(sessionId);
      if (live?.status === 'running' || live?.status === 'busy') continue;
      const workspace = ctx.workspaceRegistry.list().find((entry) =>
        entry.sessionIds.includes(sessionId)
        && (entry.path === cwd || resolveSafe(entry.path) === resolveSafe(cwd)));
      if (ownershipOf(config) === OWNERSHIP_WORKSPACE && workspace === undefined) continue;
      return { sessionId, cwd, workspaceId: workspace?.id };
    }
    return undefined;
  }

  /**
   * Reuse a blank Session when requested, falling back to the normal force-create path.
   * A shared promise makes concurrent clicks claim one native blank Session only once.
   */
  let reuseFlight;
  function reuseOrCreateBlank() {
    if (reuseFlight !== undefined) return reuseFlight;
    const flight = (async () => {
      const candidate = await reusableBlankSession();
      if (candidate === undefined) return createStandaloneSession();
      const request = candidate.workspaceId === undefined
        ? { sessionId: candidate.sessionId, cwd: candidate.cwd }
        : { sessionId: candidate.sessionId, workspaceId: candidate.workspaceId };
      const created = await ctx.sessionController.create(request);
      await ctx.sessionPersistence.flush();
      const stored = await ctx.sessionPersistence.stat(created.sessionId);
      return {
        sessionId: created.sessionId,
        cwd: candidate.cwd,
        workspaceId: candidate.workspaceId ?? null,
        ownership: candidate.workspaceId === undefined ? OWNERSHIP_BARE : ownershipOf(config),
        seeded: false,
        stored: stored !== undefined,
        reused: created.sessionId === candidate.sessionId,
      };
    })();
    reuseFlight = flight;
    flight.then(
      () => { if (reuseFlight === flight) reuseFlight = undefined; },
      () => { if (reuseFlight === flight) reuseFlight = undefined; },
    );
    return flight;
  }

  /**
   * Make sure the session directory is registered and the session is attached to it.
   *
   * Needed on two paths: a session revived after its workspace was dropped, and sessions created
   * while this plugin ran in the `bare` mode. Attaching is what puts the session under the row.
   * @param sessionId session whose directory should own itself.
   * @returns the workspace id, or null when the plugin runs in `bare` mode.
   */
  async function ensureSessionWorkspace(sessionId, cwd, preserveMissing = false) {
    if (ownershipOf(config) !== OWNERSHIP_WORKSPACE) return null;
    // 资格闸门：只处理账本里确认由本插件托管的会话。用户停用期间收编的会话、普通工作区
    // 会话和子代理会话都不会因为「路径长得像插件目录」而被重新建目录或补登记。
    await lifecycleReady;
    if (coordinator !== undefined) {
      if ((await coordinator.ownsSession(sessionId)) === false) return null;
      // 恢复/交接进行中，原生变更只能由协调器发起：这里只读现状，不抢跑 create/attach。
      if (coordinator.state !== PROCESS_STATE.READY) {
        const existing = workspaceOf(await resolveDirectory(cwd ?? sessionDirPath(sessionsRoot, sessionId)));
        return existing?.id ?? null;
      }
    }
    // A native archived row still needs its workspace membership. An existing receipt may
    // legitimately point at a reclaimed empty cwd; keep that identity without recreating disk.
    const directory = await resolveDirectory(cwd ?? sessionDirPath(sessionsRoot, sessionId));
    let workspace = workspaceOf(directory);
    if (!preserveMissing || workspace === undefined) await mkdir(directory, { recursive: true });
    workspace ??= await ctx.workspaceRegistry.create(directory, untitledWorkspaceTitle(config));
    if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId);
    return workspace.id;
  }

  /**
   * The directory a persisted session actually lives in.
   *
   * `session-<uuid>` is the normal shape, but an inherited cwd keeps the *previous* session's
   * directory name, so the name — not the id — identifies the directory everywhere below.
   * @param snapshot one row of `sessionPersistence.list()`.
   * @returns the realpath of that directory when it resolves, else the configured spelling.
   */
  async function directoryOf(snapshot) {
    const cwd = snapshot.header.cwd;
    if (!underSessionsRoot(cwd, await knownSessionsRoots())) return sessionDirPath(sessionsRoot, snapshot.header.id);
    return resolveDirectory(cwd);
  }

  /**
   * Directory name of one session, for callers that only carry an id (routes, reports).
   * @param sessionId the session to resolve.
   * @returns the directory basename the link layer keys on.
   */
  async function linkDirectory(sessionId) {
    const durable = await ctx.sessionPersistence.list();
    const snapshot = durable.find((entry) => entry.header.id === sessionId);
    return snapshot === undefined ? sessionId : basename(await directoryOf(snapshot));
  }

  /** Realpath when the path exists, the input otherwise (a missing cwd must still be creatable). */
  async function resolveDirectory(directory) {
    try {
      return await realpath(directory);
    } catch {
      return directory;
    }
  }

  /** Best-effort `realpath` for request paths; a missing path keeps its own spelling. */
  function resolveSafe(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }

  /**
   * Turn a pin request into the sessions it names. `sessionId` wins; `workspaceId` (or `path`)
   * expands to every session the workspace currently holds, which is what the inline menu does
   * when it pins the row you hovered.
   */
  async function resolveTargets(body) {
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (sessionId !== '') return [sessionId];
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : '';
    const rawPath = typeof body?.path === 'string' ? body.path.trim() : '';
    const workspaces = ctx.workspaceRegistry.list();
    const workspace = workspaceId !== ''
      ? workspaces.find((entry) => entry.id === workspaceId)
      : rawPath !== ''
        ? workspaces.find((entry) => entry.path === rawPath) ?? workspaces.find((entry) => entry.path === resolveSafe(rawPath))
        : undefined;
    if (workspace === undefined) {
      const directory = rawPath !== '' ? resolveSafe(rawPath) : '';
      if (directory === '') return [];
      const owners = workspaces.filter((entry) => directory.startsWith(`${entry.path}/`));
      const deepest = owners.sort((a, b) => b.path.length - a.path.length)[0];
      return deepest === undefined ? [] : [...deepest.sessionIds];
    }
    return [...workspace.sessionIds];
  }

  /** Orphan = a session the server knows about that no workspace (receipt or real) claims. */
  async function orphanCount() {
    const rows = await status();
    return rows.orphans;
  }

  /** The receipt workspace sitting on one directory, when there is one. */
  function workspaceOf(directory) {
    for (const entity of ctx.workspaceRegistry.list()) {
      if (entity.path === directory) return entity;
    }
    return undefined;
  }

  /**
   * Does another visible session still live in this directory?
   *
   * Shared cwds are real (two sessions, one directory), so archiving one of them must not delete
   * the workspace the other one is still rendering its row from.
   * @param cwd directory to test.
   * @param sessionId the session being archived.
   * @param durable every persisted session.
   * @param archived ids archived as of this sweep.
   */
  function sharedWithVisibleSession(cwd, sessionId, durable, archived) {
    return durable.some((other) => other.header.id !== sessionId
      && other.header.cwd === cwd
      && !archived.has(other.header.id));
  }

  /**
   * Last log facts read per session, keyed by the persisted size that produced them.
   * `{ size, title, userMessages, lastTime }` — one read feeds both the link layer (title)
   * and the reclaim layer (did a user ever speak here, and when).
   */
  const logs = new Map();
  /** Last workspace-layer failure per session, surfaced by `/chat-sessions/status` (report D1). */
  const workspaceErrors = new Map();
  /** Serialize sweeps: the poller, the route and boot must not race on the same link. */
  let sweepQueue = Promise.resolve();

  /** `running` per session, from the Session summary (the snapshot does not carry it). */
  async function runningSessions() {
    const summaries = new Map();
    try {
      const listed = await ctx.sessionController.list({}, new AbortController().signal);
      for (const summary of listed?.items ?? []) summaries.set(summary.sessionId, summary);
    } catch (error) {
      ctx.logger?.warn?.(`[chat-sessions] session list unavailable: ${messageOf(error)}`);
    }
    return summaries;
  }

  /**
   * Read one session's log, reusing the cache while the persisted size is unchanged.
   * @returns `{ title, userMessages, assistantMessages, lastTime }` or null when the log cannot be read.
   */
  async function logFacts(sessionId, sizeBytes) {
    const cached = logs.get(sessionId);
    if (cached !== undefined && cached.size === sizeBytes) return cached;
    try {
      const read = await readSessionLog(ctx.sessionPersistence, sessionId);
      const entry = { size: sizeBytes, ...read };
      logs.set(sessionId, entry);
      return entry;
    } catch (error) {
      logs.set(sessionId, { size: sizeBytes, title: null, userMessages: undefined, assistantMessages: undefined, error: messageOf(error) });
      return null;
    }
  }

  /**
   * Pull every managed session back out of the archive.
   *
   * Maintenance door for the archive set, which is durable and otherwise only reversible one
   * session at a time from the sidebar menu. Only sessions whose cwd lives under this plugin's
   * `<root>/.sessions` are touched.
   * @returns the ids that were archived and are now visible again.
   */
  async function unarchiveAll() {
    const run = async () => {
      const archived = new Set(ctx.workspaceRegistry.archivedSessionIds);
      const restored = [];
      for (const snapshot of await ctx.sessionPersistence.list()) {
        const sessionId = snapshot.header.id;
        if (!archived.has(sessionId)) continue;
        if (!underSessionsRoot(snapshot.header.cwd, await knownSessionsRoots())) continue;
        try {
          await ensureSessionWorkspace(sessionId, snapshot.header.cwd);
          const directory = await directoryOf(snapshot);
          await mkdir(directory, { recursive: true });
          const target = linkTarget(basename(directory));
          const link = await restoreRoomLink({ root, target });
          if (link.to === null) {
            const facts = await logFacts(sessionId, snapshot.sizeBytes);
            await ensureRoomLink({ root, target, slug: facts?.title ?? '', owner: basename(directory) === sessionId });
          }
          await ctx.workspaceRegistry.unarchiveSession(sessionId);
          restored.push(sessionId);
        } catch (error) {
          ctx.logger?.warn?.(`[chat-sessions] unarchive failed for ${sessionId}: ${messageOf(error)}`);
        }
      }
      return { restored };
    };
    const result = sweepQueue.then(run, run);
    sweepQueue = result;
    return result;
  }

  /**
   * Registry-only pass: a receipt workspace (one per standalone room) must always carry the
   * neutral title.
   *
   * `sweep()` below only visits directories that still hold a session, so a receipt left behind by
   * an archived session kept whatever title an older build gave it (`session-<uuid>` or the
   * pre-rename `独立会话`) for good — invisible in the UI, yet visible in `GET /chat-sessions/status`.
   * Rename every receipt that drifted; drop only those whose directory is gone and that no session
   * references any more.
   */
  async function normalizeReceiptTitles(managedWorkspaceIds) {
    const reports = [];
    const title = untitledWorkspaceTitle(config);
    const roots = await knownSessionsRoots();
    for (const workspace of ctx.workspaceRegistry.list()) {
      if (!underSessionsRoot(workspace.path, roots)) continue;
      // 只有账本里明确归本插件管的房间才允许改标题/删登记。路径形状不是所有权证据：
      // 用户自己放在 root/.sessions 下的普通工作区必须原样保留（验收 F07 / R08 / R14）。
      if (managedWorkspaceIds !== null && !managedWorkspaceIds.has(workspace.id)) {
        reports.push({ status: 'workspace-retained-unmanaged', workspaceId: workspace.id });
        continue;
      }
      if (workspace.title !== title) {
        try {
          await workspace.setTitle(title);
          reports.push({ status: 'workspace-renamed', workspaceId: workspace.id });
        } catch (error) {
          ctx.logger?.warn?.(`[chat-sessions] receipt rename failed for ${workspace.id}: ${messageOf(error)}`);
        }
      }
      if (workspace.sessionIds.length > 0) continue;
      // Nobody references it. A directory that still exists may be picked by a later session, so
      // only a receipt whose cwd the boot reclaim already removed is dropped.
      try {
        await stat(workspace.path);
        continue;
      } catch {
        // Directory is gone: fall through to the cleanup.
      }
      try {
        await ctx.workspaceRegistry.delete(workspace.id);
        reports.push({ status: 'workspace-dropped', workspaceId: workspace.id });
      } catch (error) {
        ctx.logger?.warn?.(`[chat-sessions] receipt cleanup failed for ${workspace.id}: ${messageOf(error)}`);
      }
    }
    return reports;
  }

  /** Sync links and membership without changing archive flags; boot also reclaims archived empty cwds. */
  function sweep(only, options = {}) {
    const run = async () => {
      // 交接边界：sweep 是已接收的插件任务，必须能被 dispose 排空；一旦冻结或 generation 变了，
      // 后续任何副作用（补目录、软链接、改标题、删登记）都不许再发生（复审 R2-F05）。
      const gate = coordinator === undefined ? null : coordinator.generation;
      const stale = () => coordinator !== undefined
        && (coordinator.canWrite() === false || coordinator.generation !== gate);
      const durable = await ctx.sessionPersistence.list();
      const archived = new Set(ctx.workspaceRegistry.archivedSessionIds);
      const reports = [];
      // 生命周期闸门：账本说了算。未托管会话的所有副作用（补目录、软链接、改标题、删登记）
      // 一律跳过，避免维护逻辑绕过资格判断去动用户的工作区（验收 F07）。
      const managedSessions = await managedSessionIdSet();
      const managedWorkspaces = await managedWorkspaceIdSet();
      for (const snapshot of durable) {
        const sessionId = snapshot.header.id;
        if (!underSessionsRoot(snapshot.header.cwd, await knownSessionsRoots())) continue;
        if (only !== undefined && !only.has(sessionId)) continue;
        if (managedSessions !== null && !managedSessions.has(sessionId)) {
          reports.push({ status: 'retained-unmanaged', sessionId });
          continue;
        }
        const facts = await logFacts(sessionId, snapshot.sizeBytes);
        if (facts === null) continue;
        if (stale()) {
          reports.push({ status: 'skipped-lifecycle', sessionId });
          continue;
        }

        // Message-free logs do not imply abandonment: selection and unsent drafts live
        // in the browser. Respect the native archive flag, including during plugin activation.
        const nowArchived = archived.has(sessionId);

        // Native archive filtering requires workspace membership; archival changes visibility,
        // not ownership. Older builds deleted receipts, so reconcile them without unarchiving.
        const directory = await directoryOf(snapshot);
        const linkName = basename(directory);
        if (nowArchived) {
          try {
            await ensureSessionWorkspace(sessionId, snapshot.header.cwd, true);
            workspaceErrors.delete(sessionId);
          } catch (error) {
            workspaceErrors.set(sessionId, messageOf(error));
            reports.push({ status: 'workspace-error', sessionId, error: messageOf(error) });
          }
          try {
            // PRD A7: the title link moves into `<root>/.archive/` instead of being dropped, so an
            // unarchive can bring back the exact name and the archive doubles as the visible list of
            // sessions whose directories still occupy disk (R-5).
            // One room keeps one name: while a sibling in the same directory is still visible, the
            // shared link stays where it is — archiving this session must not take the name away.
            const sharedRoom = sharedWithVisibleSession(snapshot.header.cwd, sessionId, durable, archived);
            const roomTarget = linkTarget(linkName);
            let directoryExists;
            try { directoryExists = (await stat(directory)).isDirectory(); }
            catch (error) { if (error?.code !== 'ENOENT') throw error; directoryExists = false; }
            const moved = sharedRoom
              ? { status: 'skipped', reason: 'owned-by-sibling', from: null, to: null }
              : directoryExists
                ? await archiveRoomLink({ root, target: roomTarget, slug: slugify(facts.title ?? '') })
                : (await dropRoomLink({ root, target: roomTarget, keepName: true }),
                  { status: 'skipped', reason: 'reclaimed-directory', from: null, to: null });
            if (moved.status === 'archived') {
              reports.push({ status: 'link-archived', sessionId, name: moved.to });
            } else if (moved.status === 'skipped' && moved.reason === 'owned-by-sibling') {
              // The room still holds a name because a sibling in the same directory is visible.
              // This session never owned that name, so say so instead of implying success.
              reports.push({ status: 'skipped', reason: 'owned-by-sibling', sessionId });
            }
            // Keep the receipt and its sessionIds, including when every sibling is archived.
          } catch (error) {
            console.warn(`[chat-sessions] unlink failed for ${sessionId}: ${messageOf(error)}`);
          }
        } else {
          // Two independent layers, two independent try/catch blocks. A workspace failure used to
          // abort this whole branch, so a session whose cwd the host had inherited never got a link
          // either (report D1). The link layer must run whatever the registry thinks.
          try {
            await ensureSessionWorkspace(sessionId, snapshot.header.cwd);
            workspaceErrors.delete(sessionId);
            // The receipt workspace is what the composer's workspace chip shows. It keeps the neutral
            // `untitledWorkspaceTitle` for its whole life: a session title lives in the session row,
            // and copying it here would leak one session's name onto every later session that shares
            // the directory (pressing 新会话 inside a standalone chat does exactly that). Stale
            // workspaces created by an earlier build carry the raw `session-<uuid>` title, so they are
            // renamed back here.
            const receipt = workspaceOf(directory);
            if (receipt !== undefined && receipt.title !== untitledWorkspaceTitle(config)) {
              await receipt.setTitle(untitledWorkspaceTitle(config));
              reports.push({ status: 'workspace-renamed', sessionId, workspaceId: receipt.id });
            }
          } catch (error) {
            workspaceErrors.set(sessionId, messageOf(error));
            ctx.logger?.warn?.(`[chat-sessions] workspace step failed for ${sessionId}: ${messageOf(error)}`);
            reports.push({ status: 'workspace-error', sessionId, error: messageOf(error) });
          }
          try {
            // A session coming back from the archive keeps the name it was archived under, even
            // when it has no title of its own — the archived link is the authority here, so this
            // step must not sit behind the title check. A session that was never archived goes
            // through the title-follows-name path (S6) instead.
            const roomTarget = linkTarget(linkName);
            const back = await restoreRoomLink({ root, target: roomTarget });
            if (back.to !== null) {
              reports.push({ status: back.status, name: back.to, sessionId });
            } else if (facts.title !== null) {
              // One room, one name: only the session that owns the directory (its id is the
              // directory name) may rename it; a sibling that inherited the cwd just adopts.
              const applied = await ensureRoomLink({
                root,
                target: roomTarget,
                slug: slugify(facts.title),
                owner: linkName === sessionId,
              });
              reports.push({ ...applied, sessionId });
            }
          } catch (error) {
            console.warn(`[chat-sessions] link failed for ${sessionId}: ${messageOf(error)}`);
            reports.push({ status: 'error', sessionId, error: messageOf(error) });
          }
        }

        if (options.boot !== true) continue;
        if (!isSessionDirName(linkName)) continue;
        // A session the user can still open must keep a real cwd: it is the session's working
        // directory, and a previous reclaim (or a manual `rm -rf`) can leave it missing.
        if (!nowArchived) {
          try {
            await mkdir(directory, { recursive: true });
          } catch (error) {
            ctx.logger?.warn?.(`[chat-sessions] cwd restore failed for ${sessionId}: ${messageOf(error)}`);
          }
          continue;
        }
        // 目录保留：生命周期交接要求「旧目录（含已归档的空目录）一律保留」，
        // 所以这里不再回收任何 `session-<uuid>` 目录，也不拆它的标题软链接。
        // 归档只是把入口挪进 `.archive/`，磁盘上的房间还在，重新启用后仍能原样挂回去。
        reports.push({ status: 'retained', sessionId });
      }
      // Registry-level tidying runs whatever happened above: a stale receipt has no session
      // pointing at it, so the per-session loop above never sees it.
      try {
        reports.push(...(await normalizeReceiptTitles(managedWorkspaces)));
      } catch (error) {
        ctx.logger?.warn?.(`[chat-sessions] receipt sweep failed: ${messageOf(error)}`);
      }
      return reports;
    };
    sweepQueue = sweepQueue.then(run, run);
    return sweepQueue;
  }

  // Title generation happens inside a turn, with no host-side event to subscribe to, so both
  // layers poll the persisted sizes: a size change is the only cheap signal that a new
  // `session/title` or `user/message` may have landed. One stat per session every 15s,
  // unref'd so it never keeps the process alive. Boot runs the same sweep plus disk reclamation.
  ctx.effect(() => {
    const sweepNow = (options) => {
      // 启动与定时 sweep 都是「插件已接收的任务」：登记进 coordinator，dispose 时才排得空。
      const work = sweep(undefined, options);
      const tracked = coordinator === undefined ? work : coordinator.track(work);
      tracked.catch((error) => {
        ctx.logger?.warn?.(`[chat-sessions] sweep failed: ${messageOf(error)}`);
      });
    };
    sweepNow({ boot: true });
    const timer = setInterval(() => sweepNow(), 15_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'chat-sessions: title link + reclaim sweep');

  /**
   * Report the root, every durable standalone session, and workspace membership.
   *
   * `options.orphanLimit` / `options.orphanSession` shape the `orphanSessions` window only; they
   * never change `orphans`, `durableSessions`, `sessions` or `workspaces`.
   */
  async function status(options = {}) {
    const durable = await ctx.sessionPersistence.list();
    // `blank`/`running` live in the Session summary, not in the persisted snapshot.
    const summaries = await runningSessions();
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds);
    const roots = await knownSessionsRoots();
    const entries = durable.filter((snapshot) => underSessionsRoot(snapshot.header.cwd, roots));
    const durableIds = new Set(durable.map((snapshot) => snapshot.header.id));
    const sessions = [];
    for (const snapshot of entries) {
      const sessionId = snapshot.header.id;
      const directory = await directoryOf(snapshot);
      const linkName = basename(directory);
      const roomTarget = linkTarget(linkName);
      const isArchived = archived.has(sessionId);
      // The room is owned by the session whose id is the directory name. `link` is reported for the
      // whole room (every sibling shows the same name) but only while a link for it exists at the
      // top level; an archived session has none, which is what report R9 asked for.
      const ownsLink = linkName === sessionId;
      sessions.push({
        sessionId,
        cwd: snapshot.header.cwd,
        // `directory` is what the link layer keys on, and `cwdInherited` flags the host behaviour
        // behind report D1: a new session created from inside a standalone chat keeps the parent's
        // cwd, so two sessions share one directory.
        directory,
        cwdInherited: linkName !== sessionId,
        sizeBytes: snapshot.sizeBytes,
        blank: summaries.get(sessionId)?.blank,
        running: summaries.get(sessionId)?.running,
        archived: archived.has(sessionId),
        title: logs.get(sessionId)?.title ?? null,
        userMessages: logs.get(sessionId)?.userMessages,
        readError: logs.get(sessionId)?.error,
        workspaceError: workspaceErrors.get(sessionId),
        link: isArchived ? null : await findRoomLink(root, roomTarget),
        archivedLink: await findArchivedRoomLink(root, roomTarget),
        // Diagnostics for "who owns this name": the room owner exists only while its session does.
        linkOwner: durableIds.has(linkName) ? linkName : null,
        ownsLink,
        workspaceId: workspaceOf(directory)?.id ?? null,
      });
    }
    // Pin state and recency are registry/session facts the sidebar cannot see through a workspace
    // row, yet the standalone cluster is ordered on them. Ordering is by *pin recency* first: the
    // registry keeps `pinnedSessionIds` in pin order (newest first), which is exactly the shipped
    // sidebar's rule ("the last one you pinned goes on top"). Ranking by activity instead made two
    // rooms pinned seconds apart look arbitrary whenever their last messages were close together,
    // so `pinIndex` is reported as the primary key and `updatedAt` only breaks ties.
    const pinOrder = new Map();
    for (const [index, sessionId] of ctx.workspaceRegistry.pinnedSessionIds.entries()) {
      if (!pinOrder.has(sessionId)) pinOrder.set(sessionId, index);
    }
    const recency = (sessionId) =>
      summaries.get(sessionId)?.updatedAt ?? logs.get(sessionId)?.lastTime ?? 0;
    const workspaces = ctx.workspaceRegistry.list().map((workspace) => {
      const sessionIds = [...workspace.sessionIds];
      const indexes = sessionIds
        .map((sessionId) => pinOrder.get(sessionId))
        .filter((index) => index !== undefined);
      // Which real workspace this room is nested under, if any. The shipped tree nests by path
      // ancestry, so a receipt whose directory lives inside `~/.dsh` renders as a child of `.dsh`.
      // Reported here so acceptance can prove nesting without reading the DOM.
      const nestedUnder = ctx.workspaceRegistry
        .list()
        .filter((other) => other.id !== workspace.id)
        .map((other) => other.path)
        .filter((path) => path !== '' && workspace.path.startsWith(`${path}/`))
        .sort((left, right) => right.length - left.length)[0] ?? null;
      return {
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        nestedUnder,
        sessionIds,
        pinned: indexes.length > 0,
        // Position of this room's most recently pinned session in the global pin order (lower = newer).
        pinIndex: indexes.length > 0 ? Math.min(...indexes) : null,
        updatedAt: sessionIds.reduce((latest, sessionId) => Math.max(latest, recency(sessionId)), 0),
      };
    });
    // Sessions no workspace claims: exactly what the native 「未分组」 bucket renders. The client
    // cannot count them itself, because a collapsed bucket renders no session rows and reading
    // "0 rows" as "empty" would hide the header that is the only way back.
    //
    // This must be counted over *every* durable session, not over `sessions` above: that list is
    // filtered to cwds under `.sessions/`, which excludes the other way a session becomes an orphan
    // — deleting a real workspace that still holds sessions (report R22). Those sessions keep living
    // in their old directory, so counting only `.sessions/` made `orphans` look frozen at the old
    // value and left the orphan row unreadable. `orphanSessions` reports the rows themselves,
    // capped so a pathological home does not turn one GET into a megabyte.
    const orphanSessions = [];
    let orphanTotal = 0;
    // Membership is what the native bucket uses: a session belongs to the workspace that lists it
    // in `sessionIds`, not to whichever directory happens to sit under a workspace path. Deleting a
    // workspace drops exactly those ids, so they are the set that turns into orphans (report R22).
    const claimed = new Set();
    for (const workspace of ctx.workspaceRegistry.list()) {
      for (const sessionId of workspace.sessionIds) claimed.add(sessionId);
    }
    // The window is chosen *before* the file-system lookups. Rounds 5-2/5-3 both failed to read a
    // freshly orphaned row because the cap filled up with older orphans from a busy home, so the
    // order is newest-first (by the header's `createdAt`) and a caller can ask for one session by
    // id, a different window size, or the whole set. Doing the links first would cost one stat pair
    // per orphan just to throw most of them away.
    const orphanCandidates = [];
    for (const snapshot of durable) {
      const sessionId = snapshot.header.id;
      if (claimed.has(sessionId)) continue;
      orphanCandidates.push(snapshot);
    }
    orphanCandidates.sort((left, right) => (right.header.createdAt ?? 0) - (left.header.createdAt ?? 0));
    const requestedId = options.orphanSession ?? null;
    const requestedLimit = options.orphanLimit ?? ORPHAN_REPORT_LIMIT;
    const limit = requestedLimit === Infinity ? orphanCandidates.length : requestedLimit;
    for (const snapshot of orphanCandidates) {
      const sessionId = snapshot.header.id;
      orphanTotal += 1;
      if (orphanSessions.length >= limit) continue;
      if (requestedId !== null && sessionId !== requestedId) continue;
      const directory = await directoryOf(snapshot);
      const name = basename(directory);
      const target = linkTarget(name);
      const isArchived = archived.has(sessionId);
      orphanSessions.push({
        sessionId,
        cwd: snapshot.header.cwd,
        directory,
        createdAt: snapshot.header.createdAt ?? null,
        archived: isArchived,
        blank: summaries.get(sessionId)?.blank,
        running: summaries.get(sessionId)?.running,
        title: logs.get(sessionId)?.title ?? null,
        sizeBytes: snapshot.sizeBytes,
        link: isArchived ? null : await findRoomLink(root, target),
        archivedLink: await findArchivedRoomLink(root, target),
        workspaceId: null,
      });
    }
    // 账本摘要只读一次，供前端判断「哪些房间归插件管」。账本不可用时给空集合，
    // 让客户端退回纯原生视图，而不是拿路径猜测去压平用户工作区。
    await lifecycleReady;
    const lifecycle = coordinator === undefined ? null : await coordinator.describe();
    return {
      ok: true,
      root,
      sessionsRoot,
      // Pin order per *session*, not per room. A room can hold several chats (a fork keeps the
      // parent's directory), and the sidebar lists those chats as separate rows inside one group
      // wrapper. Ranking the room therefore ranks all of its chats, so an unpinned sibling of a
      // freshly pinned chat landed *above* an older pin from another room — report
      // "较新的会话会把旧的顶掉". The client orders rows from this list instead.
      pinOrder: [...pinOrder.entries()]
        .sort((left, right) => left[1] - right[1])
        .map(([sessionId, index]) => ({ sessionId, index })),
      orphans: orphanTotal,
      orphanSessions,
      orphanSessionsTruncated: orphanTotal > orphanSessions.length,
      orphanSessionsLimit: requestedLimit === Infinity ? 'all' : requestedLimit,
      orphanSessionsFilter: requestedId,
      durableSessions: durable.length,
      sessions,
      workspaces,
      // 明确托管集合：前端只按这份清单压平/分簇，不再靠路径形状猜哪些房间是插件的。
      // `workspaces` 保持全量，排序仍依赖原生 pinned/pinIndex/updatedAt。
      ...(lifecycle === null
        ? { lifecycle: { state: 'unavailable' }, managedWorkspaceIds: [], managedSessionIds: [] }
        : {
          lifecycle,
          managedWorkspaceIds: lifecycle.managed.workspaceIds,
          managedSessionIds: lifecycle.managed.sessionIds,
        }),
    };
  }

  // Last client-side samples (see `reportDiagnostics` in client.js). Volatile on purpose: the
  // desktop window has no debugging port, so this is the only channel that can carry a page
  // measurement out of it.
  const diagnostics = [];
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        answer(res, 403, { ok: false, error: 'loopback only' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://dsh.invalid');
      try {
        if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/create`) {
          const body = await readJsonBody(req);
          // 交接/恢复期间一律拒绝新写（409 + 稳定码），不排队、不猜结果。
          if (!(await lifecycleWritable())) {
            answer(res, 409, { ok: false, error: 'LIFECYCLE_NOT_READY', code: 'LIFECYCLE_NOT_READY' });
            return;
          }
          const work = body.reuseBlank === true
            ? reuseOrCreateBlank()
            : createStandaloneSession();
          const created = await (coordinator === undefined ? work : coordinator.track(work));
          answer(res, 200, { ok: true, ...created });
          return;
        }
        if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/link`) {
          const body = await readJsonBody(req);
          const requested = typeof body.sessionId === 'string' && body.sessionId !== ''
            ? new Set([body.sessionId])
            : undefined;
          const linkWork = sweep(requested);
          const links = await (coordinator === undefined ? linkWork : coordinator.track(linkWork));
          // A single-session request must answer "what happened to this session" even when the
          // sweep found nothing to change, so callers never have to infer `ok` from an empty list.
          if (requested !== undefined) {
            for (const sessionId of requested) {
              if (links.some((entry) => entry.sessionId === sessionId)) continue;
              const roomTarget = linkTarget(await linkDirectory(sessionId));
              const ownTop = await findRoomLink(root, roomTarget);
              const ownArchived = await findArchivedRoomLink(root, roomTarget);
              // Three honest answers: the room name is this session's to report (`ok`); the name is
              // parked in `.archive/` because this session was archived (`archived`); or a visible
              // sibling still holds it, so this session can never own it (report R9).
              const skipped = ownArchived !== null
                ? { status: 'skipped', reason: 'archived' }
                : ownTop === null
                  ? { status: 'skipped', reason: 'no-link' }
                  : ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
                    ? { status: 'skipped', reason: 'owned-by-sibling' }
                    : null;
              links.push(skipped === null
                ? { status: 'ok', sessionId, link: ownTop, workspaceError: workspaceErrors.get(sessionId) }
                : { ...skipped, sessionId, link: skipped.reason === 'archived' ? null : ownTop });
            }
          }
          answer(res, 200, { ok: true, root, links });
          return;
        }
        if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/links/tidy`) {
          // Dry run unless the caller says `{"apply": true}` — this unlinks user-visible names.
          const body = await readJsonBody(req);
          answer(res, 200, { ok: true, ...await tidyLinks({ root, apply: body?.apply === true }) });
          return;
        }
        if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/workspaces`) {
          // The sidebar's "add workspace" runs a native directory picker that automation cannot
          // drive, which left R22 (delete a workspace -> its sessions become orphans) untestable.
          // This mirrors the same validation and the same registry call the picker ends in.
          const body = await readJsonBody(req);
          const requested = typeof body?.path === 'string' ? body.path.trim() : '';
          if (requested === '') {
            answer(res, 400, { ok: false, error: 'path is required' });
            return;
          }
          let resolved;
          try {
            resolved = await realpath(requested);
          } catch {
            answer(res, 400, { ok: false, error: `path does not exist: ${requested}` });
            return;
          }
          const info = await stat(resolved).catch(() => null);
          if (info === null || !info.isDirectory()) {
            answer(res, 400, { ok: false, error: `path is not a directory: ${resolved}` });
            return;
          }
          const existing = ctx.workspaceRegistry.list().find((workspace) => workspace.path === resolved);
          if (existing !== undefined) {
            answer(res, 200, { ok: true, created: false, workspaceId: existing.id, path: resolved, title: existing.title });
            return;
          }
          const title = typeof body?.title === 'string' && body.title.trim() !== ''
            ? body.title.trim()
            : (resolved.split('/').pop() ?? resolved);
          const workspace = await ctx.workspaceRegistry.create(resolved, title);
          answer(res, 200, { ok: true, created: true, workspaceId: workspace.id, path: resolved, title });
          return;
        }
        if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/pin`) {
          // Pin state lives in the registry's global `pinnedSessionIds` array; the sidebar's inline
          // menu reaches it through a hover-only button automation cannot click reliably. This takes
          // the same path: pinSession/unpinSession, so pinIndex/updatedAt stay the single ordering key.
          const body = await readJsonBody(req);
          const wanted = typeof body?.pinned === 'boolean' ? body.pinned : undefined;
          if (wanted === undefined) {
            answer(res, 400, { ok: false, error: 'pinned must be a boolean' });
            return;
          }
          const sessionIds = await resolveTargets(body);
          if (sessionIds.length === 0) {
            answer(res, 400, { ok: false, error: 'sessionId or workspaceId is required' });
            return;
          }
          const results = [];
          for (const sessionId of sessionIds) {
            try {
              if (wanted) await ctx.workspaceRegistry.pinSession(sessionId);
              else await ctx.workspaceRegistry.unpinSession(sessionId);
              results.push({ sessionId, status: 'ok', pinned: wanted });
            } catch (error) {
              // `already pinned`/`not pinned` resolve without writing; the only real refusals are
              // "archived session" and "unknown session", and both must be reported, not swallowed.
              const text = messageOf(error);
              const reason = text.includes('is archived')
                ? 'archived'
                : text.includes('unknown') || text.includes('no session')
                  ? 'unknown-session'
                  : 'error';
              results.push({ sessionId, status: 'skipped', reason, error: text });
            }
          }
          const pinOrder = new Map();
          for (const [index, sessionId] of ctx.workspaceRegistry.pinnedSessionIds.entries()) {
            if (!pinOrder.has(sessionId)) pinOrder.set(sessionId, index);
          }
          const applied = results.filter((entry) => entry.status === 'ok').length;
          answer(res, 200, {
            // `ok` follows the *effect*, not the absence of skips: a room that also holds an
            // archived sibling still pins (the live session goes through), and reporting ok:false
            // there read as "pinning failed" to every acceptance run. `skipped` still lists what
            // was refused, and `applied` says how many targets actually moved.
            ok: applied > 0,
            applied,
            pinned: wanted,
            results,
            pinOrder: [...pinOrder.entries()].map(([sessionId, index]) => ({ sessionId, index })),
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/workspaces/delete`) {
          // Mirrors `POST /workspaces`: the sidebar's row menu is hover-only and its delete action is
          // a typed remote call with no REST surface, so R22 could not be scripted end to end.
          // Same registry call as the menu (`registry.delete`), and it keeps the directory and logs.
          const body = await readJsonBody(req);
          const byId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : '';
          const byPath = typeof body?.path === 'string' ? body.path.trim() : '';
          if (byId === '' && byPath === '') {
            answer(res, 400, { ok: false, error: 'path or workspaceId is required' });
            return;
          }
          const workspaces = ctx.workspaceRegistry.list();
          const target = byId !== ''
            ? workspaces.find((workspace) => workspace.id === byId)
            : workspaces.find((workspace) => workspace.path === byPath)
              ?? workspaces.find((workspace) => workspace.path === resolveSafe(byPath));
          if (target === undefined) {
            answer(res, 404, { ok: false, error: `no workspace for ${byId !== '' ? byId : byPath}` });
            return;
          }
          const removed = await ctx.workspaceRegistry.delete(target.id);
          answer(res, 200, {
            ok: true,
            deleted: removed === true,
            workspaceId: target.id,
            path: target.path,
            title: target.title,
            orphans: await orphanCount(),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/status`) {
          // `?orphans=all` / `?orphanLimit=N` / `?orphanSession=<id>` only shape the reported window
          // (see `status()`); the totals stay whole so a narrow read cannot be mistaken for a count.
          const rawLimit = url.searchParams.get('orphanLimit');
          const rawAll = url.searchParams.get('orphans');
          const orphanSession = url.searchParams.get('orphanSession');
          let orphanLimit;
          if (rawAll === 'all') {
            orphanLimit = Infinity;
          } else if (rawLimit !== null) {
            const parsed = Number(rawLimit);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
              answer(res, 400, { ok: false, error: 'orphanLimit must be an integer between 1 and 5000' });
              return;
            }
            orphanLimit = parsed;
          }
          answer(res, 200, await status({ orphanLimit, orphanSession }));
          return;
        }
        if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/unarchive`) {
          await readJsonBody(req);
          const result = coordinator === undefined
            ? await unarchiveAll()
            : await coordinator.track(Promise.resolve().then(() => unarchiveAll()));
          answer(res, 200, { ok: true, ...result });
          return;
        }
        if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/diagnostics`) {
          answer(res, 200, { ok: true, samples: diagnostics });
          return;
        }
        if (req.method === 'POST' && url.pathname === `${ROUTE_PREFIX}/diagnostics`) {
          // The desktop window has no debugging port, so the client half reports its own
          // measurements here; the last few samples are what a bug report needs.
          const body = await readJsonBody(req);
          diagnostics.push({ ...body, receivedAt: new Date().toISOString() });
          while (diagnostics.length > 20) diagnostics.shift();
          answer(res, 200, { ok: true, kept: diagnostics.length });
          return;
        }
        if (req.method === 'GET' && url.pathname === `${ROUTE_PREFIX}/config`) {
          answer(res, 200, {
            ok: true,
            build: PLUGIN_BUILD,
            root,
            flattenUngrouped: flattenUngrouped(config),
            glide: config?.glide !== false,
            glideMotion: glideMotion(config),
      treeBadge: treeBadgeOf(config),
            untitledWorkspaceTitle: untitledWorkspaceTitle(config),
          });
          return;
        }
        answer(res, 404, { ok: false, error: `no route for ${req.method} ${url.pathname}` });
      } catch (error) {
        ctx.logger?.warn?.(`[chat-sessions] ${req.method} ${url.pathname} failed: ${messageOf(error)}`);
        // 生命周期未就绪是预期状态（启动恢复/正在交接/账本坏掉），不是 500；
        // 账本写不进去则是 503：请求确实没有被持久化，不能靠重试掩盖（验收 F04）。
        const notReady = error?.code === 'LIFECYCLE_NOT_READY';
        const ledgerDown = error?.code === 'LIFECYCLE_LEDGER_UNAVAILABLE';
        answer(res, notReady ? 409 : ledgerDown ? 503 : 500, {
          ok: false,
          error: messageOf(error),
          ...(notReady ? { code: 'LIFECYCLE_NOT_READY' } : {}),
          ...(ledgerDown ? { code: 'LIFECYCLE_LEDGER_UNAVAILABLE', sessionId: error.sessionId ?? null, workspaceId: error.workspaceId ?? null } : {}),
        });
      }
    },
  }));
}
