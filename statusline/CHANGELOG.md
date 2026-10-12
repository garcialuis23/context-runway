# Changelog

## 0.2.0

Handoff notes and resuming after a usage limit. **Re-run `npm run install-statusline` once after updating**: this release registers four Claude Code hooks next to the status line.

- **Handoff notes.** When the conversation's context window reaches 80% (just before auto-compaction) or the 5-hour limit reaches 95%, Claude is asked to save notes on where the work stands: goal, done, in progress, next steps, key files, open questions. Checked on every prompt and after every tool call, so long unattended tasks are covered too. The next new session in that project starts with the notes loaded. Notes live in `~/.claude/context-runway/handoffs/`, outside your projects.
- **Resuming after a usage limit.** When a limit cuts a session off mid-task, a `StopFailure` hook leaves a one-click script that reopens the same conversation. In `schedule` mode it also registers a one-off Windows Task Scheduler task that resumes it in the background (`claude --bg --resume`) once the limit resets, and skips it if you already carried on yourself.
- **Per-project settings** in an optional `.context-runway.json` (nearest parent folder wins): resume mode (`script`, `schedule` or `off`), the permission mode for background resumes (never `bypassPermissions`), the resume prompt, and extra instructions for the notes.
- **`node src/handoff.js status`** shows what was scheduled, launched, skipped or failed. The next session in the project also mentions a background resume once.
- `npm run uninstall-statusline` removes the hooks along with the status line.

## 0.1.0

Initial release.

- Status line with context window usage and an estimate of turns left.
- 5-hour and 7-day rate-limit usage, reset countdowns, and a ⚠ burn-rate warning.
- Lines of code added/removed today and this week, across every session on the machine.
- Auto-compaction notice.
