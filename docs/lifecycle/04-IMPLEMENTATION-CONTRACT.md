# 生命周期交接：实现契约（04）

本文件把 [01-DESIGN.md](01-DESIGN.md) 的第 6–8、13 节固定为可实现的模块边界，供 `lifecycle/model.js`、`lifecycle/store.js` 与后续协调器共用。契约改动必须同时更新本文件与 `CHANGELOG.md`。

## 1. 模块划分

| 模块 | 职责 | 允许依赖 |
| --- | --- | --- |
| `lifecycle/model.js` | 常量、路径规范化、scopeId、账本校验/归一化、纯分类函数 | Node 内置 + 同目录模块，**不碰 fs** |
| `lifecycle/store.js` | 账本目录、原子读写、单 writer 锁、迁移入口 | `node:fs/promises`、`node:crypto`、`node:path`、`model.js` |
| `lifecycle/host-adapter.js` | 宿主服务快照、条件化 workspace delete/attach、退出原因判定 | 宿主注入的服务对象 |
| `lifecycle/coordinator.js` | freeze/drain、DETACH、RESTORE、generation 闸门 | 上面三者 |

`index.js` 只做编排与 HTTP 路由；不承载状态机细节。

## 2. 账本位置与命名

```
<effectiveDSHHome>/storages/dsh-chat-sessions-lifecycle/<scopeId>/
  ledger.json          # 唯一权威状态
  ledger.json.tmp-*    # 写临时文件（崩溃残留，读取时忽略）
  lock.json            # 单 writer 锁
  quarantine/          # LEDGER_INVALID 时把原件复制到这里（保留原始字节）
```

* `effectiveDSHHome` = `process.env.DSH_HOME`（非空）否则 `os.homedir()/.dsh`。
* 不使用宿主 `storage` 服务：`dsh-storage-json` 的 `validateDescriptor` 对单元名有格式限制（实测报 `invalid unit name`），且其 schema 变更会污染恢复语义。账本自带 schemaVersion。
* 账本不得写进安装包目录、任务 cwd、`chats/` 下的房间目录。

## 3. scope 身份

```js
scopeId = sha256([pluginId, profileId, canonical(dshHome), canonical(canonicalRoot)].join('\n')).slice(0, 32)
```

* `profileId`：优先 `profileContext.name`，缺失用 `'unknown'`。端口、PID、进程启动时间、时间戳一律不得参与。
* `canonicalRoot`：插件 root 配置解析后的 `realpath`；目录不存在时退化为 `path.resolve` 并标记 `rootResolved:false`。
* identity 变化（root 改名、换 profile、换 DSH_HOME）→ 新 scopeId → 新账本；**不隐式迁移**，旧账本原样保留并记录 `SCOPE_MISMATCH` 诊断。

## 4. 账本 schema（schemaVersion = 1）

```json
{
  "schemaVersion": 1,
  "scopeId": "32hex",
  "revision": 0,
  "updatedAt": "2026-11-07T00:00:00.000Z",
  "identity": {"pluginId": "chat-sessions", "profileId": "web", "dshHome": "/abs", "canonicalRoot": "/abs", "rootResolved": true},
  "migration": {"version": 1, "completed": true, "at": "ISO", "evidence": {"linksJson": 3, "sessionDirs": 3}},
  "generation": 0,
  "process": {"state": "READY", "lastDetach": {"reason": "USER_DISABLE", "operationId": "op-...", "at": "ISO", "outcome": "COMPLETE"}},
  "rooms": [{
    "ownerSessionId": "session-...",
    "cwd": "/abs", "canonicalCwd": "/abs",
    "directoryIdentity": {"dev": "16777230", "ino": "12345"},
    "workspaceId": "ws-...",
    "state": "MANAGED",
    "operation": {"kind": "DETACH", "id": "op-...", "from": "MANAGED", "to": "DETACHED", "startedAt": "ISO"},
    "sessionIds": ["session-..."],
    "members": [{"sessionId": "session-...", "role": "owner", "eligibility": "eligible", "lastSeenAt": "ISO"}],
    "lastError": {"code": "ATTACH_FAILED", "message": "...", "at": "ISO"},
    "updatedAt": "ISO"
  }],
  "creationIntents": [{"id": "op-...", "ownerSessionId": "session-...", "cwd": "/abs", "state": "PENDING", "at": "ISO"}]
}
```

约束：只记录 ID / 路径 / 阶段 / 错误码 / 时间；**不得**写入对话内容、提示词、token、模型输出。

`state` ∈ `MANAGED | DETACHING | DETACHED | RESTORING | PARTIAL | RELEASED | CONFLICT`；
`process.state` ∈ `STARTING | READY | QUIESCING | DISPOSED | DEGRADED`；
`operation.kind` ∈ `CREATE | DETACH | RESTORE | RECONCILE`；`intent.state` ∈ `PENDING | ADOPTED | ABANDONED`。

