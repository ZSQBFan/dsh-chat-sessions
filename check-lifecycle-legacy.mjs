/**
 * L3 测试：旧数据审计与迁移候选（legacy.js）。
 *
 * 全部测试使用真实临时目录（mkdtemp）：真实目录、真实 `workspace.json`、真实会话日志
 * （zstd/明文由运行时能力决定）、真实软链接，不用 mock 封装层。每项都对应
 * docs/lifecycle/01-DESIGN.md §8.2 或 04-IMPLEMENTATION-CONTRACT.md 的一条可观察行为，
 * 实现被改坏时必须变红（汇报里附注入缺陷清单）。
 *
 * 运行：node --test check-lifecycle-legacy.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import * as zlib from 'node:zlib';

import {
  LEGACY_CLASSIFICATION,
  LEGACY_REASON,
  auditLegacyRooms,
  legacyRoomDraft,
} from './lifecycle/legacy.js';
import { scopeIdentity } from './lifecycle/model.js';
import { LedgerStore } from './lifecycle/store.js';

const NOW = Date.UTC(2026, 10, 7, 0, 0, 0);
const OWNER = 'session-11111111-1111-4111-8111-111111111111';
const OTHER = 'session-22222222-2222-4222-8222-222222222222';

/** 每个测试一个隔离的 DSH 数据根；`root` 是 `<dshHome>/chats`。 */
async function makeFixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-legacy-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  });
  const dshHome = join(base, 'home');
  const root = join(dshHome, 'chats');
  const sessions = join(root, '.sessions');
  await mkdir(sessions, { recursive: true });
  await mkdir(join(dshHome, 'sessions'), { recursive: true });
  await mkdir(join(dshHome, 'storages'), { recursive: true });
  return { base, dshHome, root, sessions };
}

/** 真实 `workspace.json`（与宿主 unit 形状一致）。 */
async function writeRegistry(fixture, workspaces, { archivedSessionIds = [] } = {}) {
  const ids = Object.keys(workspaces);
  const payload = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ids, archivedSessionIds, pinnedSessionIds: [] },
    tables: { workspaces },
  };
  await writeFile(join(fixture.dshHome, 'storages', 'workspace.json'), `${JSON.stringify(payload, null, 2)}\n`);
}

/** 一条 registry 记录。 */
function registryEntry(path, sessionIds, title = '独立对话') {
  return {
    path,
    title,
    sessionIds,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

/** 宿主持久会话日志头（v4 形状）；有 zstd 时写成真实压缩日志。 */
async function writeSessionLog(fixture, { sessionId, cwd, origin, delegationDepth = 0, parentSession }) {
  const bucket = `--${cwd.replace(/^\//u, '').replaceAll('/', '-')}--`;
  const directory = join(fixture.dshHome, 'sessions', bucket, sessionId);
  await mkdir(directory, { recursive: true });
  const header = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: NOW,
    cwd,
    isSeeded: false,
    delegationDepth,
  };
  if (origin !== undefined) header.origin = origin;
  if (parentSession !== undefined) header.parentSession = parentSession;
  const line = `${JSON.stringify(header)}\n`;
  const compress = typeof zlib.zstdCompressSync === 'function';
  const name = compress ? 'session.v4.jsonl.zstd' : 'session.v4.jsonl';
  await writeFile(join(directory, name), compress ? zlib.zstdCompressSync(Buffer.from(line, 'utf8')) : line);
  return directory;
}

/** 会话日志所在目录（删除模拟“日志丢失”）。 */
async function sessionLogDirectory(fixture, cwd, sessionId) {
  return join(fixture.dshHome, 'sessions', `--${cwd.replace(/^\//u, '').replaceAll('/', '-')}--`, sessionId);
}

/** 递归快照：审计必须一个字节都不改。 */
async function snapshotTree(directory) {
  const rows = [];
  async function walk(current, prefix) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const info = await stat(path).catch(() => null);
      if (entry.isDirectory()) {
        rows.push(`${relative}|dir|${info?.mtimeMs ?? 0}`);
        await walk(path, relative);
      } else if (entry.isSymbolicLink()) {
        rows.push(`${relative}|link|${await readFile(path, 'utf8').catch(() => '')}`);
      } else {
        const bytes = await readFile(path).catch(() => Buffer.alloc(0));
        rows.push(`${relative}|file|${bytes.length}|${info?.mtimeMs ?? 0}|${createHash('sha256').update(bytes).digest('hex')}`);
      }
    }
  }
  await walk(directory, '');
  return rows;
}

