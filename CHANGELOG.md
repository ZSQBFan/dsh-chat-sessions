# Changelog

## [Unreleased]

- 新增：生命周期交接。在 DSH 原生插件页显式停用插件或停用 bundle 时，插件撤掉自有工作区登记，会话回到原生「未分组」，仍可继续聊天并在原目录使用工具；重新安装/启用时只把仍未分组、目录身份匹配、归属明确的旧会话挂回原房间。普通重启、热更新、无关配置刷新保持原工作区不变。
- 新增：生命周期账本 `<DSH_HOME>/storages/dsh-chat-sessions-lifecycle/<scopeId>/ledger.json`（scope = 数据根 + profile + 插件 + 规范化 root），单 writer 锁、原子落盘、坏账本只读降级（`DEGRADED`）。
- 新增：`GET /chat-sessions/status` 返回 `lifecycle`、`managedWorkspaceIds`、`managedSessionIds`；前端改用明确托管集合判定归属，不再只按 `.sessions/session-*` 路径形状压平工作区。
- 变更：**取消房间目录回收**。启动维护不再回收已归档空目录，任何目录（含空白与已归档）只在用户自己删除时消失；相应测试改为断言目录与文件保持。
- 变更：启用、新建、空白复用、启动恢复共用一个生命周期闸门；账本未就绪时写请求返回 `409 LIFECYCLE_NOT_READY`。
- 测试：新增 `npm run test:lifecycle`（13 项）、`test:lifecycle:native`、`test:lifecycle:e2e`；`npm test` 纳入 `check-lifecycle*.mjs`（116 项）。
- 文档：README 中英文、配置参考补充目录保留、停用与重装、恢复冲突、scope 与离线限制说明。

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
