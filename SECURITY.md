# Security Policy

## Supported versions

Security updates are applied to the latest published version.

## Reporting a vulnerability

If you discover a security issue:

1. Do not open a public issue with exploit details.
2. Contact the maintainer privately.
3. Include reproduction steps, impact, and suggested fix.

## Security design notes

- Tokens are sourced from local provider auth stores.
- Secrets are not persisted by this extension.
- Verbose logs are disabled by default.
- Provider API calls use HTTPS only.
