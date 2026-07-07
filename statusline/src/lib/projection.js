'use strict';

// Minimum time span required between the earliest and latest sample before
// trusting a slope. Prevents noisy projections from two nearly-simultaneous
// snapshots.
const MIN_SPAN_MS = 2 * 60 * 1000;

function slopePerMs(points) {
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const dt = last.ts - first.ts;
  if (dt < MIN_SPAN_MS) return null;
  const dPct = last.pct - first.pct;
  if (dPct <= 0) return null;
  return dPct / dt;
}

// Projects whether a rate-limit window (five_hour / seven_day) will hit 100%
// before it resets, based on the recent trend of samples within that same
// window (grouped by its resets_at, since that's stable until the window
// rolls over).
function projectWindow(history, { pctKey, resetsAtKey, currentPct, currentResetsAt, nowMs }) {
  if (currentPct == null || currentResetsAt == null) return null;

  const points = history
    .filter((e) => e[resetsAtKey] === currentResetsAt && typeof e[pctKey] === 'number')
    .map((e) => ({ ts: e.ts, pct: e[pctKey] }))
    .sort((a, b) => a.ts - b.ts);

  if (points.length === 0 || points[points.length - 1].pct !== currentPct) {
    points.push({ ts: nowMs, pct: currentPct });
  }

  const slope = slopePerMs(points);
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
