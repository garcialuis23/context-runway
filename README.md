# context-runway

Visual tooling to see how much conversation/context "runway" you have left when working with Claude Code — tokens remaining in the current context window, and how close you are to your account's hourly/weekly usage limits.

- [`statusline/`](statusline/) — a Claude Code status line (ready to use today) showing context window usage and rate-limit burn-rate projections.
- `extension/` — a companion VS Code extension with a richer visual view (status bar + history graphs). *(in progress)*

## Quick start

```bash
cd statusline
npm run install-statusline
```

See [`statusline/README.md`](statusline/README.md) for details.
