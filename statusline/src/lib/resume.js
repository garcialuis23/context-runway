'use strict';

// Picking up a session after a usage limit cut it off (see handoff.js):
//
//   - script:   writes a one-click script that resumes the session, for the
//               user to run whenever they like.
//   - schedule: also registers a one-off OS task for when the limit resets,
//               which resumes the session in the background (`claude --bg`),
//               where `claude agents` / `attach` / `logs` can follow it.
//
// Every step is appended to resume-log.jsonl, and the latest plan per project
// is kept as JSON, so `node handoff.js status` can show what happened.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { STATE_DIR } = require('./history');
const { projectSlug } = require('./project');

const RESUME_DIR = path.join(STATE_DIR, 'resume');
const RESUME_LOG = path.join(STATE_DIR, 'resume-log.jsonl');
const HANDOFF_SCRIPT = path.resolve(__dirname, '..', 'handoff.js');

// Scheduled tasks live in their own folder in Task Scheduler.
const TASK_FOLDER = '\\context-runway\\';

// A window this full counts as the one that cut the session off.
const EXHAUSTED_PCT = 90;

// Small delay after the reset, so the first request doesn't race it.
const RESET_GRACE_MS = 2 * 60 * 1000;

// A task that fires this early (clock changes, manual "Run") does nothing.
const EARLY_TOLERANCE_MS = 60 * 1000;

// How long after the hook the cut-off turn's samples may still arrive.
const SETTLE_MS = 3 * 60 * 1000;

const MAX_LOG_LINES = 200;

function pathsFor(cwd, baseDir = RESUME_DIR) {
  const slug = projectSlug(cwd);
  const toPosix = (p) => p.split(path.sep).join('/');
  return {
    slug,
    planPath: toPosix(path.join(baseDir, `${slug}.json`)),
    scriptPath: toPosix(path.join(baseDir, `${slug}${process.platform === 'win32' ? '.cmd' : '.sh'}`)),
    taskName: `resume-${slug}`,
  };
}

// When it's worth trying again: the latest reset among the limits that are
// (nearly) used up, since all of them have to reset. Falls back to the 5-hour
// reset when the samples don't show which limit was hit. Null if unknown.
function pickResumeAt(history, nowMs) {
  let latest = null;
  for (const e of history) {
    if ((typeof e.fiveHourPct === 'number' || typeof e.sevenDayPct === 'number') && (!latest || e.ts > latest.ts)) {
      latest = e;
    }
  }
  if (!latest) return null;

  const windows = [
    { kind: 'fiveHour', pct: latest.fiveHourPct, resetsAt: latest.fiveHourResetsAt },
    { kind: 'sevenDay', pct: latest.sevenDayPct, resetsAt: latest.sevenDayResetsAt },
  ].filter((w) => typeof w.resetsAt === 'number' && w.resetsAt * 1000 > nowMs);

  const exhausted = windows.filter((w) => typeof w.pct === 'number' && w.pct >= EXHAUSTED_PCT);
  const fiveHour = windows.find((w) => w.kind === 'fiveHour');
  const pool = exhausted.length > 0 ? exhausted : fiveHour ? [fiveHour] : [];
  if (pool.length === 0) return null;
  return Math.max(...pool.map((w) => w.resetsAt * 1000)) + RESET_GRACE_MS;
}

function latestContextTokens(history, sessionId) {
  let own = null;
  for (const e of history) {
    if (e.sessionId === sessionId && typeof e.contextTokens === 'number' && (!own || e.ts > own.ts)) own = e;
  }
  return own ? own.contextTokens : null;
}

// The status line keeps sampling an idle session every minute, so a new
// sample alone means nothing; a changed token count means the conversation
// moved on (someone already resumed it, or it was compacted). It also
// throttles samples, so the final count of the turn the limit cut off often
// lands a little after the hook ran: samples within SETTLE_MS only update the
// baseline, and only a change after that counts.
function sessionMovedOn(history, plan) {
  if (typeof plan.contextTokens !== 'number') return false;
  const later = history
    .filter((e) => e.sessionId === plan.sessionId && e.ts > plan.createdAt && typeof e.contextTokens === 'number')
    .sort((a, b) => a.ts - b.ts);
  let baseline = plan.contextTokens;
  for (const e of later) {
    if (e.ts <= plan.createdAt + SETTLE_MS) baseline = e.contextTokens;
    else if (e.contextTokens !== baseline) return true;
  }
  return false;
}

