# context-runway

[![CI](https://github.com/garcialuis23/context-runway/actions/workflows/ci.yml/badge.svg)](https://github.com/garcialuis23/context-runway/actions/workflows/ci.yml)
[![CodeQL](https://github.com/garcialuis23/context-runway/actions/workflows/codeql.yml/badge.svg)](https://github.com/garcialuis23/context-runway/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Visual tooling to see how much conversation/context "runway" you have left when working with Claude Code — tokens remaining in the current context window, and how close you are to your account's hourly/weekly usage limits.

- [`statusline/`](statusline/) — a Claude Code status line showing context window usage and rate-limit burn-rate projections.
- [`extension/`](extension/) — a companion VS Code extension with a status bar item and a webview panel with history charts, reading the same data the statusline writes.

## Requirements

- Node.js >= 18
- Claude Code (for the statusline)
- VS Code >= 1.85 (for the extension, optional)

## Quick start

```bash
cd statusline
npm run install-statusline
```

Then, for the richer VS Code view:

```bash
cd extension
npm run package
code --install-extension context-runway-0.1.0.vsix
```

See [`statusline/README.md`](statusline/README.md) and [`extension/README.md`](extension/README.md) for details.

## Contributing

Contributions are welcome via pull request — see [CONTRIBUTING.md](CONTRIBUTING.md).
`main` is protected, so all changes (including the maintainer's) go through review.
Found a security issue? See [SECURITY.md](SECURITY.md) instead of opening a public issue.

## License

[MIT](LICENSE)
