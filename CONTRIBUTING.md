# Contributing to AI Usage Bar

Thanks for helping improve AI Usage Bar.

This project is open for community edits and contributions from anyone.

## Ways to contribute

- Bug reports
- Feature requests
- Documentation improvements
- New provider integrations (high priority)

## Provider integration requests

If you want to add support for another model/provider:

1. Open an issue with provider name and usage endpoint/auth approach
2. Submit a PR with:
   - provider fetch logic
   - settings toggle (`aiUsage.providers.<name>`)
   - tooltip/status bar rendering
   - fallback/error states
   - README updates

## Development workflow

```bash
npm install
npm run compile
```

Press F5 in VS Code to run Extension Development Host.

## Pull request checklist

- Keep code readable and commented where needed
- Never log secrets or token values
- Update README and CHANGELOG for user-facing changes
- Ensure `npm run compile` passes

## Code style

- Keep functions small and explicit
- Prefer clear naming over clever logic
- Keep cross-environment behavior (Windows/WSL/remote) in mind
