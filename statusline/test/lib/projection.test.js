'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectWindow } = require('../../src/lib/projection');

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const BASE_OPTS = {
  pctKey: 'fiveHourPct',
  resetsAtKey: 'fiveHourResetsAt',
  windowDurationMs: FIVE_HOUR_MS,
};
// FIVE_HOUR_MS * MIN_SPAN_FRACTION (0.02) = 360_000ms, which beats the
// 2-minute floor, so that's the span points need to cover for this window.
const MIN_SPAN_MS = FIVE_HOUR_MS * 0.02;

test('returns null when currentPct is null', () => {
  const result = projectWindow([], { ...BASE_OPTS, currentPct: null, currentResetsAt: 100, nowMs: 0 });
  assert.equal(result, null);
});

test('returns null when currentResetsAt is null', () => {
  const result = projectWindow([], { ...BASE_OPTS, currentPct: 50, currentResetsAt: null, nowMs: 0 });
  assert.equal(result, null);
});

test('with no history and no trend, reports msToReset but no exhaustion projection', () => {
  const resetsAt = 1000; // seconds
  const nowMs = 0;
  const result = projectWindow([], { ...BASE_OPTS, currentPct: 50, currentResetsAt: resetsAt, nowMs });

  assert.equal(result.willExceedBeforeReset, false);
  assert.equal(result.msToExhaustion, null);
  assert.equal(result.msToReset, resetsAt * 1000 - nowMs);
});

test('ignores points from a different rate-limit window (different resetsAt)', () => {
  const history = [
    { ts: 0, fiveHourPct: 10, fiveHourResetsAt: 999 }, // stale window, must be excluded
    { ts: MIN_SPAN_MS, fiveHourPct: 20, fiveHourResetsAt: 999 },
  ];
  const result = projectWindow(history, {
    ...BASE_OPTS,
    currentPct: 50,
    currentResetsAt: 1000,
    nowMs: MIN_SPAN_MS,
  });

  // No same-window history points, so only the synthetic "now" point exists
  // and slope can't be computed.
  assert.equal(result.msToExhaustion, null);
});

test('a shrinking/flat percentage (dPct <= 0) is not treated as a trend', () => {
  const resetsAt = 100_000; // seconds, far in the future
  const history = [
    { ts: 0, fiveHourPct: 40, fiveHourResetsAt: resetsAt },
    { ts: MIN_SPAN_MS, fiveHourPct: 40, fiveHourResetsAt: resetsAt }, // flat
  ];
  const result = projectWindow(history, {
    ...BASE_OPTS,
    currentPct: 40,
    currentResetsAt: resetsAt,
    nowMs: MIN_SPAN_MS,
  });

  assert.equal(result.msToExhaustion, null);
  assert.equal(result.willExceedBeforeReset, false);
});

test('a span shorter than the minimum required is not trusted', () => {
  const resetsAt = 100_000;
  const history = [
    { ts: 0, fiveHourPct: 10, fiveHourResetsAt: resetsAt },
    { ts: MIN_SPAN_MS - 1000, fiveHourPct: 90, fiveHourResetsAt: resetsAt }, // huge jump, but too fast to trust
  ];
  const result = projectWindow(history, {
    ...BASE_OPTS,
    currentPct: 90,
    currentResetsAt: resetsAt,
    nowMs: MIN_SPAN_MS - 1000,
  });

  assert.equal(result.msToExhaustion, null);
});

test('projects exhaustion before reset when the trend is steep enough', () => {
  const resetsAtSec = 10_000_000; // seconds — resets far in the future
  const nowMs = MIN_SPAN_MS;
  const history = [
    { ts: 0, fiveHourPct: 0, fiveHourResetsAt: resetsAtSec },
    { ts: nowMs, fiveHourPct: 50, fiveHourResetsAt: resetsAtSec }, // 50% burned in MIN_SPAN_MS
  ];
  const result = projectWindow(history, {
    ...BASE_OPTS,
    currentPct: 50,
    currentResetsAt: resetsAtSec,
    nowMs,
  });

  // At this burn rate, exhaustion happens in another MIN_SPAN_MS, which is
  // far sooner than the (huge) time left until reset.
  assert.equal(result.willExceedBeforeReset, true);
  assert.ok(result.msToExhaustion > 0);
  assert.ok(result.msToExhaustion < result.msToReset);
});

test('does not project exceeding the window when the trend is shallow', () => {
  const resetsAtSec = Math.round((MIN_SPAN_MS + 1000) / 1000); // resets just after "now"
  const nowMs = MIN_SPAN_MS;
  const history = [
    { ts: 0, fiveHourPct: 10, fiveHourResetsAt: resetsAtSec },
    { ts: nowMs, fiveHourPct: 11, fiveHourResetsAt: resetsAtSec }, // barely moved
  ];
  const result = projectWindow(history, {
    ...BASE_OPTS,
    currentPct: 11,
    currentResetsAt: resetsAtSec,
    nowMs,
  });

  assert.equal(result.willExceedBeforeReset, false);
});

test('appends the current point when history does not already end at currentPct', () => {
  const resetsAtSec = 10_000_000;
  const nowMs = MIN_SPAN_MS;
  // Only one history sample; the function must synthesize a second point at
  // {nowMs, currentPct} to have any span to compute a slope from.
  const history = [{ ts: 0, fiveHourPct: 0, fiveHourResetsAt: resetsAtSec }];
  const result = projectWindow(history, {
    ...BASE_OPTS,
    currentPct: 50,
    currentResetsAt: resetsAtSec,
    nowMs,
  });

  assert.ok(result.msToExhaustion != null);
});
