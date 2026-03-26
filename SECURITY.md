# Security Policy

## Supported versions

Security updates are applied to the latest published version.

## Reporting a vulnerability

If you discover a security issue:

1. Do not open a public issue with exploit details.
2. Open a [GitHub private security advisory](https://github.com/mnaeem1/AI-Usage-Bar/security/advisories/new)
   to report it confidentially, or contact the maintainer via the repository's GitHub profile.
3. Include reproduction steps, impact, and suggested fix.

A response will be provided within 5 business days.

## Security design notes

- Tokens are sourced from local provider auth stores.
- Secrets are not persisted by this extension.
- Verbose logs are disabled by default.
- Provider API calls use HTTPS only.
- The macOS Keychain is read using `execFile` (not `exec`) to prevent shell injection.
