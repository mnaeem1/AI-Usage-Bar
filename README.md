# AI Usage Bar

AI Usage Bar shows AI quota usage in the VS Code status bar for:

- Claude Code
- OpenAI Codex
- GitHub Copilot

Built with Cursor and open for community contributions.

## Installation

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ai-usage-bar.ai-usage-bar)
or search **"AI Usage Bar"** in the VS Code Extensions panel.

## Features

- Compact status bar view with detailed hover tooltip bars
- Click status bar to refresh instantly
- Provider-level toggles (enable only what you use)
- Works across local, WSL, remote SSH, and Codespaces
- Claude-safe rate limiting and caching to avoid API over-polling
- Multiple auth fallback strategies per provider for reliability
- Version displayed directly in tooltip

## Data Sources and Auth

| Provider | Usage Source | Auth Source |
|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage` | `~/.claude/.credentials.json` or macOS Keychain |
| Codex | `python -m codex_cli_usage json` (preferred), local auth fallback | `~/.codex/auth.json` |
| Copilot | `api.github.com/copilot_internal/user` | VS Code GitHub session, then `gh auth token` fallback |

## Commands

| Command | Description |
|---|---|
| `AI Usage: Refresh Now` | Force immediate refresh |
| `AI Usage: Sign in to GitHub (for Copilot)` | Trigger GitHub sign-in flow |
| `AI Usage: Toggle Claude Provider` | Enable/disable Claude |
| `AI Usage: Toggle Codex Provider` | Enable/disable Codex |
| `AI Usage: Toggle Copilot Provider` | Enable/disable Copilot |

## Settings

| Setting | Default | Description |
|---|---|---|
| `aiUsage.refreshSeconds` | `120` | Poll interval in seconds (min 30) |
| `aiUsage.claudeMinApiMinutes` | `5` | Minimum minutes between Claude API calls |
| `aiUsage.providers.claude` | `true` | Enable Claude tracking |
| `aiUsage.providers.codex` | `true` | Enable Codex tracking |
| `aiUsage.providers.copilot` | `true` | Enable Copilot tracking |
| `aiUsage.debugLogs` | `false` | Enable verbose logs in Output panel |

## Status States

| Indicator | Meaning |
|---|---|
| `⚠` | Provider not authenticated |
| `✕` | API or network error |
| `⏳` | Temporarily rate-limited |
| `∞` | Unlimited plan |
| `--` | Logged in, but provider returned no usage quota data |

## Security Notes

- Tokens are read from local auth stores and never written to disk by this extension.
- Verbose logs are disabled by default (`aiUsage.debugLogs=false`).
- The extension does not send data to any server other than provider APIs.

## Request for Contributors

Want to add another model/provider (for example Gemini, Perplexity, or others)?
Open an issue or PR. Provider additions are welcome and encouraged.

See `CONTRIBUTING.md` for contribution rules.

## Development

```bash
npm install
npm run compile
```

Run with F5 in VS Code to open the Extension Development Host.

## Marketplace Readiness

This repository is prepared for public publication. Before publishing:

1. Ensure publisher ownership in the Visual Studio Marketplace
2. Run `npx @vscode/vsce package`
3. Optionally run `npx @vscode/vsce publish`
