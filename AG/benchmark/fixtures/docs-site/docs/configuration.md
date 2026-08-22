# Configuration

Settings are read from `taskctl.config.json` in the working directory. Every
setting can also be given as a command-line flag, which takes precedence.

## Settings

| Setting | Type | Default | Effect |
|---|---|---|---|
| `store` | string | `./tasks.json` | Path to the JSON file holding the tasks. |
| `defaultPriority` | string | `normal` | Priority given to `taskctl add` when `--priority` is omitted. |
| `colour` | boolean | `true` | Colourises list output. Ignored when stdout is not a terminal. |
| `pageSize` | number | `20` | Rows printed per page by `taskctl list`. |

## Precedence

1. Command-line flag
2. Environment variable (`TASKCTL_*`)
3. `taskctl.config.json`
4. Built-in default

## Example

```json
{
  "store": "~/notes/tasks.json",
  "defaultPriority": "high",
  "pageSize": 50
}
```
