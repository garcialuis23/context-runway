# context-runway statusline

A Claude Code status line that shows, at a glance:

- **Context runway**: how much of the current conversation's context window is used, plus an estimate of how many turns are left at the current burn rate.
- **Rate limits**: how much of your 5-hour and 7-day account usage windows are used, when each resets, and a burn-rate projection warning (⚠) if you're on pace to hit 100% before the window resets.
- **Lines of code**: how many lines Claude Code has added/removed today and in the last 7 days, across every session on this machine. This is per-machine only — it's built from the local `usage-history.jsonl` log, not synced across machines or accounts.

- **Handoff notes**: when the conversation's context window reaches 80% (before Claude Code auto-compacts it) or your 5-hour limit reaches 95%, Claude is asked to save notes on where the work stands — goal, what's done, what's in progress, next steps, key files. The next new session in that project starts with those notes already loaded, so it can pick up where the last one stopped.

It reads the JSON Claude Code already sends to status line scripts (`context_window`, `rate_limits`) — no scraping, no extra API calls, no added token cost.

![Status line showing context window and rate-limit usage](../docs/screenshots/statusline.png)

The `loc` row, showing lines added/removed today and this week:

![Status line showing the loc row with today/week lines added and removed](../docs/screenshots/lines.png)

Requires Node.js >= 18.

## Install

```bash
git clone https://github.com/garcialuis23/context-runway.git
cd context-runway/statusline
npm run install-statusline
```

This merges a `statusLine` entry and the two handoff hooks (`UserPromptSubmit`, `SessionStart`) into `~/.claude/settings.json` (backing up the previous file to `settings.json.context-runway-backup` first) and leaves every other setting untouched. Restart Claude Code, or start a new session, to see it.

To remove it:

```bash
npm run uninstall-statusline
```

## Updating

`~/.claude/settings.json` points straight at `src/index.js` inside this clone, so a plain `git pull` is enough to pick up a new version — no need to re-run the installer. The exceptions: `npm install` if `package.json` changed, or `npm run install-statusline` again if the update added a new setting. If you have this installed on multiple machines, none of this syncs automatically — repeat on each one.

## How it works

- `src/index.js` is the entry point Claude Code invokes on stdin/stdout after each assistant message.
- `src/lib/history.js` persists a throttled, rolling log of usage snapshots to `~/.claude/context-runway/usage-history.jsonl` (pruned to 9 days), so trends can be computed across turns and sessions.
- `src/lib/projection.js` fits a simple slope to recent samples within the current rate-limit window and projects whether you'll exhaust it before it resets.
- `src/lib/linesOfCode.js` turns Claude Code's cumulative-per-session `cost.total_lines_added`/`total_lines_removed` counters into a today/this-week total across every session in the log, by diffing consecutive same-session snapshots rather than summing raw totals (which would double count).
- `src/lib/render.js` renders the progress bars, colors (green/yellow/red at 70%/90% thresholds), durations, and the lines-of-code row.
- `src/handoff.js` runs as two Claude Code hooks and only reads the usage log the status line writes:
  - On each prompt (`UserPromptSubmit`) it checks this session's context usage and the account's 5-hour usage. The first time either crosses its threshold, it adds a note asking Claude to write handoff notes to `~/.claude/context-runway/handoffs/<project>-<hash>.md`. It asks once per crossing: for context, again only after usage drops back (a compaction); for the 5-hour limit, once per window.
  - On a new, cleared or compacted session (`SessionStart`, not resumes) it loads that project's notes into the session, once per version of the file, ignoring notes older than 7 days. Notes live outside your project, so they never end up in a commit.
  - Usage data comes from the status line, so it reflects the last assistant message — that's why the context threshold sits well below the ~85% where auto-compaction kicks in.

## Try it without installing

```bash
npm run demo
```

Pipes `test/fixture.json` (a mock payload matching Claude Code's documented schema) through the script so you can see the output format.

## Tests

```bash
npm test
```

Runs the automated suite (`node --test`) covering `src/lib/*`, `src/index.js`, `src/handoff.js` and the installer's hook merging, including edge cases like malformed input, throttling, pruning, compaction detection, and rate-limit projections. Every test that touches the filesystem points `CONTEXT_RUNWAY_STATE_DIR` at a throwaway temp directory, so it never reads or writes your real `~/.claude/context-runway/usage-history.jsonl`.

## Contributing

See the [root CONTRIBUTING.md](../CONTRIBUTING.md) — PRs welcome, `main` is protected.
Found a security issue? See [SECURITY.md](../SECURITY.md) instead of opening a public issue.
