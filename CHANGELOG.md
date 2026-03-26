# Changelog

## 0.8.0

- Added provider toggles for Claude, Codex, and Copilot.
- Added commands to toggle each provider from Command Palette.
- Added Claude minimum API interval setting (`aiUsage.claudeMinApiMinutes`).
- Added request timeout handling for provider API calls.
- Added security-focused debug logging toggle (`aiUsage.debugLogs`).
- Improved status rendering when providers are disabled.
- Updated documentation for public open-source release.
- Added `LICENSE`, `CONTRIBUTING.md`, and `SECURITY.md`.

## 0.7.0

- Improved WSL/remote compatibility for Copilot and Codex.
- Added fallback auth/token discovery across environments.
- Reduced Claude polling pressure with stronger caching behavior.

## 0.6.0

- Added WSL-aware provider lookup and command execution.
- Added Codex and Copilot fallback paths and improved diagnostics.

## 0.5.0

- Added extension version to tooltip header.
