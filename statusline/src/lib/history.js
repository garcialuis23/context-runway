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

// Appends a snapshot (subject to throttling) and returns the resulting
// in-memory history, pruned of anything older than MAX_AGE_MS.
function appendSnapshot(snapshot) {
  const kept = readHistory().filter((entry) => snapshot.ts - entry.ts < MAX_AGE_MS);

  const last = kept[kept.length - 1];
  const shouldThrottle =
    last && last.sessionId === snapshot.sessionId && snapshot.ts - last.ts < MIN_SAMPLE_INTERVAL_MS;

  if (shouldThrottle) {
    return kept;
  }

  kept.push(snapshot);
  writeHistory(kept);
  return kept;
}

module.exports = { readHistory, appendSnapshot, HISTORY_FILE, STATE_DIR };
