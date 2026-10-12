#!/usr/bin/env node
'use strict';

// Claude Code hook entry point for session handoff notes.
//
//   node handoff.js prompt   (UserPromptSubmit) and
//   node handoff.js tool     (PostToolUse) — when the context window or the
//                            5-hour limit is nearly used up, asks Claude to
//                            write handoff notes for this project. The tool
//                            hook covers long tasks that send no new prompts.
//   node handoff.js start    (SessionStart) — feeds the latest handoff notes
//                            for this project into a fresh session.
//   node handoff.js stopfail (StopFailure, rate_limit) — a usage limit cut the
//                            session off: leaves a resume script and, if the
//                            project opts in, schedules a resume for when the
//                            limit resets (see lib/resume.js).
//   node handoff.js run-resume <plan>  — what that scheduled task runs.
//   node handoff.js status   — prints what was scheduled, launched or skipped.
//
// The statusline is the only writer of usage-history.jsonl; this script just
// reads it, so it knows usage as of the last assistant message. Hooks must
// never break a prompt, so every failure path exits 0 with no output.

const fs = require('fs');
const path = require('path');
const { readHistory, STATE_DIR } = require('./lib/history');
const { formatDuration } = require('./lib/render');
const { loadProjectConfig } = require('./lib/config');
const { projectSlug } = require('./lib/project');
const resume = require('./lib/resume');

// Claude Code auto-compacts somewhere around 85% (see AUTO_COMPACTION_PRIOR_PCT
// in index.js), and usage data lags one turn behind, so ask early enough to
// land before that happens.
const CONTEXT_THRESHOLD_PCT = 80;
const FIVE_HOUR_THRESHOLD_PCT = 95;

// Stays under Claude Code's 10,000-character cap on hook context, leaving
// room for the framing text around the notes.
const MAX_NOTES_CHARS = 9000;

// Notes older than this are more likely to mislead than help.
const MAX_NOTES_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_TRACKED_SESSIONS = 50;

const HANDOFF_DIR = path.join(STATE_DIR, 'handoffs');
const STATE_FILE = path.join(STATE_DIR, 'handoff-state.json');

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// One notes file per project directory, readable at a glance, without ever
// writing into the project itself (where it could get committed by accident).
function handoffPathFor(cwd, baseDir = HANDOFF_DIR) {
  return path.join(baseDir, `${projectSlug(cwd)}.md`).split(path.sep).join('/');
}

function readState() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    // Missing or corrupt: start fresh.
  }
  return { requested: { ...parsed.requested }, delivered: { ...parsed.delivered } };
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

// Decides which limits (if any) should trigger a handoff request right now.
// `requested` remembers what was already asked for, so Claude is asked once
// per crossing rather than on every prompt:
//   - context: per session, re-armed once usage drops back (after compaction)
//   - 5h: once per rate-limit window, keyed by its reset time
// Returns { reasons, requested } with the updated record for this session.
function evaluateTriggers(history, sessionId, nowMs, requested = {}) {
  const reasons = [];
  const next = { ...requested };

  let ownLatest = null;
  for (const e of history) {
    if (e.sessionId === sessionId && (!ownLatest || e.ts > ownLatest.ts)) ownLatest = e;
  }

  const ctxPct = ownLatest?.contextUsedPct;
  if (typeof ctxPct === 'number') {
    if (ctxPct >= CONTEXT_THRESHOLD_PCT) {
      if (!next.context) {
        reasons.push({ kind: 'context', pct: ctxPct });
        next.context = true;
      }
    } else {
      delete next.context;
    }
  }

  // The 5-hour limit is account-wide, so any session's latest sample counts.
  let latest5h = null;
  for (const e of history) {
    if (typeof e.fiveHourPct === 'number' && (!latest5h || e.ts > latest5h.ts)) latest5h = e;
  }
  const resetsAtMs = typeof latest5h?.fiveHourResetsAt === 'number' ? latest5h.fiveHourResetsAt * 1000 : null;
  const windowStillOpen = resetsAtMs == null || resetsAtMs > nowMs;
  if (latest5h && windowStillOpen && latest5h.fiveHourPct >= FIVE_HOUR_THRESHOLD_PCT) {
    const windowKey = latest5h.fiveHourResetsAt ?? 'unknown';
    if (next.fiveHour !== windowKey) {
      reasons.push({ kind: 'fiveHour', pct: latest5h.fiveHourPct, msToReset: resetsAtMs && resetsAtMs - nowMs });
      next.fiveHour = windowKey;
    }
  }

  return { reasons, requested: next };
}

function describeReason(r) {
  if (r.kind === 'context') {
    return `this conversation's context window is ${Math.round(r.pct)}% full and will soon be compacted`;
  }
  const reset = r.msToReset != null ? `, resetting in ${formatDuration(r.msToReset)}` : '';
  return `the account's 5-hour usage limit is at ${Math.round(r.pct)}%${reset}`;
}