/** 一次审计的原始调用。 */
function audit(fixture, overrides = {}) {
  return auditLegacyRooms({ root: fixture.root, dshHome: fixture.dshHome, now: NOW, ...overrides });
}

/**
 * 带只读断言的审计：审计前后整棵夹具快照必须逐字节一致。
 * 不依赖 node:test 的 after 钩子顺序（钩子若先清理目录，比对会静默失效）。
 */
async function auditReadOnly(fixture, overrides = {}) {
  const before = await snapshotTree(fixture.base);
  const result = await audit(fixture, overrides);
  const after = await snapshotTree(fixture.base);
  assert.deepEqual(after, before, '审计必须是只读的：不得新增、删除或改写文件');
  return result;
}

function roomOf(result, ownerSessionId = OWNER) {
  return result.rooms.find((room) => room.ownerSessionId === ownerSessionId);
}

/**
 * 当前 scope 的账本目录，与 `LedgerStore.open()` 同源（realpath(dshHome)、
 * realpath(root)、缺省 plugin/profile）。用于构造「同 scope」的标记。
 */
async function scopeDirectoryOf(fixture, { profileId = 'unknown', pluginId = 'chat-sessions' } = {}) {
  const scopeId = scopeIdentity({
    pluginId,
    profileId,
    dshHome: await realpath(fixture.dshHome),
    canonicalRoot: await realpath(fixture.root),
  });
  return join(fixture.dshHome, 'storages', 'dsh-chat-sessions-lifecycle', scopeId);
}

// ── 1. 三条独立证据齐全 → adoptable ──────────────────────────────────────────

test('1 证据齐全（registry + 真实目录 + 日志头一致）→ adoptable', async (t) => {
  const fixture = await makeFixture(t);
  const directory = join(fixture.sessions, OWNER);
  await mkdir(directory);
  await writeRegistry(fixture, {
    'ws-1': registryEntry(directory, [OWNER]),
  });
  await writeSessionLog(fixture, { sessionId: OWNER, cwd: directory });
  await writeFile(join(fixture.root, '.links.json'), `${JSON.stringify({ version: 2, rooms: {} }, null, 2)}\n`);

  const result = await auditReadOnly(fixture);
  const room = roomOf(result);

  assert.ok(room, 'adoptable 房间必须出现在 rooms 里');
  assert.equal(room.classification, LEGACY_CLASSIFICATION.ADOPTABLE);
  assert.equal(room.adoptable, true);
  assert.equal(room.workspaceId, 'ws-1');
  assert.deepEqual(room.evidence.score, { directory: true, registry: true, session: true });
  assert.equal(room.members.length, 1);
  assert.equal(room.members[0].eligibility, 'eligible');
  assert.equal(result.counts.adoptable, 1);
  assert.equal(result.counts.rejected, 0);
  assert.equal(result.scope.ledgerExists, false);

  const draft = legacyRoomDraft(room, { now: NOW });
  assert.equal(draft.state, 'MANAGED');
  assert.deepEqual(Object.keys(draft.directoryIdentity).sort(), ['dev', 'ino']);
  assert.deepEqual(draft.sessionIds, [OWNER]);
  assert.equal(draft.updatedAt, new Date(NOW).toISOString());
  assert.equal(legacyRoomDraft(roomOf(result) ?? {}, { now: NOW }) === null, false);
});

// ── 2. 目录在、会话日志缺失 → ambiguous ─────────────────────────────────────

test('2 目录存在但会话日志缺失 → ambiguous(SESSION_MISSING)', async (t) => {
  const fixture = await makeFixture(t);
  const directory = join(fixture.sessions, OWNER);
  await mkdir(directory);
  await writeFile(join(directory, '草稿.md'), '# 任务文件\n');
  await writeRegistry(fixture, { 'ws-1': registryEntry(directory, [OWNER]) });

  const result = await auditReadOnly(fixture);
  const room = roomOf(result);

  assert.ok(room);
  assert.equal(room.classification, LEGACY_CLASSIFICATION.AMBIGUOUS);
  assert.equal(room.adoptable, false);
  assert.equal(room.reason, LEGACY_REASON.SESSION_MISSING);
  assert.equal(room.evidence.score.session, false);
  assert.equal(room.preserve, true);
  assert.equal(room.members[0].eligibility, 'missing-session');
  assert.equal(result.counts.adoptable, 0);
  assert.equal(legacyRoomDraft(room, { now: NOW }), null);
});

