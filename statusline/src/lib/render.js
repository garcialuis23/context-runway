'use strict';

const COLORS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

function colorForPct(pct) {
  if (pct >= 90) return COLORS.red;
  if (pct >= 70) return COLORS.yellow;
  return COLORS.green;
}

function bar(pct, width = 10, fillChar = '▓', emptyChar = '░') {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return fillChar.repeat(filled) + emptyChar.repeat(width - filled);
}

// Renders a millisecond duration as a compact "1d2h" / "3h14m" / "5m" string.
function formatDuration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '--';
  const totalMin = Math.round(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}

module.exports = { COLORS, colorForPct, bar, formatDuration };
