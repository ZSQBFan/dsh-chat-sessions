# Configuration reference

[Back to README](../README.en.md) · [简体中文](CONFIGURATION.md)

This reference covers every plugin setting read by v0.1.1: six common settings, two experimental options, and the retired `idleMs` key. Omitted settings use their defaults.

## Applying settings

Use DSH's supported plugin configuration workflow to edit the `config` of the `chat-sessions` plugin row. The example below shows only the contents of `config`; you do not need to explicitly supply every default:

```yaml
root: ''
flattenUngrouped: true
glide: true
glideMotion: auto
treeBadge: icon
untitledWorkspaceTitle: 独立对话
ownership: workspace
seedFirstTurn: false
```

After saving, reload the plugin or restart DSH as prompted by the host. Frontend settings are read when the plugin client loads.

## Common settings

| Setting | Type / accepted values | Default | Behaviour |
| --- | --- | --- | --- |
| `root` | String | `''` | Room storage location. Empty uses `$DSH_HOME/chats`, or `~/.dsh/chats` when `DSH_HOME` is unset. Use an absolute path for a custom location; `~` and environment variables are not expanded. Changing this setting does not migrate existing data. |
| `flattenUngrouped` | Boolean | `true` | Enables the standalone sidebar group and flattens plugin-managed workspaces. `false` keeps native workspace grouping and skips the plugin's sidebar grouping logic. Background workspace and directory maintenance still runs. |
| `glide` | Boolean | `true` | Master switch for plugin sidebar glides. `false` disables them even when `glideMotion` is `force`. |
| `glideMotion` | `auto` / `off` / `force` | `auto` | `auto` follows the system or browser reduced-motion preference; `off` disables plugin glides; `force` permits them regardless of that preference, while still respecting `glide`. |
| `treeBadge` | `icon` / `tint` / `off` | `icon` | Visual marker when standalone chats are nested under another workspace in tree view. `icon` adds a chat glyph; `tint` reduces session-row opacity until hovered; `off` disables the marker. |
| `untitledWorkspaceTitle` | Nonempty string | `独立对话` | Label for the underlying managed workspaces and the composer's workspace chip. It remains separate from session titles; maintenance synchronizes existing managed workspace names to this value. An empty string or a non-string uses the default. |

`glide` and `glideMotion` control the glides added by this plugin, not every native DSH animation. With `flattenUngrouped: false`, sidebar grouping, its glides, and tree markers are inactive.

## Experimental options

These options exist for implementation experiments. Keep their defaults for everyday use.

| Setting | Type / accepted values | Default | Behaviour and limitations |
| --- | --- | --- | --- |
| `ownership` | `workspace` / `bare` | `workspace` | `workspace` registers a native workspace for a new room, enabling the native composer. `bare` creates a session without workspace membership; the current host requires a workspace to enable the composer, making this mode unsuitable for everyday chats. Changing this setting does not migrate existing data or release rooms from management. |
| `seedFirstTurn` | Boolean | `false` | Only an explicit `true` writes a closed empty first turn to newly created sessions; reused blanks are unaffected. This is known to conflict with native turn numbering and may cause `SessionFormatError: turn/start does not open the expected turn` on later reads. Keep it disabled. |

## Lifecycle and ledger

Handoff on disable, uninstall, and re-enable is automatic and has no configuration. Where it lives:

- **Ledger**: `<DSH_HOME>/storages/dsh-chat-sessions-lifecycle/<scopeId>/ledger.json` (with `lock.json` beside it). It sits outside both the installed package and the room directories, and stores session ids, paths, phases, and error codes only — never conversation content.
- **scope identity**: derived from the DSH data root, the active profile name, the plugin id, and the canonical `root`. A different profile, `DSH_HOME`, or `root` yields a different scope; nothing is migrated implicitly, and the old scope's ledger is left untouched.
- **Single writer**: one plugin instance per scope. Without the lock the plugin degrades to read-only and reports `LOCK_HELD` instead of touching native registrations concurrently.
- **Degraded state**: a corrupt ledger, a newer schema version, or a lock conflict stops automatic changes; `GET /chat-sessions/status` reports `lifecycle.state = DEGRADED` with empty `managedWorkspaceIds` / `managedSessionIds`.
- **Directories**: no room directory is reclaimed from this version on, archived empty ones included. Delete them yourself in the filesystem if you want them gone.

`/chat-sessions/status` also returns `managedWorkspaceIds` and `managedSessionIds`, so the client stops inferring ownership from path shape.

## Retired setting

| Setting | Status | Behaviour |
| --- | --- | --- |
| `idleMs` | Ignored since v0.1.1 | Former threshold for automatic archiving based on log inactivity. Leaving it in an old configuration has no effect and does not enable startup archiving. |

In v0.1.1, archive blank sessions manually. Unarchived chats remain available when the plugin starts or is re-enabled. Startup maintenance only reclaims owned empty directories that are **already archived** and have no unarchived session sharing them (`.DS_Store` alone is allowed), preserving session logs and archive flags. Directory reclamation and session archiving are separate operations.

There are currently no other plugin settings for idle archiving, automatic archiving at startup, polling intervals, or toggling empty-directory reclamation. `DSH_HOME` is a host environment variable affecting the default `root`, not a plugin-row configuration field.