// ── 3. header.cwd 与目录不符 → ambiguous ────────────────────────────────────

test('3 header.cwd 与目录不符 → ambiguous(CWD_MISMATCH)', async (t) => {
  const fixture = await makeFixture(t);
  const directory = join(fixture.sessions, OWNER);
  const elsewhere = join(fixture.sessions, OTHER);
  await mkdir(directory);
  await mkdir(elsewhere);
  await writeRegistry(fixture, { 'ws-1': registryEntry(directory, [OWNER]) });
  await writeSessionLog(fixture, { sessionId: OWNER, cwd: elsewhere });

  const result = await auditReadOnly(fixture);
  const room = roomOf(result);

  assert.ok(room);
  assert.equal(room.classification, LEGACY_CLASSIFICATION.AMBIGUOUS);
  assert.equal(room.reason, LEGACY_REASON.CWD_MISMATCH);
  assert.equal(room.evidence.session.cwdMatches, false);
  assert.equal(room.members[0].eligibility, 'conflict');
  assert.equal(room.adoptable, false);
});

// ── 4. symlink 越出 root → rejected ────────────────────────────────────────
//
// 选择 rejected 而不是 ambiguous：v0.1.1 只在 `<root>` 与 `.archive` 里建软链接，
// `.sessions/<id>` 永远是真实目录；一个越界软链接意味着该条目不是本插件数据，
// 归为 rejected 可从候选集合里彻底排除（永不 attach），同时 preserve=true 保证不删。

test('4 symlink 指向 root 外 → rejected(SYMLINK_ESCAPES_ROOT)', async (t) => {
  const fixture = await makeFixture(t);
  const outside = join(fixture.base, 'outside', OWNER);
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, '外人文件.md'), 'x\n');
  await symlink(outside, join(fixture.sessions, OWNER));
  await writeSessionLog(fixture, { sessionId: OWNER, cwd: outside });
  await writeRegistry(fixture, { 'ws-1': registryEntry(join(fixture.sessions, OWNER), [OWNER]) });

  const result = await auditReadOnly(fixture);

  assert.equal(result.rooms.length, 0, '越界软链接不得进入房间候选');
  assert.equal(result.counts.adoptable, 0);
  const rejected = result.rejected.find((entry) => entry.path === join(fixture.sessions, OWNER));
  assert.ok(rejected, '必须出现在 rejected 清单');
  assert.equal(rejected.classification, LEGACY_CLASSIFICATION.REJECTED);
  assert.equal(rejected.reason, LEGACY_REASON.SYMLINK_ESCAPES_ROOT);
  assert.equal(rejected.preserve, true);
});

// ── 5. registry 有登记但目录 dev/ino 变化 → ambiguous ──────────────────────

test('5 registry 有登记但目录被替换（dev/ino 变化）→ ambiguous(DIRECTORY_IDENTITY_CHANGED)', async (t) => {
  const fixture = await makeFixture(t);
  const directory = join(fixture.sessions, OWNER);
  await mkdir(directory);
  await writeFile(join(directory, '旧任务.md'), 'x\n');
  await writeRegistry(fixture, { 'ws-1': registryEntry(directory, [OWNER]) });
  await writeSessionLog(fixture, { sessionId: OWNER, cwd: directory });

  const original = await stat(directory);
  const recordedIdentities = { [directory]: { dev: original.dev, ino: original.ino } };

  // 目录被整体替换：同路径、同登记，但 inode 已换。
  await rename(directory, `${directory}.moved`);
  await mkdir(directory);
  await writeFile(join(directory, '新任务.md'), 'y\n');

  const result = await auditReadOnly(fixture, { recordedIdentities });
  const room = roomOf(result);

  assert.ok(room);
  assert.equal(room.classification, LEGACY_CLASSIFICATION.AMBIGUOUS);
  assert.equal(room.reason, LEGACY_REASON.DIRECTORY_IDENTITY_CHANGED);
  assert.equal(room.adoptable, false);
  assert.notDeepEqual(room.directoryIdentity, { dev: String(original.dev), ino: String(original.ino) });

  // 不提供历史身份时不做否决（本模块不拥有历史，只做对照）。
  const withoutReference = await auditReadOnly(fixture);
  assert.equal(withoutReference.counts.adoptable, 1);
});