// Arguments are quoted for the platform's shell. On Windows the characters
// cmd.exe would still interpret inside quotes are dropped from the prompt,
// which is plain prose anyway.
function quoteArg(value, platform = process.platform) {
  const s = String(value);
  if (platform === 'win32') return `"${s.replace(/["%!^\r\n]/g, ' ')}"`;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// The manual script resumes the session interactively, so the user watches
// it (and answers permission prompts) as usual.
function buildScript({ cwd, sessionId, prompt }, platform = process.platform) {
  const q = (v) => quoteArg(v, platform);
  if (platform === 'win32') {
    // Inside a .cmd file % must be doubled rather than dropped, or a folder
    // name containing it would point somewhere else. Paths can't contain ".
    return [
      '@echo off',
      'rem Written by context-runway: resumes the Claude Code session a usage limit interrupted.',
      `cd /d "${String(cwd).replace(/%/g, '%%')}"`,
      `claude --resume ${q(sessionId)} ${q(prompt)}`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    '# Written by context-runway: resumes the Claude Code session a usage limit interrupted.',
    `cd ${q(cwd)} || exit 1`,
    `exec claude --resume ${q(sessionId)} ${q(prompt)}`,
    '',
  ].join('\n');
}

function buildLaunchArgs(plan) {
  return ['--bg', '--resume', plan.sessionId, '--permission-mode', plan.permissionMode, plan.prompt];
}

function readPlan(planPath) {
  try {
    return JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch {
    return null;
  }
}

function writePlan(planPath, plan) {
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
}

function appendLog(entry, logPath = RESUME_LOG) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let lines = [];
  try {
    lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    // First entry.
  }
  lines.push(JSON.stringify(entry));
  fs.writeFileSync(logPath, lines.slice(-MAX_LOG_LINES).join('\n') + '\n');
}

function readLog(logPath = RESUME_LOG) {
  try {
    return fs
      .readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function runPowerShell(script) {
  // -EncodedCommand sidesteps every quoting rule between node, cmd and PowerShell.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Set in tests: record (un)scheduling requests in this file instead of
// touching the real Task Scheduler.
function dryRun(entry) {
  const file = process.env.CONTEXT_RUNWAY_SCHEDULER_DRYRUN;
  if (!file) return false;
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return true;
}

// Registers a one-off Task Scheduler task that runs `handoff.js run-resume`
// at runAtMs. StartWhenAvailable makes it run on wake if the machine was
// asleep at that time. Windows only for now.
function scheduleTask({ taskName, runAtMs, planPath }) {
  if (dryRun({ action: 'schedule', taskName, runAtMs, planPath })) return { ok: true };
  if (process.platform !== 'win32') {
    return { ok: false, error: 'scheduled resumes are only supported on Windows so far' };
  }
  const args = `${quoteArg(HANDOFF_SCRIPT, 'win32')} run-resume ${quoteArg(planPath, 'win32')}`;
  const result = runPowerShell(
    [
      `$action = New-ScheduledTaskAction -Execute ${psQuote(process.execPath)} -Argument ${psQuote(args)}`,
      `$trigger = New-ScheduledTaskTrigger -Once -At ([DateTimeOffset]::FromUnixTimeMilliseconds(${Math.round(runAtMs)}).LocalDateTime)`,
      '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
      `Register-ScheduledTask -TaskName ${psQuote(taskName)} -TaskPath ${psQuote(TASK_FOLDER)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    ].join('; ')
  );
  if (result.status === 0) return { ok: true };
  return { ok: false, error: (result.stderr || result.error?.message || 'unknown error').trim().slice(0, 300) };
}

function unscheduleTask(taskName) {
  if (dryRun({ action: 'unschedule', taskName }) || process.platform !== 'win32') return;
  runPowerShell(
    `Unregister-ScheduledTask -TaskName ${psQuote(taskName)} -TaskPath ${psQuote(TASK_FOLDER)} -Confirm:$false -ErrorAction SilentlyContinue`
  );
}

// Starts the background session. CONTEXT_RUNWAY_CLAUDE_BIN overrides the
// executable (a .js path runs under node, which is what the tests use).
function launchClaude(plan) {
  const bin = process.env.CONTEXT_RUNWAY_CLAUDE_BIN || 'claude';
  const args = buildLaunchArgs(plan);
  const opts = { cwd: plan.cwd, encoding: 'utf8', timeout: 60000, windowsHide: true };
  const result = bin.endsWith('.js')
    ? spawnSync(process.execPath, [bin, ...args], opts)
    : process.platform === 'win32'
      ? spawnSync(`${bin} ${args.map((a) => quoteArg(a, 'win32')).join(' ')}`, { ...opts, shell: true })
      : spawnSync(bin, args, opts);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  // "backgrounded · 7c5dcf5d · <name>". A clean exit means the session
  // started even if the id can't be read (say, a console mangling the ·).
  const bgId = output.match(/backgrounded\W+([0-9a-f]{6,})/i)?.[1] ?? null;
  if (result.status === 0) return { ok: true, bgId };
  return { ok: false, error: (output || result.error?.message || 'no output').trim().slice(0, 300) };
}

module.exports = {
  pathsFor,
  pickResumeAt,
  latestContextTokens,
  sessionMovedOn,
  quoteArg,
  buildScript,
  buildLaunchArgs,
  readPlan,
  writePlan,
  appendLog,
  readLog,
  scheduleTask,
  unscheduleTask,
  launchClaude,
  RESUME_DIR,
  RESUME_LOG,
  RESET_GRACE_MS,
  EARLY_TOLERANCE_MS,
  SETTLE_MS,
};
