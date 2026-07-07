# Contributing

Thanks for your interest in context-runway! This repo is public and open to
contributions — here's how that works in practice.

## Workflow

The `main` branch is protected: nobody, including the maintainer, pushes to
it directly. All changes go through a pull request from a fork:

1. Fork the repo and create a branch off `main`.
2. Make your change.
3. Run the tests (`cd statusline && npm test`).
4. Open a pull request. CI (tests + CodeQL) must pass and a maintainer must
   approve before it can be merged.

## Scope

- `statusline/` — the Claude Code status line script. No runtime dependencies
  by design; please don't add any without discussing it in an issue first.
- `extension/` — the VS Code companion extension. Same rule on dependencies.

Small, focused PRs are much easier to review than large ones. If you're
planning a bigger change, please open an issue first to discuss the approach.

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](SECURITY.md)
instead of opening a public issue.