// ── 6. 迁移后账本丢失 → ledger-missing，且不自动 adopt ─────────────────────

test('6 迁移后账本丢失（有 .links.json、无账本）→ ledger-missing 且不 adopt', async (t) => {
  const fixture = await makeFixture(t);
  const directory = join(fixture.sessions, OWNER);
  await mkdir(directory);
  await writeFile(join(directory, '任务.md'), 'x\n');
  await writeRegistry(fixture, { 'ws-1': registryEntry(directory, [OWNER]) });
  await writeSessionLog(fixture, { sessionId: OWNER, cwd: directory });

  // v0.1.1 的标题入口：.links.json + 真实软链接。
  await writeFile(
    join(fixture.root, '.links.json'),
    `${JSON.stringify({ version: 2, rooms: { [`.sessions/${OWNER}`]: '旧房间' } }, null, 2)}\n`,
  );
  await symlink(`.sessions/${OWNER}`, join(fixture.root, '旧房间'));

  // 本插件自己的 scope 存储区里留下过“迁移已完成”标记，账本本身却不见了。
  // 必须是**当前 scope**（root + profile 身份）的目录：别的 scope 的标记不算证据。
  const scopeDirectory = await scopeDirectoryOf(fixture);
  await mkdir(scopeDirectory, { recursive: true });
  await writeFile(
    join(scopeDirectory, 'migration.json'),
    `${JSON.stringify({ version: 1, completed: true, at: new Date(NOW).toISOString() }, null, 2)}\n`,
  );

  const result = await auditReadOnly(fixture);
  const room = roomOf(result);

  assert.ok(room, '账本丢失的房间仍需列出来供人工处理');
  assert.equal(room.classification, LEGACY_CLASSIFICATION.LEDGER_MISSING);
  assert.equal(room.adoptable, false);
  assert.equal(room.conflictCandidate, true);
  assert.equal(room.evidence.adoption.scopeMigrated, true);
  assert.equal(room.evidence.adoption.titleLink, true);
  assert.equal(result.counts.ledgerMissing, 1);
  assert.equal(result.counts.adoptable, 0);
  assert.deepEqual(result.adoptable, [], '不得给出任何可自动 adopt 的房间');
  assert.equal(legacyRoomDraft(room, { now: NOW }), null, '账本丢失的房间不得生成 MANAGED 草稿');

  // 账本没有被“顺手”建出来。
  await assert.rejects(readFile(join(scopeDirectory, 'ledger.json'), 'utf8'), /ENOENT/u);
});

// ── 7. 普通用户工作区不 adopt ──────────────────────────────────────────────

test('7 普通用户工作区（root 外 / root 内非房间形状）不 adopt', async (t) => {
  const fixture = await makeFixture(t);
  const userProject = join(fixture.base, 'projects', '量化项目');
  await mkdir(userProject, { recursive: true });
  await writeFile(join(userProject, 'main.py'), 'print(1)\n');
  await writeSessionLog(fixture, { sessionId: OTHER, cwd: userProject });

  const rootChild = join(fixture.root, '随手记');
  await mkdir(rootChild);
  const oddSessionsChild = join(fixture.sessions, '草稿');
  await mkdir(oddSessionsChild);

  await writeRegistry(fixture, {
    'ws-user': registryEntry(userProject, [OTHER]),
    'ws-root': registryEntry(rootChild, []),
    'ws-odd': registryEntry(oddSessionsChild, []),
  });

  const result = await auditReadOnly(fixture);

  assert.equal(result.rooms.length, 0, '普通工作区不得进入房间候选');
  assert.equal(result.counts.adoptable, 0);
  assert.equal(result.scope.registryOutsideRoot, 1, 'root 外的登记只计数，不 adopt');

  const rootRejected = result.rejected.find((entry) => entry.path === rootChild);
  assert.ok(rootRejected, 'root 内非房间形状的登记必须被拒绝');
  assert.equal(rootRejected.reason, LEGACY_REASON.NOT_SESSION_DIRECTORY);
  const oddRejected = result.rejected.find((entry) => entry.path === oddSessionsChild);
  assert.ok(oddRejected, '.sessions 下的非房间目录必须被拒绝');
  assert.equal(oddRejected.reason, LEGACY_REASON.NOT_SESSION_DIRECTORY);
});

// ── 8. 已归档空目录保留且列为 room 候选 ────────────────────────────────────

