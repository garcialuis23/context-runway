#!/usr/bin/env node
'use strict';

const { appendSnapshot } = require('./lib/history');
const { projectWindow } = require('./lib/projection');
const { COLORS, colorForPct, bar, formatDuration } = require('./lib/render');

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

function renderRateLimitSegment(label, pct, resetsAt, history, pctKey, resetsAtKey, nowMs) {
  if (pct == null) return null;
  const proj = projectWindow(history, {
    pctKey,
    resetsAtKey,
    currentPct: pct,
    currentResetsAt: resetsAt,
    nowMs,
  });
  const color = colorForPct(pct);
  const warn = proj?.willExceedBeforeReset ? ' ⚠' : '';
  const resetStr = formatDuration(proj?.msToReset);
  return `${label} ${color}${bar(pct, 8)}${COLORS.reset} ${pct.toFixed(0)}% (resets ${resetStr})${warn}`;
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

  const sessionId = input.session_id || 'unknown';

  const history = appendSnapshot({
    ts: now,
    sessionId,
    contextUsedPct,
    contextTokens,
    contextWindowSize,
    fiveHourPct,
    fiveHourResetsAt,
    sevenDayPct,
    sevenDayResetsAt,
  });

  const lines = [];

  lines.push(`${COLORS.cyan}[${model}]${COLORS.reset} 📁 ${dir}`);

  if (contextUsedPct != null) {
    const color = colorForPct(contextUsedPct);
    const remainingTokens =
      contextWindowSize != null && contextTokens != null
        ? Math.max(0, contextWindowSize - contextTokens)
        : null;
    const avgDelta = averageTurnDelta(history, sessionId);
    const turnsLeft =
      avgDelta && remainingTokens != null ? Math.max(0, Math.floor(remainingTokens / avgDelta)) : null;

    let line = `${color}${bar(contextUsedPct)}${COLORS.reset} ${contextUsedPct.toFixed(0)}% ctx`;
    if (turnsLeft != null) line += ` ${COLORS.dim}(~${turnsLeft} turns left)${COLORS.reset}`;
    lines.push(line);
  }

  const rlParts = [
    renderRateLimitSegment('5h', fiveHourPct, fiveHourResetsAt, history, 'fiveHourPct', 'fiveHourResetsAt', now),
    renderRateLimitSegment('7d', sevenDayPct, sevenDayResetsAt, history, 'sevenDayPct', 'sevenDayResetsAt', now),
  ].filter(Boolean);

  if (rlParts.length > 0) lines.push(rlParts.join(`  ${COLORS.dim}|${COLORS.reset}  `));

  process.stdout.write(lines.join('\n') + '\n');
}

main();
