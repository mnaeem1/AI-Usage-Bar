# AI Usage Bar

A minimal VS Code extension that displays a single status bar item showing AI usage for **Claude**, **OpenAI/Codex**, and **GitHub Copilot Chat**, including context-window information when available.

## Status Bar Example

```
Claude 5H [██░░░░░░] 42% 1h20m | 7D [███░░░░░] 58% 2d3h | Ctx 200k  OpenAI wk [███░░░░░] 35% 4d2h | Ctx 128k  Copilot wk [██░░░░░░] 25% 5d1h | Ctx n/a
```

**Color coding:**
- Default color when all providers are below 80%
- Orange (`#ff9800`) when any provider reaches ≥ 80%
- Red (`#ff4444`) when any provider reaches ≥ 90%

## Features

- Polls all three AI providers on startup and every `aiUsage.refreshSeconds` seconds (default: 60).
- Command **AI Usage: Refresh Now** to force an immediate refresh.
- Graceful fallbacks: if a command fails or returns unexpected data, that provider shows `n/a`.
- Context window displayed as `Ctx <value>` (e.g. `Ctx 200k`) or `Ctx n/a` if unavailable.
- All errors logged to the **AI Usage** output channel.

## Requirements

The extension calls configurable shell commands to fetch usage data.  The default commands (`claude-code`, `openai-usage`, `copilot-usage`) are placeholders – replace them with commands that return the expected JSON shapes.

### Expected JSON Shapes

**Claude** (`claudeUsage.command`):
```json
{
  "rate_limits": {
    "five_hour": { "used_percentage": 42, "resets_at": 1700000000 },
    "seven_day": { "used_percentage": 58, "resets_at": 1700100000 }
  }
}
```

**Claude context** (`claudeUsage.contextCommand`):
```json
{ "context_window": 200000 }
```

**OpenAI / Copilot** (`openaiUsage.command` / `copilotUsage.command`):
```json
{
  "weekly": {
    "used_percentage": 35,
    "resets_at": 1700200000
  }
}
```
Or alternatively with `used` / `limit` fields:
```json
{ "weekly": { "used": 45, "limit": 128, "resets_at": 1700200000 } }
```

**OpenAI / Copilot context** (`openaiUsage.contextCommand` / `copilotUsage.contextCommand`):
```json
{ "context_window": 128000 }
```

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `aiUsage.refreshSeconds` | `60` | Poll interval in seconds |
| `claudeUsage.command` | `claude-code --status --json` | Command for Claude usage |
| `claudeUsage.contextCommand` | `claude-code --context --json` | Command for Claude context window |
| `openaiUsage.command` | `openai-usage --json` | Command for OpenAI usage |
| `openaiUsage.contextCommand` | `openai-model --info --json` | Command for OpenAI context window |
| `copilotUsage.command` | `copilot-usage --json` | Command for Copilot usage |
| `copilotUsage.contextCommand` | `copilot-model --info --json` | Command for Copilot context window |

## Development

```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```