test('8 已归档空目录保留，并作为 room 候选（ambiguous，不删）', async (t) => {
  const fixture = await makeFixture(t);
  const directory = join(fixture.sessions, OWNER);
  await mkdir(directory);
  await mkdir(join(fixture.root, '.archive'), { recursive: true });
  await symlink(`../.sessions/${OWNER}`, join(fixture.root, '.archive', '旧归档房间'));
  await writeRegistry(fixture, { 'ws-1': registryEntry(directory, []) });

  const result = await auditReadOnly(fixture);
  const room = roomOf(result);

  assert.ok(room, '空目录必须作为 room 候选出现（保留，不回收）');
  assert.equal(room.classification, LEGACY_CLASSIFICATION.AMBIGUOUS);
  assert.equal(room.reason, LEGACY_REASON.ARCHIVED_EMPTY_DIRECTORY);
  assert.equal(room.preserve, true);
  assert.equal(room.adoptable, false);
  assert.equal(room.evidence.directory.empty, true);
  assert.equal(room.evidence.links.archived, true);
  assert.equal(result.counts.rejected, 0);

  const entries = await readdir(directory);
  assert.deepEqual(entries, [], '空目录必须原位保留');
});

// ── 9. 无关 scope 的账本不得阻断首次迁移 ─────────────────────────────────────
//
// scope 身份 = plugin + profile + canonical(dshHome) + canonical(root)。同一 DSH_HOME
// 下别的 root/profile 建了账本，只说明那个 scope 迁移过，与当前 scope 的首次旧房间无关；
// 拿它当「账本已存在」会把本可 adopt 的房间降级成 ambiguous（OW-11／OW-12）。

test('9 其它 root/profile 的账本不算当前 scope 的「账本已存在」', async (t) => {
  const fixture = await makeFixture(t);
  const directory = join(fixture.sessions, OWNER);
  await mkdir(directory);
  await writeRegistry(fixture, { 'ws-1': registryEntry(directory, [OWNER]) });
  await writeSessionLog(fixture, { sessionId: OWNER, cwd: directory });

  const first = await auditReadOnly(fixture);
  assert.equal(roomOf(first).classification, LEGACY_CLASSIFICATION.ADOPTABLE);
  assert.equal(first.scope.ledgerExists, false);
  assert.deepEqual(first.scope.migrationSources, []);

  // 同 DSH_HOME、完全不同 root + profile 的 scope 迁移过。
  const foreign = await LedgerStore.open({
    dshHome: fixture.dshHome,
    canonicalRoot: join(fixture.base, 'other-root'),
    profileId: 'different-profile',
  });
  await foreign.update((state) => {
    state.migration.completed = true;
  });

  const afterForeignRoot = await auditReadOnly(fixture);
  const foreignRoom = roomOf(afterForeignRoot);
  assert.equal(foreignRoom.classification, LEGACY_CLASSIFICATION.ADOPTABLE, '别的 root 的账本不得降级本 scope 的房间');
  assert.equal(afterForeignRoot.scope.ledgerExists, false);
  assert.deepEqual(afterForeignRoot.scope.migrationSources, []);
  assert.equal(foreignRoom.evidence.adoption.scopeMigrated, false);

  // 同 root、不同 profile：同样不是当前 scope。
  const foreignProfile = await LedgerStore.open({
    dshHome: fixture.dshHome,
    canonicalRoot: fixture.root,
    profileId: 'another-profile',
  });
  await foreignProfile.update((state) => {
    state.migration.completed = true;
  });

  const afterForeignProfile = await auditReadOnly(fixture);
  assert.equal(roomOf(afterForeignProfile).classification, LEGACY_CLASSIFICATION.ADOPTABLE);
  assert.equal(afterForeignProfile.scope.ledgerExists, false);
  assert.deepEqual(afterForeignProfile.scope.migrationSources, []);

  // 当前 scope 自己的账本仍然是「账本已存在」：迁移走过就不许再自动 adopt。
  const own = await LedgerStore.open({ dshHome: fixture.dshHome, canonicalRoot: fixture.root });
  await own.update((state) => {
    state.migration.completed = true;
  });

  const afterOwn = await auditReadOnly(fixture);
  const ownRoom = roomOf(afterOwn);
  assert.equal(afterOwn.scope.ledgerExists, true, '当前 scope 的账本必须被认出来');
  assert.deepEqual(afterOwn.scope.migrationSources, [own.path], '审计读的必须是 store 写的那一份');
  assert.equal(ownRoom.classification, LEGACY_CLASSIFICATION.AMBIGUOUS);
  assert.equal(ownRoom.reason, LEGACY_REASON.LEDGER_PRESENT);
  assert.equal(ownRoom.adoptable, false);
  assert.equal(afterOwn.counts.adoptable, 0);
});

