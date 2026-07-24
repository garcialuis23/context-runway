'use strict';

// Claude Code's statusline payload reports cost.total_lines_added/removed as
// counters that only grow *within one session* (reset to 0 when /clear
// starts a new one). Summing every snapshot's total would double count, so
// instead we take the delta between consecutive snapshots of the same
// session and attribute each delta to the timestamp it happened at — the
// same approach index.js's averageTurnDelta uses for context tokens.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// A session's very first recorded snapshot has no prior sample to diff
// against, so its whole value counts as one delta at that timestamp — we
// weren't tracking this session before that point, not tracking-since-zero.
function deltasForSession(points, field) {
  const deltas = [];
  let prev = null;
  for (const point of points) {
    const cur = point[field];
    if (typeof cur !== 'number') continue;
    const delta = typeof prev === 'number' ? cur - prev : cur;
    // Both counters only grow within a session; a negative delta means the
    // counter went backwards (process restart or similar anomaly) rather
    // than lines actually being "un-added", so skip it instead of letting
    // it drag a day's total negative.
    if (delta > 0) deltas.push({ ts: point.ts, delta });
    prev = cur;
  }
  return deltas;
}

function sumSince(deltas, sinceMs) {
  return deltas.filter((d) => d.ts >= sinceMs).reduce((sum, d) => sum + d.delta, 0);
}

// Summarizes lines-of-code changes across every session in `history` (i.e.
// every Claude Code chat on this machine), bucketed into "today" (since
// local midnight) and "this week" (rolling 7 days, matching the 7-day
// rate-limit window elsewhere in this app) so a long-running session that
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

module.exports = { summarizeLinesOfCode, DAY_MS, WEEK_MS };
