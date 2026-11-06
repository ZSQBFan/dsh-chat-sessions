# dsh-chat-sessions

[English](README.en.md)

一个自用起步的小型 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给日常问答和临时任务增加独立对话入口，不用先手动选择项目工作区。

## 功能

- 独立对话集中在可折叠的侧栏分组中，支持新建、切换、置顶、归档和恢复。
- 新建时复用合适的空白对话；分组中空白在前，置顶与普通会话各自按最近活动排序。
- 为新房间准备工作目录，并维护可读的标题链接。
- 保留待输入或含未发送草稿的空白对话，按条件回收已归档的空目录。

## Requirements

- DeepSeek Harness `>=0.2.0-rc.2 <0.3.0-0`（开发与测试基线 `0.2.1-rc.5`）

## 安装与使用

**v0.1.0 已发布**：[GitHub Release](https://github.com/ZSQBFan/dsh-chat-sessions/releases/tag/v0.1.0)。可从 Release 下载并安装；源码主分支用于后续开发，发布标签保持不变。是否需要重启，以宿主提示为准。

启用后，从首页的工作区选择入口选择“独立对话”，或点击侧栏独立对话标题右侧的新建按钮。归档和恢复使用原生会话菜单及归档列表；归档会取消置顶，恢复后可重新置顶。

停用、再次启用或卸载均通过 DSH 插件页面操作。停用后可能显露底层工作区；本版没有自动停用回收或多会话房间退出管理功能。

## 配置

默认配置即可使用。如需调整，通过 DSH 支持的插件行配置方式设置：

| 配置 | 默认 | 用途 |
| --- | --- | --- |
| `root` | 空字符串 | 房间存放位置；未指定时使用 `$DSH_HOME/chats`，未设置 `DSH_HOME` 时用 `~/.dsh/chats`。自定义时填写绝对路径 |
| `idleMs` | 已停用 | 旧版闲置归档阈值；现忽略此项，空白对话由用户手动归档 |
| `flattenUngrouped` | `true` | 将独立会话展平为侧栏分组 |
| `glideMotion` | `auto` | 动效偏好：`auto` 遵循减少动态效果设置，`off` 关闭插件滑行，`force` 强制允许 |

其他选项保持默认即可。更改 `root` 不会自动迁移旧数据。

## 数据说明

房间位于 `<root>/.sessions/`，标题链接只是文件入口。插件在后台建立原生工作区以支持输入和归档；派生或后续会话可能共享目录。独立目录不等于系统沙箱。

- 归档保留会话日志和文件；空白对话由用户手动归档，恢复后保持可用。
- 维护约每 15 秒同步标题链接和工作区归属；未发送草稿只在浏览器中，后台维护不会据此类会话的日志空闲时间自动归档。
- 启动维护可回收已归档、无未归档共享会话的自有空目录（允许仅有 `.DS_Store`）；非空目录与会话日志保留。
- 停用或卸载不会自动清除房间、日志及已有工作区。备份时同时保留房间文件和 DSH 的会话、工作区及归档记录。

## 开发检查

需要 Node 22 及以上；CI 使用 Node 22。`npm ci` 安装开发依赖后：

- `npm run check`：包结构、导出、patch 与语法检查。
- `npm test`：文件系统、DOM 与行为测试，只用开发依赖，不需要原生 DSH 包。
- `npm run test:native`：原生侧栏投影契约，需本机已安装 DSH，并用 `DSH_NATIVE_WORKSPACE_CLIENT` 指向它的 `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`。

`check-*-browser.mjs` 是需要用浏览器手动打开的夹具，不包含在 `npm test` 内；其中成员位移夹具也需设置 `DSH_NATIVE_WORKSPACE_CLIENT`（或 `HARNESS_ROWS_SOURCE`）。CI 配置见 `.github/workflows/ci.yml`。

## 兼容与反馈

主要在 macOS 的 DSH 0.2.1-rc.5 环境使用和验证，其他平台与版本尚待验证。插件依赖原生侧栏结构，DSH 更新后可能需要适配。

这是个人维护项目，按实际使用情况更新。遇到问题请到 [Issues](https://github.com/ZSQBFan/dsh-chat-sessions/issues) 附上 DSH 版本、系统和复现步骤；截图或日志请先移除私人内容。

[更新记录](CHANGELOG.md) · [MIT](LICENSE) · zsqbfan
