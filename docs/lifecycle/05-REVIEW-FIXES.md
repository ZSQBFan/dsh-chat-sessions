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

## 四、仍然缺的宿主能力

`workspaceRegistry` 没有条件删除/条件挂载（无 CAS、无 revision 参数），`mutate(fn)` 只在本进程写链内串行。插件侧把判定收拢在 `host-adapter.js`，接口一到即可替换，不需要改协调器状态机。
