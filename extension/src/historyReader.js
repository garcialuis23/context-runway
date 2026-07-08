'use strict';

// Reads the same usage-history.jsonl file the context-runway statusline
// script (../../statusline) writes to. This extension is a viewer only —
// it never appends to the file itself, so there's a single writer.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_DIR = path.join(os.homedir(), '.claude', 'context-runway');
const HISTORY_FILE = path.join(STATE_DIR, 'usage-history.jsonl');

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

// Scans backward for the most recent entry that actually has `field` set,
// regardless of which session wrote it. Using history[history.length - 1]
// directly is wrong here: with multiple concurrent sessions, the very last
// entry written might come from a brand-new session that hasn't gotten its
// first API response yet (rate_limits still null), which would otherwise
// hide perfectly good, more recent rate-limit data from an older session.
function mostRecentWithField(history, field) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (typeof history[i][field] === 'number') return history[i];
  }
  return null;
}

// Prefers a /rename'd session_name; falls back to directory + a short id
// fragment, since two chats in the same project both show the same dir.
function sessionLabel(entry) {
  if (entry.sessionName) return entry.sessionName;
  const shortId = entry.sessionId ? entry.sessionId.slice(0, 6) : '??????';
  return entry.dir ? `${entry.dir} · #${shortId}` : `#${shortId}`;
}

// Same fallback order as statusline/src/lib/render.js.
function formatTokenCount(n) {
  if (n == null) return null;
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

// Same fallback order as statusline/src/lib/render.js.
function formatAgo(ms) {
  if (ms < 60 * 1000) return 'just now';
  const totalMin = Math.round(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d${hours}h ago`;
  if (hours > 0) return `${hours}h${mins}m ago`;
  return `${mins}m ago`;
}

module.exports = {
  readHistory,
  mostRecentWithField,
  sessionLabel,
  formatTokenCount,
  formatAgo,
  HISTORY_FILE,
  STATE_DIR,
};
