# 独立验收复审与实现收敛（2026-11-07）

对应报告：`dsh-chat-sessions-lifecycle-runs/REVIEW-20261107/REPORT.md`、`REPRODUCTION.md`。
本文件记录「设计不变量 → 复审缺陷 → 实现落点 → 证据」的收敛关系，供后续维护对照；实现细节以代码与 `REPORT.md` 为准。

## 一、复审后仍成立的不变量

R01–R18 全部保留。复审没有推翻任何一条，只暴露了实现与不变量之间的偏差（F01–F10）以及三条未接线的能力（K01/K02/K04）。

## 二、新增的两条口径（写进 README 与状态接口）

1. **房间即目录**：同一 canonical `cwd` 的会话属于同一房间。共享目录的派生会话不是「外来成员」；判断外来成员看的是 `header.cwd` 是否落在房间目录之外。
2. **卸载与停用在 dispose 时刻同形**：宿主先 dispose 再删包，账本对两者都记 `BUNDLE_DISABLE`。承诺的是「登记撤掉、目录与会话原样」，不是区分标签。

## 三、缺陷 → 落点

| 缺陷 | 落点 |
| --- | --- |
| F01 共享 cwd 误判 | `lifecycle/coordinator.js#headerCwd` / `#derivedMembers`；detach 把派生成员并入房间 |
| F02 抢占同路径用户工作区 | `#restore` 的 `samePath` / `ours` / `foreignSamePath` 三段判定，`USER_CLAIMED` → `RELEASED` |
| F03 资格泄漏 | 成员资格只按 attach 结果改写；`managedSets()` / `ownsSession()` 只认托管房间的 attached 成员 |
| F04 写失败仍成功 | `beginCreate` → `#updateRequired`；失败 `degrade()` + `503 LIFECYCLE_LEDGER_UNAVAILABLE` |
| F05 租约过期双写 | `lifecycle/store.js` 续租 + `#fenceCommit`（`LOCK_LOST` / `REVISION_CONFLICT`） |
| F06 账本丢失重建 | `initialized.json` + `LEDGER_MISSING_AFTER_INIT` |
| F07 维护改非托管 | `index.js#sweep`、`normalizeReceiptTitles(managedWorkspaceIds)`，未托管记 `retained-unmanaged` |
| F08 fsync 吞错 | `#syncDirectory` 区分平台限制与 `LEDGER_DURABILITY_UNKNOWN` |
| F09 scope 混淆 | `legacy.js#readScopeStateFromDisk` 只读本 scope |
| F10 祖先软链 | `legacy.js#canonicalIdentity`、`underRoot` 双口径 |
| K01 迁移未接线 | `coordinator.js#migrateLegacy`，`index.js` 构造时传 `identity`，写 `migration.completed` |
| K02 attach 无复查 | `host-adapter.js#attachSessions({verify})`，失败 `ATTACH_PRECONDITION_FAILED` → `PARTIAL` |
| K03 空白 hero | 文档限定：只有「无历史 hero」需要先选工作区 |
| K04 读失败仍 READY | `start()` 里 `restore.blocked` → `DEGRADED` |

## 三之二、第二轮复审（REVIEW2）缺陷与落点

| 缺陷 | 落点 |
| --- | --- |
| R2-F01 fence 之后仍被覆盖 | `store.js#writeAtomic` 提交后追加 `history.jsonl` 并复验锁；`#reconcileWithHistory` 补「提交后崩溃」 |
| R2-F02 恢复意图写失败仍继续 | `#restore` 的 RESTORING 用 `#updateRequired`，失败 `degrade()` + `blocked`，不建原生对象 |
| R2-F03 迁移失败被覆盖成 READY | `#migrateLegacy` 返回 `{blocked}`，`start()` 直接失败 |
| R2-F04 收尾失败不对账 | `#reconcileCreationIntents` 按原生 registry 把已成事意图补成房间并标 `ADOPTED` |
| R2-F05 停用后旧维护仍写 | `index.js#sweep` 按 `generation`/`canWrite()` 逐会话闸门；`/link` 与定时扫描进 `coordinator.track` |
| R2-F06 迟到成员未入账 | detach 的最后确认之后 `lateDerived` 先补账；写失败不删登记 |
| R2-F07 子代理被补账 | `model.js#isSubagentHeader`，`#foreignMembers` / `#derivedMembers` 跳过 |
| R2-F08 PARTIAL 不重试 | 恢复候选加入 `PARTIAL`，只补缺失成员 |
| R2-F09 审计不认凭据 | `legacy.js` 读 `initialized.json`，报 `INITIALIZED_WITHOUT_LEDGER` |

