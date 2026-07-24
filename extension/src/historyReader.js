'use strict';

// Reads the same usage-history.jsonl file the context-runway statusline
// script (../../statusline) writes to. This extension is a viewer only —
// it never appends to the file itself, so there's a single writer.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Overridable so tests never read or write the user's real history file
// (mirrors statusline/src/lib/history.js, the sole writer of this file).
const STATE_DIR = process.env.CONTEXT_RUNWAY_STATE_DIR || path.join(os.homedir(), '.claude', 'context-runway');
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

// Mirrors statusline/src/lib/linesOfCode.js: cost.total_lines_added/removed
// are cumulative *within a single session*, so summing raw totals across
// sessions would double count. Instead we diff consecutive snapshots of the
// same session and attribute each delta to the timestamp it happened at.
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

function deltasForSession(points, field) {
  const deltas = [];
  let prev = null;
  for (const point of points) {
    const cur = point[field];
    if (typeof cur !== 'number') continue;
    const delta = typeof prev === 'number' ? cur - prev : cur;
    // Both counters only grow within a session; a negative delta means the
    // counter went backwards (process restart or similar) rather than lines
    // being "un-added", so skip it instead of dragging a bucket negative.
    if (delta > 0) deltas.push({ ts: point.ts, delta });
    prev = cur;
  }
  return deltas;
}

function sumSince(deltas, sinceMs) {
  return deltas.filter((d) => d.ts >= sinceMs).reduce((sum, d) => sum + d.delta, 0);
}

// Summarizes lines-of-code changes across every session in `history` (every
// Claude Code chat on this machine), bucketed into "today" (since local
// midnight) and "this week" (rolling 7 days), so a long-running session that
// spans the boundary still gets split correctly between buckets.
function summarizeLinesOfCode(history, nowMs) {
  const bySession = new Map();
  for (const entry of history) {
    if (typeof entry.linesAdded !== 'number' && typeof entry.linesRemoved !== 'number') continue;
    if (!bySession.has(entry.sessionId)) bySession.set(entry.sessionId, []);
    bySession.get(entry.sessionId).push(entry);
  }

  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const todaySinceMs = midnight.getTime();
  const weekSinceMs = nowMs - WEEK_MS;

  const summary = {
    today: { added: 0, removed: 0 },
    week: { added: 0, removed: 0 },
  };

  for (const points of bySession.values()) {
    points.sort((a, b) => a.ts - b.ts);
    const addedDeltas = deltasForSession(points, 'linesAdded');
    const removedDeltas = deltasForSession(points, 'linesRemoved');

    summary.today.added += sumSince(addedDeltas, todaySinceMs);
    summary.today.removed += sumSince(removedDeltas, todaySinceMs);
    summary.week.added += sumSince(addedDeltas, weekSinceMs);
    summary.week.removed += sumSince(removedDeltas, weekSinceMs);
  }

  return summary;
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
  summarizeLinesOfCode,
  formatTokenCount,
  formatAgo,
  HISTORY_FILE,
  STATE_DIR,
};
