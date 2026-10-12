#!/usr/bin/env node
'use strict';

// Claude Code hook entry point for session handoff notes.
//
//   node handoff.js prompt   (UserPromptSubmit) — when the context window or
//                            the 5-hour limit is nearly used up, asks Claude to
//                            write handoff notes for this project.
//   node handoff.js start    (SessionStart) — feeds the latest handoff notes
//                            for this project into a fresh session.
//
// The statusline is the only writer of usage-history.jsonl; this script just
// reads it, so it knows usage as of the last assistant message. Hooks must
// never break a prompt, so every failure path exits 0 with no output.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { readHistory, STATE_DIR } = require('./lib/history');
const { formatDuration } = require('./lib/render');

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

const HANDOFF_DIR =path.join(STATE_DIR, 'handoffs');
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
  const normalized = path.resolve(cwd || '.').replace(/\\/g, '/').toLowerCase();
  const name = path.basename(normalized).replace(/[^a-z0-9._-]/g, '_') || 'root';
  const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return path.join(baseDir, `${name}-${hash}.md`).split(path.sep).join('/');
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

// Phrased as facts about the user's setup rather than bare commands, which
// Claude Code recommends for hook context.
function buildRequestContext(reasons, notesPath) {
  return [
    `context-runway: ${reasons.map(describeReason).join(', and ')}.`,
    'The user installed context-runway so that, at this point, Claude saves handoff notes that let a future session pick up exactly where this one stops.',
    `Along with answering this message, write those notes to ${notesPath} (overwrite the file; create its folder if needed), using these sections:`,
    '## Goal — what the user is trying to achieve overall',
    '## Done — what has been completed so far, with key decisions and why',
    '## In progress — what was being worked on right now, and its current state',
    '## Next steps — concrete, ordered next actions',
    '## Key files — paths that matter, and what each is for',
    '## Open questions — anything unresolved or waiting on the user',
    'Keep it under 1,500 words, and mention briefly in your reply that the notes were saved.',
  ].join('\n');
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

function onPrompt(input, nowMs) {
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

  if (reasons.length > 0) emit('UserPromptSubmit', buildRequestContext(reasons, handoffPathFor(input.cwd)));
}

// Delivers each version of the notes once per project, so they show up in
// the next session after being written instead of in every session forever.
function onStart(input, nowMs) {
  if (input.source === 'resume') return; // the conversation is already there

  const notesPath = handoffPathFor(input.cwd);
  let stat;
  try {
    stat = fs.statSync(notesPath);
  } catch {
    return;
  }
  const ageMs = nowMs - stat.mtimeMs;
  if (ageMs > MAX_NOTES_AGE_MS) return;

  const state = readState();
  if (state.delivered[notesPath] >= stat.mtimeMs) return;

  const notes = fs.readFileSync(notesPath, 'utf8');
  if (!notes.trim()) return;

  state.delivered[notesPath] = stat.mtimeMs;
  writeState(state);
  emit('SessionStart', buildResumeContext(notes, notesPath, ageMs));
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const mode = process.argv[2];
    if (mode === 'prompt') onPrompt(input, Date.now());
    else if (mode === 'start') onStart(input, Date.now());
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
  CONTEXT_THRESHOLD_PCT,
  FIVE_HOUR_THRESHOLD_PCT,
};