// ── 10. 祖先软链接 / `..` / 末尾斜杠不得造成成员冲突 ────────────────────────
//
// root 自己经祖先 symlink 指向真实目录时，宿主写下的 workspace.path 与 header.cwd 都是
// 真实路径；审计从别名 root 进来，前面已用 realpath 认定 cwdMatches=true，后续任何
// 路径比较都不能退回「未归一的字符串比较」而判 MEMBER_CONFLICT。

test('10 root 经祖先软链接指向真实目录 → 仍 adoptable（等价拼写不分裂）', async (t) => {
  const fixture = await makeFixture(t);
  const directory = join(fixture.sessions, OWNER);
  await mkdir(directory);
  const realDirectory = await realpath(directory);
  const realRootPath = await realpath(fixture.root);
  const alias = join(dirname(fixture.root), 'root-alias');
  await symlink(realRootPath, alias);

  // 宿主正常行为：registry 与 header 都用真实路径；用户给 root 配了别名软链接。
  await writeSessionLog(fixture, { sessionId: OWNER, cwd: realDirectory });
  await writeRegistry(fixture, { 'ws-1': registryEntry(realDirectory, [OWNER]) });

  for (const root of [alias, `${alias}${sep}`, join(alias, '.sessions', '..')]) {
    const result = await auditLegacyRooms({ root, dshHome: fixture.dshHome, now: NOW });
    const room = roomOf(result);
    assert.ok(room, `root=${root} 必须产出房间候选`);
    assert.equal(room.members[0].cwdMatches, true, `root=${root} 的真实目录已认定相同`);
    assert.equal(room.members[0].eligibility, 'eligible', `root=${root} 不得判成员冲突`);
    assert.equal(room.classification, LEGACY_CLASSIFICATION.ADOPTABLE, `root=${root} 不得因拼写差异降级`);
    assert.equal(room.reason, LEGACY_REASON.EVIDENCE_COMPLETE);
    assert.deepEqual(room.evidence.score, { directory: true, registry: true, session: true });
    assert.equal(result.scope.registryOutsideRoot, 0, '真实路径的登记仍属 root 内');
    assert.equal(result.scope.registryRoomMissing, 0);
    assert.equal(result.counts.rejected, 0, '登记不得因拼写差异被当成 root 内非房间目录拒绝');
  }

  // 别名拼写的登记（目录已被删）仍算「root 内缺失」，不得记成 root 外登记。
  const ghost = 'session-33333333-3333-4333-8333-333333333333';
  await writeRegistry(fixture, {
    'ws-1': registryEntry(realDirectory, [OWNER]),
    'ws-2': registryEntry(join(alias, '.sessions', ghost), []),
  });
  const ghosted = await auditLegacyRooms({ root: alias, dshHome: fixture.dshHome, now: NOW });
  assert.equal(ghosted.scope.registryOutsideRoot, 0, '别名拼写的登记仍在 root 内');
  assert.equal(ghosted.scope.registryRoomMissing, 1, '缺失房间按 root 内计数');

  // 反向守卫：真的换了目录仍然判冲突，不能靠「一律放行」蒙对。
  const before = await auditLegacyRooms({ root: alias, dshHome: fixture.dshHome, now: NOW });
  assert.equal(before.counts.adoptable, 1);
  // 日志按 cwd 分桶：先撤掉旧桶，避免同一 sessionId 在同一份数据里出现两个 header。
  const elsewhere = join(fixture.sessions, OTHER);
  await mkdir(elsewhere, { recursive: true });
  await rm(await sessionLogDirectory(fixture, realDirectory, OWNER), { recursive: true, force: true });
  await writeSessionLog(fixture, { sessionId: OWNER, cwd: elsewhere });
  const conflicted = await auditLegacyRooms({ root: alias, dshHome: fixture.dshHome, now: NOW });
  const conflictedRoom = roomOf(conflicted);
  assert.equal(conflictedRoom.members[0].cwdMatches, false);
  assert.equal(conflictedRoom.reason, LEGACY_REASON.CWD_MISMATCH);
  assert.equal(conflictedRoom.classification, LEGACY_CLASSIFICATION.AMBIGUOUS);
});
