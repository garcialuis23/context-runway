'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeLinesOfCode, DAY_MS, WEEK_MS } = require('../../src/lib/linesOfCode');

test('summarizeLinesOfCode', async (t) => {
  await t.test('returns all zeros for empty history', () => {
    const summary = summarizeLinesOfCode([], Date.now());
    assert.deepEqual(summary, { today: { added: 0, removed: 0 }, week: { added: 0, removed: 0 } });
  });

  await t.test('ignores entries without linesAdded/linesRemoved', () => {
    const history = [{ ts: 1, sessionId: 's1', contextUsedPct: 50 }];
    const summary = summarizeLinesOfCode(history, Date.now());
    assert.equal(summary.today.added, 0);
    assert.equal(summary.week.added, 0);
  });

  await t.test('counts a session\'s first-ever sample in full', () => {
    const now = Date.now();
    const history = [{ ts: now, sessionId: 's1', linesAdded: 42, linesRemoved: 3 }];
    const summary = summarizeLinesOfCode(history, now);
    assert.equal(summary.today.added, 42);
    assert.equal(summary.today.removed, 3);
  });

  await t.test('sums deltas between consecutive snapshots of the same session', () => {
    const now = Date.now();
    const history = [
      { ts: now - 3000, sessionId: 's1', linesAdded: 10, linesRemoved: 0 },
      { ts: now - 2000, sessionId: 's1', linesAdded: 25, linesRemoved: 5 }, // +15/+5
      { ts: now - 1000, sessionId: 's1', linesAdded: 30, linesRemoved: 5 }, // +5/+0
    ];
    const summary = summarizeLinesOfCode(history, now);
    // 10 (first sample) + 15 + 5 = 30 added; 0 + 5 + 0 = 5 removed
    assert.equal(summary.today.added, 30);
    assert.equal(summary.today.removed, 5);
  });

  await t.test('skips a negative delta instead of subtracting it', () => {
    const now = Date.now();
    const history = [
      { ts: now - 2000, sessionId: 's1', linesAdded: 50 },
      { ts: now - 1000, sessionId: 's1', linesAdded: 10 }, // counter went backwards
    ];
    const summary = summarizeLinesOfCode(history, now);
    // 50 (first sample) counted; the backwards jump to 10 is skipped, not -40
    assert.equal(summary.today.added, 50);
  });

  await t.test('does not double count across multiple sessions', () => {
    const now = Date.now();
    const history = [
      { ts: now, sessionId: 's1', linesAdded: 10 },
      { ts: now, sessionId: 's2', linesAdded: 20 },
    ];
    const summary = summarizeLinesOfCode(history, now);
    assert.equal(summary.today.added, 30);
  });

  await t.test('excludes deltas from before today but includes them in the week', () => {
    const now = Date.now();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const yesterday = midnight.getTime() - 60 * 1000; // just before local midnight

    const history = [
      { ts: yesterday, sessionId: 's1', linesAdded: 100 },
      { ts: now, sessionId: 's1', linesAdded: 140 }, // +40 today
    ];
    const summary = summarizeLinesOfCode(history, now);
    assert.equal(summary.today.added, 40);
    assert.equal(summary.week.added, 140); // 100 (first sample) + 40
  });

  await t.test('excludes deltas older than the 7-day week window', () => {
    const now = Date.now();
    const longAgo = now - WEEK_MS - DAY_MS;

    const history = [
      { ts: longAgo, sessionId: 's1', linesAdded: 500 },
      { ts: now, sessionId: 's1', linesAdded: 510 }, // +10, within the window
    ];
    const summary = summarizeLinesOfCode(history, now);
    assert.equal(summary.week.added, 10);
  });

  await t.test('splits a long-running session\'s deltas across the today/week boundary correctly', () => {
    const now = Date.now();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);

    const history = [
      { ts: midnight.getTime() - 2 * DAY_MS, sessionId: 's1', linesAdded: 0 },
      { ts: midnight.getTime() - 1000, sessionId: 's1', linesAdded: 50 }, // yesterday, +50
      { ts: midnight.getTime() + 1000, sessionId: 's1', linesAdded: 80 }, // today, +30
    ];
    const summary = summarizeLinesOfCode(history, now);
    assert.equal(summary.today.added, 30);
    assert.equal(summary.week.added, 80);
  });
});
