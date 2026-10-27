'use strict';

const COLORS = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

function colorForPct(pct) {
  if (pct >= 90) return COLORS.red;
  if (pct >= 70) return COLORS.yellow;
  return COLORS.green;
}

// ASCII bar rather than unicode shade blocks (▓/░): those blur into a single
// gray blob at the small font sizes some status line hosts use, while
// '#'/'-' stay legible everywhere. Only the filled run carries color, so the
// proportion still reads even if a host strips ANSI entirely.
function renderBar(pct, width = 10) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const color = colorForPct(clamped);
  return `[${color}${'#'.repeat(filled)}${COLORS.reset}${COLORS.dim}${'-'.repeat(empty)}${COLORS.reset}]`;
}

// Renders a token count as a compact "200K" / "1M" string, so two chats on
// different models (different context window sizes) are easy to compare.
function formatTokenCount(n) {
  if (n == null) return '?';
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
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

// One aligned "label [bar] pct%  extra" row, for a dashboard-style layout
// where ctx/5h/7d each get their own line with matching column widths.
function formatRow(label, pct, extra, warn) {
  const labelStr = label.padEnd(4);
  const pctStr = `${Math.round(pct)}%`.padStart(4);
  const warnStr = warn ? ' ⚠' : '';
  return `${COLORS.dim}${labelStr}${COLORS.reset}${renderBar(pct)} ${COLORS.bold}${pctStr}${COLORS.reset}  ${COLORS.dim}${extra || ''}${COLORS.reset}${warnStr}`;
}

// Renders a compact "+123/-45" line-change delta, colored green/red so
// added/removed read at a glance without needing to parse the sign.
function formatLineDelta(added, removed) {
  return `${COLORS.green}+${formatTokenCount(added)}${COLORS.reset}/${COLORS.red}-${formatTokenCount(removed)}${COLORS.reset}`;
}

// One "loc  today +N/-M  ·  week +N/-M" row, mirroring formatRow's
// dim-label style but without a percentage bar (lines changed isn't a
// bounded 0-100% quantity like context/rate-limit usage).
function formatLocRow(summary) {
  const labelStr = 'loc'.padEnd(4);
  const today = formatLineDelta(summary.today.added, summary.today.removed);
  const week = formatLineDelta(summary.week.added, summary.week.removed);
  return `${COLORS.dim}${labelStr}${COLORS.reset}today ${today}  ${COLORS.dim}·${COLORS.reset}  week ${week}`;
}

module.exports = {
  COLORS,
  colorForPct,
  renderBar,
  formatRow,
  formatTokenCount,
  formatDuration,
  formatLineDelta,
  formatLocRow,
};