function describeResumeMode(mode) {
  if (mode === 'schedule') {
    return 'If the limit cuts this session off, context-runway will resume it in the background once the limit resets, working from these notes, so make "In progress" and "Next steps" precise enough to continue unattended.';
  }
  if (mode === 'script') {
    return 'If the limit cuts this session off, context-runway will leave a script that resumes it, so make "In progress" and "Next steps" precise enough to continue from.';
  }
  return null;
}

// Phrased as facts about the user's setup rather than bare commands, which
// Claude Code recommends for hook context. `config` comes from the project's
// .context-runway.json (see lib/config.js).
function buildRequestContext(reasons, notesPath, config = {}) {
  const lines = [
    `context-runway: ${reasons.map(describeReason).join(', and ')}.`,
    'The user installed context-runway so that, at this point, Claude saves handoff notes that let a future session pick up exactly where this one stops.',
    `Along with continuing the current work, write those notes to ${notesPath} (overwrite the file; create its folder if needed), using these sections:`,
    '## Goal — what the user is trying to achieve overall',
    '## Done — what has been completed so far, with key decisions and why',
    '## In progress — what was being worked on right now, and its current state',
    '## Next steps — concrete, ordered next actions',
    '## Key files — paths that matter, and what each is for',
    '## Open questions — anything unresolved or waiting on the user',
    'Keep it under 1,500 words, and mention briefly in your reply that the notes were saved.',
  ];
  if (reasons.some((r) => r.kind === 'fiveHour')) {
    const resumeLine = describeResumeMode(config.resume);
    if (resumeLine) lines.push(resumeLine);
  }
  if (config.extraInstructions) {
    lines.push(`The project's .context-runway.json also asks for this when saving handoff notes: ${config.extraInstructions}`);
  }
  return lines.join('\n');
}

function buildResumeContext(notes, notesPath, ageMs) {
  const trimmed = notes.length > MAX_NOTES_CHARS ? `${notes.slice(0, MAX_NOTES_CHARS)}\n…(truncated, full notes in the file)` : notes;
  return [
    `context-runway: an earlier session in this project left handoff notes ${formatDuration(ageMs)} ago (${notesPath}).`,
    'They describe where that work stopped, so this session can continue from there if the user wants to:',
    '',
    trimmed.trim(),
  ].join('\n');
}

function emit(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }) + '\n');
}

// Shared by the prompt and tool hooks: same thresholds, same once-per-crossing
// bookkeeping, so whichever fires first asks and the other stays quiet.
function onUsageCheck(input, nowMs, hookEventName) {
  const sessionId = input.session_id;
  if (!sessionId) return;

  const state = readState();
  const { reasons, requested } = evaluateTriggers(readHistory(), sessionId, nowMs, state.requested[sessionId]);
  // Re-insert so the most recently active sessions sit last, then keep only
  // those, so the state file doesn't grow with every session ever opened.
  delete state.requested[sessionId];
  state.requested[sessionId] = requested;
  const sessionIds = Object.keys(state.requested);
  for (const id of sessionIds.slice(0, Math.max(0, sessionIds.length - MAX_TRACKED_SESSIONS))) {
    delete state.requested[id];
  }
  writeState(state);

  if (reasons.length > 0) {
    emit(hookEventName, buildRequestContext(reasons, handoffPathFor(input.cwd), loadProjectConfig(input.cwd)));
  }
}

// Tells the next session in this project about a resume that ran in the
// background, once, so the user knows where to look.
function describeLaunchedResume(cwd) {
  const { planPath } = resume.pathsFor(cwd);
  const plan = resume.readPlan(planPath);
  if (!plan || plan.status !== 'launched' || plan.announced) return null;
  plan.announced = true;
  resume.writePlan(planPath, plan);
  return [
    `context-runway: after the usage limit reset, session ${plan.sessionId} was resumed in the background at ${new Date(plan.launchedAt).toLocaleString()} (background id ${plan.bgId}).`,
    `The user can follow it with \`claude attach ${plan.bgId}\` or \`claude logs ${plan.bgId}\`, and see the full history with \`node "${__filename.split(path.sep).join('/')}" status\`. Mention this to the user.`,
  ].join('\n');
}

// Delivers each version of the notes once per project, so they show up in
// the next session after being written instead of in every session forever.
function readFreshNotes(cwd, nowMs) {
  const notesPath = handoffPathFor(cwd);
  let stat;
  try {
    stat = fs.statSync(notesPath);
  } catch {
    return null;
  }
  const ageMs = nowMs - stat.mtimeMs;
  if (ageMs > MAX_NOTES_AGE_MS) return null;

  const state = readState();
  if (state.delivered[notesPath] >= stat.mtimeMs) return null;

  const notes = fs.readFileSync(notesPath, 'utf8');
  if (!notes.trim()) return null;

  state.delivered[notesPath] = stat.mtimeMs;
  writeState(state);
  return buildResumeContext(notes, notesPath, ageMs);
}

function onStart(input, nowMs) {
  if (input.source === 'resume') return; // the conversation is already there

  const parts = [describeLaunchedResume(input.cwd), readFreshNotes(input.cwd, nowMs)].filter(Boolean);
  if (parts.length > 0) emit('SessionStart', parts.join('\n\n'));
}

