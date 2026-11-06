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

## Retired setting

| Setting | Status | Behaviour |
| --- | --- | --- |
| `idleMs` | Ignored since v0.1.1 | Former threshold for automatic archiving based on log inactivity. Leaving it in an old configuration has no effect and does not enable startup archiving. |

In v0.1.1, archive blank sessions manually. Unarchived chats remain available when the plugin starts or is re-enabled. Startup maintenance only reclaims owned empty directories that are **already archived** and have no unarchived session sharing them (`.DS_Store` alone is allowed), preserving session logs and archive flags. Directory reclamation and session archiving are separate operations.

There are currently no other plugin settings for idle archiving, automatic archiving at startup, polling intervals, or toggling empty-directory reclamation. `DSH_HOME` is a host environment variable affecting the default `root`, not a plugin-row configuration field.
