'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COLORS,
  colorForPct,
  renderBar,
  formatRow,
  formatTokenCount,
  formatDuration,
  formatLineDelta,
  formatLocRow,
} = require('../../src/lib/render');

test('colorForPct picks red/yellow/green at the 90/70 thresholds', () => {
  assert.equal(colorForPct(0), COLORS.green);
  assert.equal(colorForPct(69.9), COLORS.green);
  assert.equal(colorForPct(70), COLORS.yellow);
  assert.equal(colorForPct(89.9), COLORS.yellow);
  assert.equal(colorForPct(90), COLORS.red);
  assert.equal(colorForPct(100), COLORS.red);
});

test('renderBar fills proportionally and clamps out-of-range percentages', () => {
  // The color escape is emitted even with zero filled slots (it just has
  // nothing to color), so the empty run is still prefixed by it.
  assert.equal(renderBar(0), `[${COLORS.green}${COLORS.reset}${COLORS.dim}${'-'.repeat(10)}${COLORS.reset}]`);
  assert.equal(renderBar(100), `[${COLORS.red}${'#'.repeat(10)}${COLORS.reset}${COLORS.dim}${COLORS.reset}]`);
  // 55% of a width-10 bar rounds to 6 filled slots (Math.round(5.5) === 6);
  // color is by percentage (55 < 70), not fill count, so it's still green.
  assert.equal(renderBar(55), `[${COLORS.green}${'#'.repeat(6)}${COLORS.reset}${COLORS.dim}${'-'.repeat(4)}${COLORS.reset}]`);
  // Out-of-range inputs are clamped rather than producing negative repeat counts.
  assert.equal(renderBar(-10), renderBar(0));
  assert.equal(renderBar(150), renderBar(100));
});

test('renderBar respects a custom width', () => {
  const bar = renderBar(50, 4);
  assert.equal(bar, `[${COLORS.green}${'#'.repeat(2)}${COLORS.reset}${COLORS.dim}${'-'.repeat(2)}${COLORS.reset}]`);
});

test('formatTokenCount handles null, small, thousands, and millions', () => {
  assert.equal(formatTokenCount(null), '?');
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1K');
  assert.equal(formatTokenCount(1500), '2K');
  // Documents existing rounding behavior: just under 1M still renders as "K",
  // and rounds up to "1000K" rather than crossing into the "M" branch.
  assert.equal(formatTokenCount(999999), '1000K');
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(1_500_000), '1.5M');
  assert.equal(formatTokenCount(2_000_000), '2M');
});

test('formatDuration handles missing/invalid/negative input', () => {
  assert.equal(formatDuration(null), '--');
  assert.equal(formatDuration(undefined), '--');
  assert.equal(formatDuration(NaN), '--');
  assert.equal(formatDuration(Infinity), '--');
  assert.equal(formatDuration(-1), '--');
});

test('formatDuration renders minutes, hours, and days at their boundaries', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(29_999), '0m'); // rounds down under 30s
  assert.equal(formatDuration(30_000), '1m'); // rounds up at the 30s midpoint
  assert.equal(formatDuration(60 * 60 * 1000), '1h0m');
  assert.equal(formatDuration((3 * 60 + 14) * 60 * 1000), '3h14m');
  assert.equal(formatDuration(24 * 60 * 60 * 1000), '1d0h');
  assert.equal(formatDuration(25 * 60 * 60 * 1000), '1d1h');
});

test('formatRow pads the label/percentage and omits the warning by default', () => {
  const row = formatRow('ctx', 42, 'extra');
  assert.ok(row.includes('ctx '));
  assert.ok(row.includes(' 42%'));
  assert.ok(row.includes('extra'));
  assert.ok(!row.includes('⚠'));
});

test('formatRow rounds the percentage and appends a warning icon when warn is truthy', () => {
  const row = formatRow('5h', 42.6, '', true);
  assert.ok(row.includes(' 43%'));
  assert.ok(row.includes('⚠'));
});

test('formatRow tolerates a missing extra string', () => {
  const row = formatRow('7d', 10);
  assert.ok(!row.includes('undefined'));
});

test('formatLineDelta colors added green and removed red', () => {
  const delta = formatLineDelta(120, 15);
  assert.equal(delta, `${COLORS.green}+120${COLORS.reset}/${COLORS.red}-15${COLORS.reset}`);
});

test('formatLocRow includes both today and week totals', () => {
  const row = formatLocRow({ today: { added: 10, removed: 2 }, week: { added: 40, removed: 8 } });
  assert.ok(row.includes('loc '));
  assert.ok(row.includes('today'));
  assert.ok(row.includes('+10'));
  assert.ok(row.includes('-2'));
  assert.ok(row.includes('week'));
  assert.ok(row.includes('+40'));
  assert.ok(row.includes('-8'));
});
