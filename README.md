<p align="center">
  <img src="icon.svg" width="96" height="96" alt="dsh-chat-sessions logo">
</p>

<h1 align="center">dsh-chat-sessions</h1>

<p align="center">
  简体中文 · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/ZSQBFan/dsh-chat-sessions/actions/workflows/ci.yml"><img src="https://github.com/ZSQBFan/dsh-chat-sessions/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/ZSQBFan/dsh-chat-sessions/releases/latest"><img src="https://img.shields.io/github/v/release/ZSQBFan/dsh-chat-sessions?color=247bbf" alt="GitHub Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3da76a" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#功能">功能</a> · <a href="#安装">安装</a> · <a href="#注意事项">注意事项</a> · <a href="docs/CONFIGURATION.md">配置参考</a> · <a href="CHANGELOG.md">更新日志</a>
</p>

---

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：一键新建自带独立工作区的会话，让日常问答和小型任务无需手动选择项目目录即可开始。

<p align="center">
  <img src="docs/assets/overview.gif" width="900" alt="独立对话整体演示">
</p>

## 功能

| 功能 | 说明 |
| --- | --- |
| **一键开始，工作区独立** | 新建会话自带独立工作区；派生会话可能继续使用同一目录。 |
| **现有的会话操作习惯** | 交互方式与原版 DSH 保持一致，切换、置顶、归档与恢复等操作沿用熟悉的方式，上手无需重新适应。 |
| **文件管理，方便查找** | 按会话标题整理文件入口，方便找到某次对话中产生的文件，随时查看、编辑或继续使用。 |

### 功能演示

<details>
<summary>一键开始</summary>

<p align="center">
  <img src="docs/assets/one-click.gif" width="900" alt="一键新建独立对话演示">
</p>

</details>

<details>
<summary>会话管理</summary>

<p align="center">
  <img src="docs/assets/session-management.gif" width="900" alt="独立对话会话管理演示">
</p>

</details>

<details>
<summary>归档与恢复</summary>

<p align="center">
  <img src="docs/assets/archive-restore.gif" width="900" alt="独立对话归档与恢复演示">
</p>

</details>

## Requirements

宿主要求：DeepSeek Harness `>=0.2.0-rc.2 <0.3.0-0`，开发与测试基线为 `0.2.2-rc.1`。

## 安装

当前版本 **v0.2.0**：[GitHub Release](https://github.com/ZSQBFan/dsh-chat-sessions/releases/tag/v0.2.0)。

1. 从 Release 下载 `dsh-chat-sessions-0.2.0.tgz`（另附 SHA256 校验文件）。
2. 在 DSH「插件 → 添加插件」中填写下载文件的绝对路径，安装并启用；按宿主提示重新加载或重启。

`main` 分支用于后续开发，固定版本请使用对应 Release 的安装包。

## 注意事项

- **归档**：使用 DSH 原生会话菜单归档或恢复。归档会取消置顶，恢复后可重新置顶。
- **停用插件**：从 DSH 插件页停用或卸载时，会话不会被归档或删除，而会暂时显示在「未分组」；重新启用后，符合条件的会话会接回。普通重启不会触发交接。详细行为见[更新日志](CHANGELOG.md)。
- **工作目录**：新建会话有自己的目录；派生会话可能共用目录。这是文件整理方式，不是系统隔离。不要手动移动或删除插件目录。
- **意外中断**：强制结束 DSH 可能留下空工作区。请先在 DSH 核对工作区路径和成员；确认为空后再删除工作区登记，并保留会话目录和文件。完整处理步骤见[配置参考](docs/CONFIGURATION.md)。
- **升级与草稿**：更改 `root` 不会迁移已有数据；未发送的输入内容可能只保留在当前浏览器页面，重要草稿请先保存。

## 配置

默认配置即可使用。完整的配置项、默认值、取值范围及示例见[配置参考](docs/CONFIGURATION.md)，包括存放位置、侧栏分组、动效、视觉标记、工作区名称和实验选项。

旧版 `idleMs` 已停用，保留旧配置也不会生效。

## 更新日志

**v0.2.0** 增加停用/卸载时的工作区交接、旧会话补接管及工作区菜单清理；空白会话不再按闲置时间自动归档。详见[更新日志](CHANGELOG.md)。

完整版本历史见[更新日志](CHANGELOG.md)。

## 开发检查

<details>
<summary>开发环境与检查命令</summary>

需要 Node 22 及以上；CI 使用 Node 22。`npm ci` 安装开发依赖后：

- `npm run check`：包结构、导出、patch 与语法检查。
- `npm test`：文件系统、DOM 与行为测试，只用开发依赖，不需要原生 DSH 包。
- `npm run test:native`：原生侧栏投影契约，需本机已安装 DSH，并用 `DSH_NATIVE_WORKSPACE_CLIENT` 指向它的 `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`。
- `npm run test:lifecycle:native` / `npm run test:lifecycle:e2e`：隔离真实宿主的服务级生命周期测试；后者不含浏览器。

完整独立验收见[测试手册](docs/testing/20261108/TEST-PLAN.md)，交给另一会话可使用[DeepSeek V4.1 Flash 执行 prompt](docs/testing/20261108/AGENT-PROMPT.md)。

`check-*-browser.mjs` 是需要用浏览器手动打开的夹具，不包含在 `npm test` 内；其中成员位移夹具也需设置 `DSH_NATIVE_WORKSPACE_CLIENT`（或 `HARNESS_ROWS_SOURCE`）。CI 配置见 `.github/workflows/ci.yml`。

</details>

## 兼容与反馈

主要在 macOS 的 DSH 0.2.2-rc.1 环境使用和验证，其他平台与版本尚待验证。插件依赖原生侧栏结构，DSH 更新后可能需要适配。

这是个人维护项目，按实际使用情况更新。遇到问题请到 [Issues](https://github.com/ZSQBFan/dsh-chat-sessions/issues) 附上 DSH 版本、系统和复现步骤；截图或日志请先移除私人内容。

[MIT](LICENSE) · zsqbfan
