# context-runway statusline

A Claude Code status line that shows, at a glance:

- **Context runway**: how much of the current conversation's context window is used, plus an estimate of how many turns are left at the current burn rate.
- **Rate limits**: how much of your 5-hour and 7-day account usage windows are used, when each resets, and a burn-rate projection warning (⚠) if you're on pace to hit 100% before the window resets.
- **Lines of code**: how many lines Claude Code has added/removed today and in the last 7 days, across every session on this machine. This is per-machine only — it's built from the local `usage-history.jsonl` log, not synced across machines or accounts.
- **Handoff notes**: when the conversation's context window reaches 80% or your 5-hour limit reaches 95%, Claude saves notes on where the work stands, and the next new session in that project starts with them loaded. If a usage limit cuts a session off mid-task, it can leave a one-click resume script or schedule the session to carry on by itself once the limit resets. See [Handoff notes](#handoff-notes) and [Resuming after a usage limit](#resuming-after-a-usage-limit).

The status line reads the JSON Claude Code already sends to status line scripts (`context_window`, `rate_limits`) — no scraping, no extra API calls, no added token cost. The only token cost is the handoff notes themselves: Claude writing them once near a limit, and reading them at the start of the next session.

<img src="../docs/screenshots/statusline.png" alt="Status line with ctx, 5h, 7d and loc rows and an auto-compaction notice" width="640">

Requires Node.js >= 18.

## Install

```bash
git clone https://github.com/garcialuis23/context-runway.git
cd context-runway/statusline
npm run install-statusline
```

This merges a `statusLine` entry and the four handoff hooks (`UserPromptSubmit`, `PostToolUse`, `SessionStart`, `StopFailure`) into `~/.claude/settings.json` (backing up the previous file to `settings.json.context-runway-backup` first) and leaves every other setting untouched. Restart Claude Code, or start a new session, to see it.

To remove it:

```bash
npm run uninstall-statusline
```

## Handoff notes

Running out of context or hitting the 5-hour limit used to mean re-explaining everything in the next chat. Now, near either limit, Claude writes down where things stand, and the next session reads it back.