## 5. store.js 对外契约

```js
export class LedgerInvalidError extends Error { /* code = 'LEDGER_INVALID' */ }
export class LockHeldError extends Error { /* code = 'LOCK_HELD' */ }
export class LedgerWriteError extends Error { /* code = 'LEDGER_WRITE_FAILED' */ }

export function ledgerDirectory({dshHome, scopeId}) // -> string

export class LedgerStore {
  static async open({dshHome, profileId, canonicalRoot, pluginId, now}) // -> LedgerStore（不抛错，损坏时为 status='invalid'）
  get path()            // ledger.json 绝对路径
  get status()          // 'ready' | 'invalid' | 'absent'
  get diagnostics()     // {code, message, rawPreview?, quarantinePath?}[]
  async read()          // -> 深拷贝 state；status='invalid' 时抛 LedgerInvalidError
  async update(mutator) // mutator(state) 可原地修改或返回新 state；加锁+读+改+原子写；返回 {state, revision}
  async snapshot()      // -> {path, exists, bytes, hash, revision, schemaVersion, roomCount, lockHeld}
  async close()
}
```

* `open()` 对损坏内容不抛错：`status='invalid'`，把原始文件**复制**到 `quarantine/ledger-<ts>.json`（保留原件，不覆盖、不删除），并把 `diagnostics` 填好。任何 `update()` 都抛 `LEDGER_INVALID`，直到人工干预。
* 原子写：同目录 `ledger.json.tmp-<token>` → `writeFile` → `fsync` → `rename` → 目录 `fsync`。任一步失败 → `LedgerWriteError`，原文件不变。
* 读时忽略 `*.tmp-*`；`ledger.json` 不存在且目录存在 → `status='absent'`，首次 `update()` 时按 §4 建立（`revision` 从 0 开始，`schemaVersion=1`）。
* 并发：进程内用 promise 链串行；跨进程用 `lock.json`。
* 锁文件 `{token, pid, hostname, createdAt, leaseExpiresAt}`；`leaseMs` 默认 30000。`EEXIST` 时：同 pid 存活且在租约内 → `LockHeldError`；pid 不存活或租约过期 → 改名 `lock.stale-<ts>` 后重试一次。**绝不删除存活进程的锁**。
* `update()` 结束后必须释放锁（`finally`）；进程崩溃留下的锁只能靠租约/pid 判定回收。

## 6. model.js 对外契约

```js
export const LEDGER_SCHEMA_VERSION = 1;
export const ROOM_STATE / PROCESS_STATE / REASON / ELIGIBILITY

export function canonicalPath(p)                  // realpath 尽力而为，失败退化为 resolve
export function scopeIdentity({dshHome, profileId, canonicalRoot, pluginId})
export function createLedger(identity, {now})     // 空账本
export function normalizeLedger(raw)              // 校验+补默认值；非法抛 LedgerInvalidError
export function classifyDirectory(room, stat)     // 'ok' | 'missing' | 'not-directory' | 'identity-changed'
export function classifyMember({member, header, claimedBy, isSubagent})
export function roomTransition(room, next, {now, operation, error})
export function summarizeRooms(rooms)             // {managed, detached, restoring, partial, released, conflict}
```

`classifyDirectory`：`stat` 为 `null`（ENOENT）→ `missing`；`!isDirectory()` → `not-directory`；`dev/ino` 与账本不一致 → `identity-changed`；否则 `ok`。缺失目录**不得** mkdir。

`classifyMember`：会话日志不存在 → `missing-session`；`isSubagent` → `conflict`；header.cwd 与房间 `canonicalCwd` 不一致 → `conflict`；被其他 workspace 认领（`claimedBy` 非本房间 workspaceId）→ `user-owned`；否则 `eligible`。

## 7. 错误码与可观察结果

`REASON` 固定集合见 01-DESIGN.md 第 13 节；新增必须在此登记。HTTP 层非 READY 时返回 `409 {code:'LIFECYCLE_NOT_READY'}`；单房间失败写入 `room.lastError`，**不**回滚其它房间、不吞错。

## 8. 测试契约

`check-lifecycle-store.mjs`（L1，`node:test` + `mkdtemp`，无宿主）至少覆盖：

1. 首次 open 建目录与文件；`revision` 单调；重开可读。
2. 原子写：残留 `tmp-*` 被忽略；写入失败不破坏原文件。
3. 坏 JSON / 未知 schemaVersion → `LEDGER_INVALID`，原件字节不变，quarantine 有副本。
4. 锁：存活 pid 持锁 → `LOCK_HELD`；死 pid 或过期租约 → 回收；并发 update 不丢更新。
5. scopeId 稳定性与身份变化区分；`rootResolved:false` 不误判迁移。
6. `classifyDirectory` / `classifyMember` 分类表。
7. `creationIntents` 往返与 `ABANDONED` 收敛。
8. 越界写检查：store 只在账本目录内创建文件。
