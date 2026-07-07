'use strict';

// A flat minimum span doesn't scale: 2 minutes of trend is meaningless
// signal for extrapolating across a 7-day window (any early blip reads as
// "explosive growth"), but is plenty for a 5-hour one. Require the span to
// cover at least this fraction of the window's total duration...
const MIN_SPAN_FRACTION = 0.02;
// ...with an absolute floor so very short windows still need *some* signal.
const MIN_SPAN_FLOOR_MS = 2 * 60 * 1000;

function slopePerMs(points, minSpanMs) {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const dt = last.ts - first.ts;
  if (dt < minSpanMs) return null;
  const dPct = last.pct - first.pct;
  if (dPct <= 0) return null;
  return dPct / dt;
}

// Projects whether a rate-limit window (five_hour / seven_day) will hit 100%
// before it resets, based on the recent trend of samples within that same
// window (grouped by its resets_at, since that's stable until the window
// rolls over). `windowDurationMs` is the window's fixed total length (5h or
// 7d) — used only to scale how much trend data we require before trusting
// a projection, not as a reset time (that's `currentResetsAt`).
function projectWindow(history, { pctKey, resetsAtKey, currentPct, currentResetsAt, nowMs, windowDurationMs }) {
  if (currentPct == null || currentResetsAt == null) return null;

  const points = history
    .filter((e) => e[resetsAtKey] === currentResetsAt && typeof e[pctKey] === 'number')
    .map((e) => ({ ts: e.ts, pct: e[pctKey] }))
    .sort((a, b) => a.ts - b.ts);

  if (points.length === 0 || points[points.length - 1].pct !== currentPct) {
    points.push({ ts: nowMs, pct: currentPct });
  }

  const minSpanMs = Math.max(MIN_SPAN_FLOOR_MS, (windowDurationMs || 0) * MIN_SPAN_FRACTION);
  const slope = slopePerMs(points, minSpanMs);
  const msToReset = currentResetsAt * 1000 - nowMs;

  if (!slope) {
    return { willExceedBeforeReset: false, msToReset, msToExhaustion: null };
  }

  const msToExhaustion = (100 - currentPct) / slope;
  return {
    willExceedBeforeReset: msToExhaustion < msToReset,
    msToReset,
    msToExhaustion,
  };
}

module.exports = { projectWindow };
