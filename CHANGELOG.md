# Changelog

## [Unreleased]

- 新增：生命周期交接。在 DSH 原生插件页显式停用插件或停用 bundle 时，插件撤掉自有工作区登记，会话回到原生「未分组」，仍可继续聊天并在原目录使用工具；重新安装/启用时只把仍未分组、目录身份匹配、归属明确的旧会话挂回原房间。普通重启、热更新、无关配置刷新保持原工作区不变。
- 新增：生命周期账本 `<DSH_HOME>/storages/dsh-chat-sessions-lifecycle/<scopeId>/ledger.json`（scope = 数据根 + profile + 插件 + 规范化 root），单 writer 锁、原子落盘、坏账本只读降级（`DEGRADED`）。
- 新增：`GET /chat-sessions/status` 返回 `lifecycle`、`managedWorkspaceIds`、`managedSessionIds`；前端改用明确托管集合判定归属，不再只按 `.sessions/session-*` 路径形状压平工作区。
- 变更：**取消房间目录回收**。启动维护不再回收已归档空目录，任何目录（含空白与已归档）只在用户自己删除时消失；相应测试改为断言目录与文件保持。
- 变更：启用、新建、空白复用、启动恢复共用一个生命周期闸门；账本未就绪时写请求返回 `409 LIFECYCLE_NOT_READY`。
- 测试：新增 `npm run test:lifecycle`（19 项）、`test:lifecycle:native`（28 项真宿主断言）、`test:lifecycle:e2e`；`npm test` 纳入 `check-lifecycle*.mjs`（127 项）。
- 文档：README 中英文、配置参考补充目录保留、停用与重装、恢复冲突、scope 与离线限制说明。

### 独立验收复审修复（2026-11-07）

- 修复：共享工作目录房间把同 `cwd` 的派生会话误判成外来成员，导致停用后房间 `CONFLICT`、无法交接。房间即目录，同目录成员一律按本房间处理。
- 修复：恢复时会把用户在停用期间新建的**同路径普通工作区**当成自己的登记并挂会话。现在同路径已存在别的登记即判 `RELEASED`（`USER_CLAIMED`），只复用账本里记的那个 Workspace ID。
- 修复：`PARTIAL` / `RELEASED` 房间的未挂回成员被错写成 `attached`，`managedSessionIds` 泄漏。托管集合现在只收托管态房间里真正挂上的成员。
- 修复：创建意图或收尾写账本失败时仍返回 200。现在先落意图再建原生对象，写失败返回 `503 LIFECYCLE_LEDGER_UNAVAILABLE` 并降级，不再留下无账本的空壳。
- 修复：活 writer 租约过期后双写、旧事务覆盖新提交。新增租约续租与提交前 `token` + `revision` 校验（`LOCK_LOST` / `REVISION_CONFLICT`），失败绝不覆盖。
- 修复：账本被删后被静默当成首次安装重建。新增 `initialized.json` 凭据，判 `LEDGER_MISSING_AFTER_INIT` 并只读降级；老版本升级（有账本无凭据）以账本为准补写。
- 修复：目录 `fsync` 的真实 I/O 错误被吞。平台不支持则记 `limitations`，真实故障抛 `LEDGER_DURABILITY_UNKNOWN`（消息写明 rename 已发生）。
- 修复：维护扫描会绕过账本修改/改名非托管工作区。未托管会话与工作区现在只记 `retained-unmanaged`，不改标题、不删登记、不建目录。
- 修复：旧数据审计被其它 scope 的账本阻断、祖先软链接路径误判。审计只读当前 scope 目录，路径比较统一走 canonical 身份。
- 新增：首次升级的多证据迁移接入启动流程。无账本时按「registry + 真实目录 + 会话 header」认领可确认的旧房间，证据不足只计数不猜；写 `migration.completed` 避免每次启动重扫。
- 新增：`test-support/native-lifecycle-harness.mjs` 覆盖同目录派生会话、`LC_NATIVE_REMOVE=1` 时的原生 bundle 卸载交接。

### 第二轮独立复审修复（2026-11-07/08）

- 修复：提交在 `fence` 之后、`rename` 之前被挂起，租约过期后新 writer 提交，旧 writer 恢复仍覆盖（`generation` 10 → 1）。提交后追加 `history.jsonl` 再复验锁归属；锁已易主就按历史回写并抛 `LOCK_LOST`。
- 修复：恢复意图写不进账本仍继续创建原生工作区。现在直接 `DEGRADED`，不产生原生副作用。
- 修复：首次迁移写失败后启动流程又把 `DEGRADED` 覆盖成 `READY`。迁移失败向上抛 `blocked`，启动即失败。
- 修复：收尾写账本失败留下的原生对象重启后不对账。启动按原生 registry 把已建成的意图补成房间（`ADOPTED`），停用后不再遗留工作区。
- 修复：已排队的维护任务在停用完成后仍写标题软链接，`DEGRADED` 时也照写。`sweep` 按 `generation` 与 `canWrite()` 逐会话闸门，`/link` 与定时扫描都进 `coordinator.track`。
- 修复：删除登记前的最后确认里看到的新同 `cwd` 成员没入账就删登记。现在先补进 `sessionIds`/`members`，写失败则不删登记。
- 修复：同 `cwd` 的子代理成员被当派生成员补账并恢复。新增 `isSubagentHeader()`，派生与外来判定都跳过子代理。
- 修复：`PARTIAL` 房间不再进入恢复候选，故障解除后也不重试。现在进入候选，只补缺失成员。
- 修复：旧数据审计不识别 `initialized.json`，会把「账本丢失」报成 `adoptable`。审计现在输出 `initialized` / `INITIALIZED_WITHOUT_LEDGER`。
- 测试：新增 `check-lifecycle-review2.mjs`（6 项，协调器级注入失败），`npm test` 133 项。

## 0.1.1 — 2026-11-06

- 修复：空白独立会话等待约 90 秒后被误归档、当前编辑器退回工作区选择的问题。维护不再按日志闲置时间自动归档，保护未发送草稿及插件重新激活时的待续会话；保留标题链接同步和已归档空目录回收。
- 配置：`idleMs` 已停用并忽略，空白对话由用户手动归档。旧版已归档的会话可从原生归档列表手动恢复。
- 文档：README 增加 Requirements 段，说明宿主版本范围与已验证基线；中英文安装说明更新至 v0.1.1，补充安装包、校验文件和升级说明。
- 清单：`engines` 只保留 `dsh`，移除无运行时作用的 `node`。

## 0.1.0 — 2026-11-05

- 首次公开发布 GitHub Release，提供独立对话入口与可折叠侧栏分组。
- 支持空白复用、切换、置顶、归档及恢复，维护房间工作目录与标题链接。
- 支持闲置空白归档、已归档空目录回收、侧栏排序、悬停预览、键盘操作和动效适配。
- 后续改动在 `main` 分支继续；本版本标签保持固定。
