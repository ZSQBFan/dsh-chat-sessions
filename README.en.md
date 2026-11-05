# dsh-chat-sessions

[简体中文](README.md)

A small personal [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for everyday questions and temporary tasks. Start a standalone chat without manually choosing a project workspace first.

## Features

- A collapsible sidebar group for creating, switching, pinning, archiving, and restoring chats.
- Reuses eligible blank chats. Blanks appear first; pinned and ordinary chats are each sorted by recent activity.
- Working directories for new rooms, with readable title links.
- Automatic archiving of idle blank chats and conditional cleanup of empty archived directories.

## Requirements

- DeepSeek Harness `>=0.2.0-rc.2 <0.3.0-0` (developed and tested against `0.2.1-rc.5`)

## Installation and use

**v0.1.0 is released**: [GitHub Release](https://github.com/ZSQBFan/dsh-chat-sessions/releases/tag/v0.1.0). Download the package from the Release to install it; the `main` branch is for continued development and the release tag remains fixed. Follow the host's restart instructions if shown.

Choose the standalone chat entry in the home page workspace picker, or use the new-chat button beside the standalone sidebar heading. Archive and restore through the native session menu and archived list. Archiving removes a pin; pin the chat again after restoring if needed.

Use DSH's plugin page to disable, re-enable, or uninstall. Disabling may reveal the underlying workspaces. This version does not automatically clean up on disable or release multi-session rooms from plugin management.

## Configuration

Defaults work for normal use. Adjust these through DSH's supported plugin-row configuration workflow if needed:

| Setting | Default | Purpose |
| --- | --- | --- |
| `root` | Empty string | Room storage: `$DSH_HOME/chats`, or `~/.dsh/chats` when `DSH_HOME` is unset. Use an absolute path for a custom location |
| `idleMs` | `90000` | Idle archive threshold for message-free blank chats, in milliseconds; `0` does not disable maintenance |
| `flattenUngrouped` | `true` | Present standalone chats as a flattened sidebar group |
| `glideMotion` | `auto` | `auto` follows reduced-motion preferences, `off` disables plugin glides, and `force` permits them regardless of that preference |

Leave other options at their defaults. Changing `root` does not migrate existing data.

## Data

Rooms live under `<root>/.sessions/`; title links are file shortcuts. The plugin registers native workspaces behind the scenes for composition and archiving. Derived or subsequent sessions may share a directory. A separate directory is not a system sandbox.

- Archiving preserves session logs and files. An expired blank chat without new activity may be archived again after restoration.
- Maintenance runs roughly every 15 seconds. Idle archiving applies to non-running blank chats with no user or assistant messages.
- Startup maintenance may reclaim owned empty archived directories with no unarchived session sharing them (`.DS_Store` alone is allowed). Nonempty directories and session logs remain.
- Disabling or uninstalling does not automatically remove rooms, logs, or existing workspaces. Back up room files along with DSH's session, workspace, and archive records.

## Development checks

Node 22 or newer; CI uses Node 22. After `npm ci`:

- `npm run check`: package structure, exports, patch, and syntax.
- `npm test`: filesystem, DOM, and behaviour tests; development dependencies only, no native DSH packages.
- `npm run test:native`: native sidebar projection contract; needs DSH installed locally, with `DSH_NATIVE_WORKSPACE_CLIENT` pointing at its `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`.

`check-*-browser.mjs` are fixtures you open in a browser by hand and are not part of `npm test`; the membership fixture also needs `DSH_NATIVE_WORKSPACE_CLIENT` (or `HARNESS_ROWS_SOURCE`). CI is defined in `.github/workflows/ci.yml`.

## Compatibility and feedback

Primarily used and validated on macOS with DSH 0.2.1-rc.5. Other platforms and versions remain unverified. The plugin depends on the native sidebar structure and may need adaptation after DSH updates.

This is a personally maintained project, updated as needs arise. Report problems through [Issues](https://github.com/ZSQBFan/dsh-chat-sessions/issues), including your DSH version, operating system, and reproduction steps. Remove private content from screenshots and logs first.

[Changelog](CHANGELOG.md) · [MIT](LICENSE) · zsqbfan
