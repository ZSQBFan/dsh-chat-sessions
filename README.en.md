<p align="center">
  <img src="icon.svg" width="96" height="96" alt="dsh-chat-sessions logo">
</p>

<h1 align="center">dsh-chat-sessions</h1>

<p align="center">
  <a href="README.md">简体中文</a> · English
</p>

<p align="center">
  <a href="https://github.com/ZSQBFan/dsh-chat-sessions/actions/workflows/ci.yml"><img src="https://github.com/ZSQBFan/dsh-chat-sessions/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/ZSQBFan/dsh-chat-sessions/releases/latest"><img src="https://img.shields.io/github/v/release/ZSQBFan/dsh-chat-sessions?color=247bbf" alt="GitHub Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3da76a" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#installation">Installation</a> · <a href="#notes">Notes</a> · <a href="docs/CONFIGURATION.en.md">Configuration</a> · <a href="CHANGELOG.md">Changelog</a>
</p>

---

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that creates a chat with its own workspace in one click. Start everyday questions and small tasks without manually choosing a project directory. Its appearance and interactions follow the native DSH sidebar, fitting into the way you already manage sessions.

<p align="center">
  <img src="docs/assets/overview.gif" width="900" alt="Standalone chats overview">
</p>

## Features

| Feature | Description |
| --- | --- |
| **Start in one click** | Choose the standalone chat entry in the home page workspace picker, or use the new-chat button beside the standalone sidebar heading. The plugin prepares the workspace and working directory for you. |
| **Manage chats together** | A collapsible sidebar group supports switching, pinning, archiving, and restoring chats, with native session menus, hover previews, and keyboard controls. |
| **Reuse and sort** | Reuses eligible blank chats. Blanks appear first; pinned and ordinary chats are each sorted by recent activity. |
| **Keep files connected** | Maintains readable title links, keeps blank chats available while composing unsent drafts, and conditionally reclaims empty archived directories at startup. |

### Feature demos

<details>
<summary>Start in one click</summary>

<p align="center">
  <img src="docs/assets/one-click.gif" width="900" alt="Create a standalone chat in one click">
</p>

</details>

<details>
<summary>Session management</summary>

<p align="center">
  <img src="docs/assets/session-management.gif" width="900" alt="Manage standalone chat sessions">
</p>

</details>

<details>
<summary>Archive and restore</summary>

<p align="center">
  <img src="docs/assets/archive-restore.gif" width="900" alt="Archive and restore standalone chats">
</p>

</details>

## Requirements

Requires DeepSeek Harness `>=0.2.0-rc.2 <0.3.0-0`; developed and tested against `0.2.1-rc.5`.

## Installation

Current version: **v0.1.1**, available from [GitHub Release](https://github.com/ZSQBFan/dsh-chat-sessions/releases/tag/v0.1.1).

1. Download `dsh-chat-sessions-0.1.1.tgz` from the Release (a SHA256 checksum file is included separately).
2. In DSH's plugin page, choose “Add plugin”, enter the downloaded file's absolute path, install, and enable it. Reload or restart as prompted by the host.

The `main` branch is for continued development. For a fixed version, use the package attached to its Release.

## Notes

- **Upgrading**: keep your existing `root` configuration. Changing the storage location does not migrate existing data. Chats already archived by an older version can be restored manually from the native archived list.
- **Archiving**: in v0.1.1, archive blank chats manually; they also remain available when the plugin starts or is re-enabled. Archive and restore through the native session menu and archived list. Archiving removes a pin; pin the chat again after restoring if needed.
- **Startup cleanup**: when the plugin starts or is re-enabled, it only reclaims owned empty directories that are already archived and have no unarchived session sharing them (`.DS_Store` alone is allowed). Archive flags and session logs remain intact; nonempty directories remain.
- **Working directories**: rooms live under `<root>/.sessions/`; title links are file shortcuts. A new room gets its own workspace and directory, while derived or subsequent sessions may share that directory. A separate directory is not a system sandbox.
- **Background maintenance**: title links and workspace membership synchronize roughly every 15 seconds. Unsent drafts live in the browser.
- **Disabling and backups**: use DSH's plugin page to disable, re-enable, or uninstall. Disabling may reveal the underlying workspaces; room files, logs, and existing workspaces remain. This version does not automatically clean up on disable or release multi-session rooms from plugin management. Back up room files along with DSH's session, workspace, and archive records.

## Configuration

Defaults work for normal use. See the [configuration reference](docs/CONFIGURATION.en.md) for every setting, default, accepted value, and an example, including storage, sidebar grouping, motion, visual markers, workspace labels, and experimental options.

The former `idleMs` setting is retired; leaving it in an existing configuration has no effect.

## Changelog

**v0.1.1** fixes blank chats being automatically archived after roughly 90 seconds, returning the editor to the workspace picker.

See the [changelog](CHANGELOG.md) for the full version history.

## Development checks

<details>
<summary>Development environment and check commands</summary>

Node 22 or newer; CI uses Node 22. After `npm ci`:

- `npm run check`: package structure, exports, patch, and syntax.
- `npm test`: filesystem, DOM, and behaviour tests; development dependencies only, no native DSH packages.
- `npm run test:native`: native sidebar projection contract; needs DSH installed locally, with `DSH_NATIVE_WORKSPACE_CLIENT` pointing at its `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`.

`check-*-browser.mjs` are fixtures you open in a browser by hand and are not part of `npm test`; the membership fixture also needs `DSH_NATIVE_WORKSPACE_CLIENT` (or `HARNESS_ROWS_SOURCE`). CI is defined in `.github/workflows/ci.yml`.

</details>

## Compatibility and feedback

Primarily used and validated on macOS with DSH 0.2.1-rc.5. Other platforms and versions remain unverified. The plugin depends on the native sidebar structure and may need adaptation after DSH updates.

This is a personally maintained project, updated as needs arise. Report problems through [Issues](https://github.com/ZSQBFan/dsh-chat-sessions/issues), including your DSH version, operating system, and reproduction steps. Remove private content from screenshots and logs first.

[MIT](LICENSE) · zsqbfan
