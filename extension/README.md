# Context Runway (VS Code extension)

A status bar item + panel that visualizes:

- **Context window runway** for the current Claude Code session (line chart of context % used over the session).
- **5-hour and 7-day rate-limit usage**, each as its own chart, with time-to-reset.

Click the status bar item (or run **Context Runway: Show Usage Panel**) to open the full view.

![VS Code panel with context window and rate-limit charts](../docs/screenshots/panel.png)

Requires VS Code >= 1.85 and Node.js >= 18 (to package the `.vsix`).

## Data source

This extension is a viewer. It does not talk to Claude Code or the Anthropic API directly — it reads the same rolling snapshot log that the [`statusline`](../statusline) tool writes to `~/.claude/context-runway/usage-history.jsonl` every time Claude Code's status line refreshes.

**You need the statusline installed first** for there to be any data:

```bash
cd ../statusline
npm run install-statusline
```

Once installed, keep using Claude Code as normal — this extension picks up new samples via a file watcher (with a 30s poll as a fallback).

## Run it locally (not published to the Marketplace)

1. Open the `extension/` folder in VS Code.
2. Press `F5` to launch an Extension Development Host with it loaded.

Or package a local `.vsix` to install manually:

```bash
npm run package
code --install-extension context-runway-0.1.0.vsix
```

## Tests

```bash
npm test
```

Runs the automated suite (`node --test`) against `src/historyReader.js`, `src/panel.js`, and `src/extension.js`. The `extension.js` tests run without VS Code by swapping in a minimal `vscode` module mock (`test-mocks/vscode.js`), and every test points `CONTEXT_RUNWAY_STATE_DIR` at a throwaway temp directory, so nothing ever touches your real `~/.claude/context-runway/usage-history.jsonl`.

## Contributing

See the [root CONTRIBUTING.md](../CONTRIBUTING.md) — PRs welcome, `main` is protected.
Found a security issue? See [SECURITY.md](../SECURITY.md) instead of opening a public issue.
