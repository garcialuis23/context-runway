#!/usr/bin/env node
'use strict';

const { appendSnapshot } = require('./lib/history');
const { projectWindow } = require('./lib/projection');
const { COLORS, formatRow, formatTokenCount, formatDuration } = require('./lib/render');

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SESSION_LABEL_LEN = 40;

// A drop of at least this fraction of the context window counts as a
// compaction rather than normal noise (normal usage only grows).
const COMPACTION_DROP_FRACTION = 0.2;
// If usage was already this high right before the drop, it's almost
// certainly Claude Code's automatic compaction (triggered by running out
// of room) rather than a manual /compact or /clear.
const AUTO_COMPACTION_PRIOR_PCT = 85;
// How long to keep showing a compaction after it happened.
const COMPACTION_VISIBLE_MS = 15 * 60 * 1000;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function lastPathSegment(p) {
  return (p || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

// Estimates tokens-consumed-per-turn for the current session from recent
// history, so we can translate "tokens remaining" into "~N turns left".
function averageTurnDelta(history, sessionId) {
  const points = history
    .filter((e) => e.sessionId === sessionId && typeof e.contextTokens === 'number')
    .sort((a, b) => a.ts - b.ts);

  const deltas = [];
  for (let i = 1; i < points.length; i++) {
    const delta = points[i].contextTokens - points[i - 1].contextTokens;
    if (delta > 0) deltas.push(delta);
  }
  if (deltas.length === 0) return null;

  const recent = deltas.slice(-10);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// Finds the most recent large drop in context tokens for this session
// (normal usage only grows, so a big drop means a compaction happened),
// as long as it's still within COMPACTION_VISIBLE_MS.
function detectRecentCompaction(history, sessionId, contextWindowSize, nowMs) {
  if (contextWindowSize == null) return null;

  const points = history
    .filter((e) => e.sessionId === sessionId && typeof e.contextTokens === 'number')
    .sort((a, b) => a.ts - b.ts);

  let lastDrop = null;
  for (let i = 1; i < points.length; i++) {
    const drop = points[i - 1].contextTokens - points[i].contextTokens;
    if (drop >= contextWindowSize * COMPACTION_DROP_FRACTION) {
      lastDrop = { ts: points[i].ts, priorPct: points[i - 1].contextUsedPct };
    }
  }
  if (!lastDrop || nowMs - lastDrop.ts > COMPACTION_VISIBLE_MS) return null;

  return {
    ts: lastDrop.ts,
    auto: typeof lastDrop.priorPct === 'number' && lastDrop.priorPct >= AUTO_COMPACTION_PRIOR_PCT,
  };
}

function formatAgo(ms) {
  if (ms < 60 * 1000) return 'just now';
  return `${formatDuration(ms)} ago`;
}

function renderRateLimitRow(label, pct, resetsAt, history, pctKey, resetsAtKey, nowMs, windowDurationMs) {
  if (pct == null) return null;
  const proj = projectWindow(history, {
    pctKey,
    resetsAtKey,
    currentPct: pct,
    currentResetsAt: resetsAt,
    nowMs,
    windowDurationMs,
  });
  return formatRow(label, pct, `resets in ${formatDuration(proj?.msToReset)}`, proj?.willExceedBeforeReset);
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.stdout.write('context-runway: waiting for session data\n');
    return;
  }

  const now = Date.now();
  const model = input.model?.display_name || input.model?.id || 'Claude';
  const dir = lastPathSegment(input.workspace?.current_dir || input.cwd);

  const ctx = input.context_window || {};
  const contextUsedPct = typeof ctx.used_percentage === 'number' ? ctx.used_percentage : null;
  const contextWindowSize = ctx.context_window_size || null;
  const contextTokens =
    typeof ctx.total_input_tokens === 'number' && typeof ctx.total_output_tokens === 'number'
      ? ctx.total_input_tokens + ctx.total_output_tokens
      : null;

  const rl = input.rate_limits || {};
  const fiveHourPct = rl.five_hour?.used_percentage ?? null;
  const fiveHourResetsAt = rl.five_hour?.resets_at ?? null;
  const sevenDayPct = rl.seven_day?.used_percentage ?? null;
  const sevenDayResetsAt = rl.seven_day?.resets_at ?? null;

  const effortLevel = input.effort?.level || null;

  const sessionId = input.session_id || 'unknown';
  const sessionName = input.session_name || null;
  // Falls back to a short id fragment so concurrent sessions in the same
  // project (same `dir`) are still distinguishable before you /rename them.
  const sessionLabel = sessionName || `#${sessionId.slice(0, 6)}`;

  const history = appendSnapshot({
    ts: now,
    sessionId,
    sessionName,
    dir,
    model,
    effortLevel,
    contextUsedPct,
    contextTokens,
    contextWindowSize,
    fiveHourPct,
    fiveHourResetsAt,
    sevenDayPct,
    sevenDayResetsAt,
  });

  const lines = [];

  // Model + its context window size up front, so two chats on different
  // models (different context limits) are easy to tell apart at a glance.
  const modelMeta = [contextWindowSize != null ? formatTokenCount(contextWindowSize) : null, effortLevel]
    .filter(Boolean)
    .join(' · ');
  const modelLabel = modelMeta ? `${model} · ${modelMeta}` : model;

  // Only show the session label when there's actually another session
  // active recently — otherwise it's just noise in the common case of one
  // chat at a time.
  const OTHER_SESSION_WINDOW_MS = 30 * 60 * 1000;
  const hasOtherRecentSession = history.some(
    (e) => e.sessionId !== sessionId && now - e.ts < OTHER_SESSION_WINDOW_MS
  );
  const truncatedLabel =
    sessionLabel.length > MAX_SESSION_LABEL_LEN
      ? `${sessionLabel.slice(0, MAX_SESSION_LABEL_LEN - 1)}…`
      : sessionLabel;
  const header = hasOtherRecentSession
    ? `${COLORS.cyan}[${modelLabel}]${COLORS.reset} 📁 ${dir} ${COLORS.dim}· ${truncatedLabel}${COLORS.reset}`
    : `${COLORS.cyan}[${modelLabel}]${COLORS.reset} 📁 ${dir}`;
  lines.push(header);

  const rows = [];

  if (contextUsedPct != null) {
    const remainingTokens =
      contextWindowSize != null && contextTokens != null
        ? Math.max(0, contextWindowSize - contextTokens)
        : null;
    const avgDelta = averageTurnDelta(history, sessionId);
    const turnsLeft =
      avgDelta && remainingTokens != null ? Math.max(0, Math.floor(remainingTokens / avgDelta)) : null;

    rows.push(formatRow('ctx', contextUsedPct, turnsLeft != null ? `~${turnsLeft} turns left` : ''));
  }

  rows.push(
    renderRateLimitRow('5h', fiveHourPct, fiveHourResetsAt, history, 'fiveHourPct', 'fiveHourResetsAt', now, FIVE_HOUR_MS),
    renderRateLimitRow('7d', sevenDayPct, sevenDayResetsAt, history, 'sevenDayPct', 'sevenDayResetsAt', now, SEVEN_DAY_MS)
  );

  const compaction = detectRecentCompaction(history, sessionId, contextWindowSize, now);
  if (compaction) {
    const label = compaction.auto ? 'auto-compacted' : 'compacted';
    rows.push(`${COLORS.dim}🗜  ${label} ${formatAgo(now - compaction.ts)} (context was reset)${COLORS.reset}`);
  }

  const filledRows = rows.filter(Boolean);
  if (filledRows.length > 0) {
    lines.push('');
    lines.push(...filledRows);
  }

  process.stdout.write(lines.join('\n') + '\n');
}

main();