口径补充两条：①「房间即目录」——同 `canonicalCwd` 的派生会话默认算本房间成员，子代理除外；②`PARTIAL` 只表示「部分成员没挂上」，不是冲突，下一次启动会继续补。

## 四、仍然缺的宿主能力

`workspaceRegistry` 没有条件删除/条件挂载（无 CAS、无 revision 参数），`mutate(fn)` 只在本进程写链内串行。插件侧把判定收拢在 `host-adapter.js`，接口一到即可替换，不需要改协调器状态机。

## 五、history/锁恢复修复（fix-lifecycle-history-recovery）

这一轮实现参考 `dsh-chat` 的 owner-lock 与可恢复 journal 思路，但按本插件的 `ledger.json` 语义落地：

- 租约过期不再单独构成抢锁依据；只有确认记录中的 PID 已退出，另一个 writer 才能回收锁。这样暂停后仍存活的 writer 不会在恢复时覆盖接管者提交。
- history 写入分为 `prepared` 与 `committed` 两阶段。prepared 记录先完成文件 fsync，主账本 rename 成功后再追加 committed 记录；history 写失败会让关键 update 失败并携带持久性不确定状态。
- history 恢复只接受 schema、scopeId、generation、revision 全部一致的 committed 状态，并按 `revision`、再按 `generation` 选择最新提交。
- rollback 与启动对账都必须重新取得同一把锁，在锁内重读当前账本并通过 revision fence；当前账本已经更新时保留它，避免恢复路径再覆盖后续 writer。
- 缺失 leaf 但祖先存在时，scope identity 解析已有祖先的真实路径并保留缺失尾部；这样 root 祖先软链接在目录后来创建后不会切换账本，同时修复 macOS `/var` 与 `/private/var` 的 scope 差异。
- legacy 审计同时识别规范 realpath scope 与兼容的原始路径 scope，避免当前账本因路径别名漏检；coordinator 的同路径保护和 attach 前复查使用已有路径身份比较。
- history 恢复对账显式暴露 `clean | pending | recovering | blocked`；锁忙、durability unknown、校验或恢复写失败统一进入 `blocked`。coordinator 启动先检查该状态，blocked 时进入 `DEGRADED`、禁止生命周期写入口，不会把可读但未恢复的 ledger 宣告为 READY。
- PENDING intent adoption 复用 restore 的 `classifyMember` 资格：header 缺失、cwd 不匹配、subagent、外部 Workspace claim 不进入托管成员；owner 不满足资格时保留 PENDING。adoption 提交前重新读取原生 registry，Workspace 身份或 owner membership 变化时阻断。
- restore 任一 required 状态迁移失败会立即停止本轮恢复，避免账本不可提交时继续 create/attach 后续房间；`RESTORING` 与实际 Workspace ID 保留给下一次启用或停用清理。
- history 裁剪也使用同一把锁，并对临时文件和父目录执行 fsync。

新增 `check-lifecycle-store.mjs` 第12、13项及 root symlink 回归项覆盖同代 revision、identity/foreign/invalid history、恢复锁忙和“有效账本不得被较新但不合法 history 覆盖”；`check-lifecycle-review2.mjs` 的 R2-F09～R2-F11 覆盖 coordinator 恢复锁忙、PENDING 成员资格过滤和终态写失败 fail-stop。当前完整套件为 139/139，结构检查为81项。