**When notes are written.** On each message you send, and after each tool Claude uses (so long tasks you don't interrupt are covered too), a hook checks the latest usage the status line recorded:

| Limit | Threshold | Asked again |
| --- | --- | --- |
| Context window (this conversation) | 80% | Only after usage drops back, e.g. after a compaction |
| 5-hour limit (whole account) | 95% | Once per 5-hour window |

The first time a limit crosses its threshold, Claude is asked to save notes as part of its reply, with these sections: **Goal**, **Done**, **In progress**, **Next steps**, **Key files** and **Open questions**. It mentions in the reply that it saved them. The context threshold is 80% rather than 95% because Claude Code auto-compacts at around 85%, and usage data lags one message behind.

**When notes are read.** When you start a new session in the same project (or run `/clear`, or the conversation gets compacted), the notes are loaded into it automatically, so you can just say "carry on". Each version of the notes is loaded once, so later sessions aren't flooded with stale context, and notes older than 7 days are ignored. Resuming an existing conversation (`claude --resume`) skips them, since that conversation is already there.

**Where they live.** `~/.claude/context-runway/handoffs/<project>-<hash>.md`, one file per project folder, overwritten each time. They're plain Markdown: open them to see what was saved, edit them, or delete them to start fresh. They're kept outside your project so they never end up in a commit, and they stay on the machine that wrote them.

The first time Claude writes notes it may ask permission to write to that folder, since it's outside your project.

## Resuming after a usage limit

When the 5-hour (or 7-day) limit cuts a session off mid-turn, Claude Code fires a `StopFailure` hook with the error `rate_limit`. context-runway uses it to make picking the work back up a one-step job, or no step at all.

| `resume` mode | What happens when a limit cuts a session off |
| --- | --- |
| `script` (default) | Writes `~/.claude/context-runway/resume/<project>-<hash>.cmd` (`.sh` on macOS/Linux). Run it whenever you like: it reopens that same conversation (`claude --resume`) and asks Claude to continue from its handoff notes. |
| `schedule` | Writes the same script, **and** registers a one-off Windows Task Scheduler task (folder `\context-runway\`) for a couple of minutes after the limit resets, which resumes the conversation in the background with `claude --bg --resume`. |
| `off` | Nothing. |

**Choosing a mode per project.** Put a `.context-runway.json` in the project, or in any parent folder. The nearest one wins, the way git finds `.git`, so one file can cover a folder of repos:

```json
{
  "handoff": {
    "resume": "schedule",
    "permissionMode": "acceptEdits",
    "resumePrompt": "The usage limit has reset. Re-read your handoff notes and continue the task.",
    "extraInstructions": "Also log this session in docs/sessions/ and commit it locally."
  }
}
```

- `permissionMode` is what the background session runs with: `acceptEdits` (default), `auto`, `manual`, `dontAsk` or `plan`. `bypassPermissions` is not accepted, since this file can come with a cloned repo. Anything that needs approval waits until you attach and answer.
- `extraInstructions` is added to the request for handoff notes, for project-specific bookkeeping (a work log, a docs folder…).
- Missing or invalid values fall back to the defaults, so a typo never breaks the hooks.

**The scheduled task checks again before launching**, since hours may have passed. If the conversation already moved on (you resumed it yourself), it does nothing. If it fires early, it schedules itself again for the reset. Otherwise it removes itself once it has run.

**Following what happened.** Every step (script written, scheduled, launched, skipped, failed) goes to `~/.claude/context-runway/resume-log.jsonl`, and the latest plan per project to `resume/<project>-<hash>.json`. To read them:

```bash
node src/handoff.js status
```

A launched resume records its background id: `claude agents` lists it, `claude attach <id>` opens it live (to watch, or to answer permission prompts), and `claude logs <id>` shows its recent output. The next new session in that project also mentions it once.

Scheduling is Windows-only for now. On macOS and Linux, `schedule` records the failure and leaves the script. The project folder must be one you've already trusted in Claude Code, and the machine must be on when the task is due, or it runs as soon as it wakes up.

## Updating

`~/.claude/settings.json` points straight at the scripts inside this clone, so a plain `git pull` is usually enough to pick up a new version — no need to re-run the installer. The exceptions: `npm install` if `package.json` changed, or `npm run install-statusline` again if the update added a new setting. **0.2.0 did** (it registers four hooks: `UserPromptSubmit`, `PostToolUse`, `SessionStart` and `StopFailure`), so run the installer once after pulling it, then start a new Claude Code session. The [changelog](CHANGELOG.md) says which releases need this. If you have this installed on multiple machines, none of this syncs automatically — repeat on each one.

## How it works

- `src/index.js` is the entry point Claude Code invokes on stdin/stdout after each assistant message.
- `src/lib/history.js` persists a throttled, rolling log of usage snapshots to `~/.claude/context-runway/usage-history.jsonl` (pruned to 9 days), so trends can be computed across turns and sessions.
- `src/lib/projection.js` fits a simple slope to recent samples within the current rate-limit window and projects whether you'll exhaust it before it resets.
- `src/lib/linesOfCode.js` turns Claude Code's cumulative-per-session `cost.total_lines_added`/`total_lines_removed` counters into a today/this-week total across every session in the log, by diffing consecutive same-session snapshots rather than summing raw totals (which would double count).
- `src/lib/render.js` renders the progress bars, colors (green/yellow/red at 70%/90% thresholds), durations, and the lines-of-code row.
- `src/handoff.js` runs as Claude Code hooks and only reads the usage log the status line writes:
  - On each prompt (`UserPromptSubmit`) and after each tool call (`PostToolUse`) it checks this session's context usage and the account's 5-hour usage. The first time either crosses its threshold, it adds a note asking Claude to write handoff notes to `~/.claude/context-runway/handoffs/<project>-<hash>.md`. It asks once per crossing: for context, again only after usage drops back (a compaction); for the 5-hour limit, once per window.
  - On a new, cleared or compacted session (`SessionStart`, not resumes) it loads that project's notes into the session, once per version of the file, ignoring notes older than 7 days. Notes live outside your project, so they never end up in a commit.
  - When a usage limit ends a turn (`StopFailure`, matcher `rate_limit`) it writes the resume script and, in `schedule` mode, registers the task that later runs `handoff.js run-resume` (see `src/lib/resume.js`). Per-project settings are read by `src/lib/config.js`.
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
