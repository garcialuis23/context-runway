# context-runway

Visual tooling to see how much conversation/context "runway" you have left when working with Claude Code — tokens remaining in the current context window, and how close you are to your account's hourly/weekly usage limits.

- [`statusline/`](statusline/) — a Claude Code status line showing context window usage and rate-limit burn-rate projections.
- [`extension/`](extension/) — a companion VS Code extension with a status bar item and a webview panel with history charts, reading the same data the statusline writes.

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