// StopFailure is fire-and-forget (Claude Code ignores its output), so this
// only leaves things behind: a resume script, maybe a scheduled task, and a
// log entry either way.
function onStopFailure(input, nowMs) {
  if (input.error !== 'rate_limit' || !input.session_id || !input.cwd) return;

  const config = loadProjectConfig(input.cwd);
  if (config.resume === 'off') return;

  const history = readHistory();
  const { planPath, scriptPath, taskName } = resume.pathsFor(input.cwd);
  const plan = {
    sessionId: input.session_id,
    cwd: input.cwd,
    createdAt: nowMs,
    mode: config.resume,
    runAt: resume.pickResumeAt(history, nowMs),
    permissionMode: config.permissionMode,
    prompt: config.resumePrompt,
    contextTokens: resume.latestContextTokens(history, input.session_id),
    scriptPath,
    taskName,
    status: 'script',
  };

  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, resume.buildScript(plan), { mode: 0o755 });

  if (config.resume === 'schedule') {
    if (plan.runAt == null) {
      plan.status = 'schedule-failed';
      plan.error = 'reset time unknown (no rate-limit data from the status line yet)';
    } else {
      const result = resume.scheduleTask({ taskName, runAtMs: plan.runAt, planPath });
      plan.status = result.ok ? 'scheduled' : 'schedule-failed';
      if (!result.ok) plan.error = result.error;
    }
  }

  resume.writePlan(planPath, plan);
  resume.appendLog({
    ts: nowMs,
    event: plan.status,
    sessionId: plan.sessionId,
    cwd: plan.cwd,
    runAt: plan.runAt,
    scriptPath,
    ...(plan.error && { error: plan.error }),
  });
}

// Run by the scheduled task. Re-checks everything, because hours may have
// passed: the user may have resumed by hand, or the plan may be stale.
function runResume(planPath, nowMs) {
  const plan = resume.readPlan(planPath);
  if (!plan || plan.status !== 'scheduled') return;

  const log = (event, extra = {}) =>
    resume.appendLog({ ts: nowMs, event, sessionId: plan.sessionId, cwd: plan.cwd, ...extra });

  if (plan.runAt != null && nowMs < plan.runAt - resume.EARLY_TOLERANCE_MS) {
    log('skipped', { reason: 'task ran before the limit reset; left scheduled' });
    return;
  }

  resume.unscheduleTask(plan.taskName);

  if (resume.sessionMovedOn(readHistory(), plan)) {
    Object.assign(plan, { status: 'skipped', skippedAt: nowMs, reason: 'the session already continued' });
    resume.writePlan(planPath, plan);
    log('skipped', { reason: plan.reason });
    return;
  }

  const result = resume.launchClaude(plan);
  if (result.ok) {
    Object.assign(plan, { status: 'launched', launchedAt: nowMs, bgId: result.bgId });
    log('launched', { bgId: result.bgId });
  } else {
    Object.assign(plan, { status: 'launch-failed', error: result.error });
    log('launch-failed', { error: result.error });
  }
  resume.writePlan(planPath, plan);
}

const STATUS_HINTS = {
  script: (e) => `run ${e.scriptPath} to resume`,
  scheduled: (e) => `will resume at ${new Date(e.runAt).toLocaleString()}`,
  'schedule-failed': (e) => `could not schedule (${e.error}); run ${e.scriptPath} instead`,
  launched: (e) => `follow it: claude attach ${e.bgId}  |  claude logs ${e.bgId}`,
  'launch-failed': (e) => `claude did not start (${e.error})`,
  skipped: (e) => e.reason,
};

function formatStatus(entries) {
  if (entries.length === 0) return 'context-runway: no resumes recorded yet.';
  return [
    'context-runway resume log (newest last):',
    ...entries.map((e) => {
      const hint = STATUS_HINTS[e.event]?.(e) ?? '';
      return `  ${new Date(e.ts).toLocaleString()}  ${e.event.padEnd(15)} ${path.basename(e.cwd || '')}  ${hint}`;
    }),
  ].join('\n');
}

async function main() {
  const mode = process.argv[2];
  // Not hooks: run by hand or by Task Scheduler, with nothing on stdin.
  if (mode === 'status') {
    console.log(formatStatus(resume.readLog().slice(-20)));
    return;
  }
  try {
    if (mode === 'run-resume') {
      runResume(process.argv[3], Date.now());
      return;
    }
    const input = JSON.parse(await readStdin());
    if (mode === 'prompt') onUsageCheck(input, Date.now(), 'UserPromptSubmit');
    else if (mode === 'tool') onUsageCheck(input, Date.now(), 'PostToolUse');
    else if (mode === 'start') onStart(input, Date.now());
    else if (mode === 'stopfail') onStopFailure(input, Date.now());
  } catch {
    // Never let a hook failure get in the way of the user's prompt.
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateTriggers,
  buildRequestContext,
  buildResumeContext,
  handoffPathFor,
  formatStatus,
  CONTEXT_THRESHOLD_PCT,
  FIVE_HOUR_THRESHOLD_PCT,
};
