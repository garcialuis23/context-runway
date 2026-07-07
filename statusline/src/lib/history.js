'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Overridable so tests (see test/run.js) never write to the user's real
// history file.
const STATE_DIR = process.env.CONTEXT_RUNWAY_STATE_DIR || path.join(os.homedir(), '.claude', 'context-runway');
const HISTORY_FILE = path.join(STATE_DIR, 'usage-history.jsonl');

// Covers the 7-day rate-limit window with a couple of days of buffer.
const MAX_AGE_MS = 9 * 24 * 60 * 60 * 1000;

// Statusline runs after every assistant message; throttle writes so long
// agentic sessions don't blow up the log file.
const MIN_SAMPLE_INTERVAL_MS = 20 * 1000;

function readHistory() {
  let raw;
  try {
    raw = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch {
    return [];
  }

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeHistory(entries) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_FILE, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// Chance per call (once stale entries exist) of doing a full prune-and-rewrite.
// Kept low because every full rewrite is a read-modify-write race if another
// concurrent Claude Code session appends in between; appendFileSync below is
// the safe common path.
const PRUNE_CHANCE = 0.05;

// Appends a snapshot (subject to throttling) and returns the resulting
// in-memory history, pruned of anything older than MAX_AGE_MS.
//
// This is append-only on the common path (fs.appendFileSync, safe even with
// multiple concurrent Claude Code sessions writing at once — unlike a full
// read-modify-write, which can silently drop another session's sample if two
// processes write around the same time). Pruning old entries requires a full
// rewrite, so it only happens occasionally, once stale entries actually exist.
function appendSnapshot(snapshot) {
  const existing = readHistory();
  const last = existing[existing.length - 1];
  const shouldThrottle =
    last && last.sessionId === snapshot.sessionId && snapshot.ts - last.ts < MIN_SAMPLE_INTERVAL_MS;

  if (shouldThrottle) {
    return existing;
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(snapshot) + '\n');
  const kept = existing.concat([snapshot]);

  const hasStale = kept.some((entry) => snapshot.ts - entry.ts >= MAX_AGE_MS);
  if (hasStale && Math.random() < PRUNE_CHANCE) {
    const pruned = kept.filter((entry) => snapshot.ts - entry.ts < MAX_AGE_MS);
    writeHistory(pruned);
    return pruned;
  }

  return kept;
}

module.exports = { readHistory, appendSnapshot, HISTORY_FILE, STATE_DIR };
