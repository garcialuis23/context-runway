'use strict';

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

// Renders the webview's HTML shell. All actual data arrives later via
// postMessage from the extension host (extension.js), so this markup is
// static and safe to generate once per panel.
function renderPanelHtml(nonce) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<title>Context Runway</title>
<style nonce="${nonce}">
  .viz-root {
    --surface-1: #fcfcfb;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --gridline: #e1e0d9;
    --baseline: #c3c2b7;
    --series-1: #2a78d6;
    --series-1-wash: rgba(42, 120, 214, 0.10);
    --good: #0ca30c;
    --warning: #fab219;
    --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    .viz-root {
      --surface-1: #1a1a19;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --gridline: #2c2c2a;
      --baseline: #383835;
      --series-1: #3987e5;
      --series-1-wash: rgba(57, 135, 229, 0.14);
      --good: #0ca30c;
      --warning: #fab219;
      --critical: #d03b3b;
    }
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--surface-1);
    color: var(--text-primary);
  }
  h1 { font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 16px; }
  .empty { color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
  .empty code { background: var(--gridline); padding: 2px 5px; border-radius: 4px; }

  .card { margin-bottom: 20px; }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
  .card-title { font-size: 13px; color: var(--text-secondary); }
  .card-value { font-size: 22px; font-weight: 600; }
  .card-sub { font-size: 12px; color: var(--text-muted); }

  .status-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 1px 6px; border-radius: 10px; font-weight: 600; }
  .status-good { color: var(--good); }
  .status-warning { color: var(--warning); }
  .status-critical { color: var(--critical); }

  svg { display: block; overflow: visible; }
  .gridline { stroke: var(--gridline); stroke-width: 1; }
  .baseline { stroke: var(--baseline); stroke-width: 1; }
  .line { fill: none; stroke: var(--series-1); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .area { fill: var(--series-1-wash); stroke: none; }
  .end-dot { stroke: var(--surface-1); stroke-width: 2; }
  .axis-label { fill: var(--text-muted); font-size: 10px; }
  .end-label { fill: var(--text-primary); font-size: 11px; font-weight: 600; }

  .crosshair { stroke: var(--baseline); stroke-width: 1; pointer-events: none; }
  .tooltip {
    position: absolute; pointer-events: none; background: var(--surface-1);
    border: 1px solid var(--gridline); border-radius: 6px; padding: 6px 8px;
    font-size: 11px; line-height: 1.4; box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    white-space: nowrap; visibility: hidden; z-index: 10;
  }
  .tooltip .value { font-weight: 600; color: var(--text-primary); }
  .tooltip .label { color: var(--text-secondary); }

  details { margin-top: 8px; }
  summary { cursor: pointer; font-size: 12px; color: var(--text-secondary); }
  table { border-collapse: collapse; font-size: 11px; margin-top: 8px; width: 100%; }
  th, td { text-align: left; padding: 3px 8px 3px 0; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
  th { color: var(--text-muted); font-weight: 500; border-bottom: 1px solid var(--gridline); }
</style>
</head>
<body class="viz-root">
  <h1>Context Runway</h1>
  <div id="app"></div>
  <div class="tooltip" id="tooltip"></div>

<script nonce="${nonce}">
(function () {
  const app = document.getElementById('app');
  const tooltip = document.getElementById('tooltip');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CHART_W = 460;
  const CHART_H = 110;
  const PAD = { top: 10, right: 12, bottom: 18, left: 30 };

  function statusForPct(pct) {
    if (pct >= 90) return { cls: 'status-critical', color: 'var(--critical)', icon: '\\u25CF', word: 'critical' };
    if (pct >= 70) return { cls: 'status-warning', color: 'var(--warning)', icon: '\\u25CF', word: 'warning' };
    return { cls: 'status-good', color: 'var(--good)', icon: '\\u25CF', word: 'good' };
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function formatDuration(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '--';
    const totalMin = Math.round(ms / 60000);
    const d = Math.floor(totalMin / (60 * 24));
    const h = Math.floor((totalMin % (60 * 24)) / 60);
    const m = totalMin % 60;
    if (d > 0) return d + 'd' + h + 'h';
    if (h > 0) return h + 'h' + m + 'm';
    return m + 'm';
  }

  // Same fallback order as statusline/src/index.js: a /rename'd session_name
  // is the clearest label; otherwise fall back to directory + a short id
  // fragment, since two chats in the same project both show the same dir.
  function sessionLabel(entry) {
    if (entry.sessionName) return entry.sessionName;
    const shortId = entry.sessionId ? entry.sessionId.slice(0, 6) : '??????';
    return entry.dir ? entry.dir + ' · #' + shortId : '#' + shortId;
  }

  function el(tag, attrs, ns) {
    const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const k in attrs || {}) node.setAttribute(k, attrs[k]);
    return node;
  }

  // Renders one small-multiple line chart for a single series of {ts, pct}.
  function renderChart(container, points, opts) {
    const card = el('div', { class: 'card' });
    const head = el('div', { class: 'card-head' });
    const titleWrap = el('div');
    const title = el('div', { class: 'card-title' });
    title.textContent = opts.title;
    titleWrap.appendChild(title);

    const valueRow = el('div');
    const latest = points.length ? points[points.length - 1] : null;
    const valueEl = el('span', { class: 'card-value' });
    valueEl.textContent = latest ? Math.round(latest.pct) + '%' : '--';
    valueRow.appendChild(valueEl);

    if (latest) {
      const st = statusForPct(latest.pct);
      const badge = el('span', { class: 'status-badge ' + st.cls });
      badge.textContent = st.icon + ' ' + st.word;
      badge.style.marginLeft = '8px';
      valueRow.appendChild(badge);
    }
    titleWrap.appendChild(valueRow);
    head.appendChild(titleWrap);

    if (opts.subtitle) {
      const sub = el('div', { class: 'card-sub' });
      sub.textContent = opts.subtitle;
      head.appendChild(sub);
    }
    card.appendChild(head);

    if (points.length < 2) {
      const empty = el('div', { class: 'card-sub' });
      empty.textContent = 'Not enough samples yet \\u2014 keep using Claude Code and this will fill in.';
      card.appendChild(empty);
      container.appendChild(card);
      return;
    }

    const svg = el('svg', { viewBox: '0 0 ' + CHART_W + ' ' + CHART_H, width: '100%', height: CHART_H }, SVG_NS);

    const minTs = points[0].ts;
    const maxTs = points[points.length - 1].ts;
    const xScale = (ts) => {
      if (maxTs === minTs) return PAD.left;
      return PAD.left + ((ts - minTs) / (maxTs - minTs)) * (CHART_W - PAD.left - PAD.right);
    };
    const yScale = (pct) => {
      const clamped = Math.max(0, Math.min(100, pct));
      return CHART_H - PAD.bottom - (clamped / 100) * (CHART_H - PAD.top - PAD.bottom);
    };

    [0, 50, 100].forEach((tick) => {
      const y = yScale(tick);
      svg.appendChild(el('line', { class: 'gridline', x1: PAD.left, x2: CHART_W - PAD.right, y1: y, y2: y }, SVG_NS));
      const label = el('text', { class: 'axis-label', x: 2, y: y + 3 }, SVG_NS);
      label.textContent = tick + '%';
      svg.appendChild(label);
    });

    const linePoints = points.map((p) => xScale(p.ts) + ',' + yScale(p.pct)).join(' ');
    const areaPoints = xScale(minTs) + ',' + yScale(0) + ' ' + linePoints + ' ' + xScale(maxTs) + ',' + yScale(0);
    svg.appendChild(el('polygon', { class: 'area', points: areaPoints }, SVG_NS));
    svg.appendChild(el('polyline', { class: 'line', points: linePoints }, SVG_NS));

    const lastX = xScale(maxTs);
    const lastY = yScale(latest.pct);
    const st = statusForPct(latest.pct);
    svg.appendChild(el('circle', { class: 'end-dot', cx: lastX, cy: lastY, r: 5, fill: st.color }, SVG_NS));
    const endLabel = el('text', {
      class: 'end-label',
      x: Math.min(lastX + 6, CHART_W - 24),
      y: Math.max(lastY - 8, 12),
    }, SVG_NS);
    endLabel.textContent = Math.round(latest.pct) + '%';
    svg.appendChild(endLabel);

    const crosshair = el('line', { class: 'crosshair', x1: 0, x2: 0, y1: PAD.top, y2: CHART_H - PAD.bottom }, SVG_NS);
    crosshair.style.visibility = 'hidden';
    svg.appendChild(crosshair);

    const hitArea = el('rect', {
      x: PAD.left, y: 0, width: CHART_W - PAD.left - PAD.right, height: CHART_H,
      fill: 'transparent',
    }, SVG_NS);

    hitArea.addEventListener('pointermove', (evt) => {
      const rect = svg.getBoundingClientRect();
      const relX = ((evt.clientX - rect.left) / rect.width) * CHART_W;
      let nearest = points[0];
      let nearestDist = Infinity;
      for (const p of points) {
        const dist = Math.abs(xScale(p.ts) - relX);
        if (dist < nearestDist) { nearestDist = dist; nearest = p; }
      }
      const nx = xScale(nearest.ts);
      crosshair.setAttribute('x1', nx);
      crosshair.setAttribute('x2', nx);
      crosshair.style.visibility = 'visible';

      const valueSpan = tooltip.querySelector('.value') || (() => {
        const v = document.createElement('div'); v.className = 'value'; tooltip.appendChild(v); return v;
      })();
      const labelSpan = tooltip.querySelector('.label') || (() => {
        const l = document.createElement('div'); l.className = 'label'; tooltip.appendChild(l); return l;
      })();
      valueSpan.textContent = Math.round(nearest.pct) + '%';
      labelSpan.textContent = formatTime(nearest.ts);
      tooltip.style.visibility = 'visible';
      tooltip.style.left = (evt.clientX + 12) + 'px';
      tooltip.style.top = (evt.clientY + 12) + 'px';
    });
    hitArea.addEventListener('pointerleave', () => {
      crosshair.style.visibility = 'hidden';
      tooltip.style.visibility = 'hidden';
    });
    svg.appendChild(hitArea);

    const timeAxis = el('text', { class: 'axis-label', x: PAD.left, y: CHART_H - 4 }, SVG_NS);
    timeAxis.textContent = formatTime(minTs);
    svg.appendChild(timeAxis);
    const timeAxisEnd = el('text', { class: 'axis-label', x: CHART_W - PAD.right - 30, y: CHART_H - 4 }, SVG_NS);
    timeAxisEnd.textContent = formatTime(maxTs);
    svg.appendChild(timeAxisEnd);

    card.appendChild(svg);
    container.appendChild(card);
  }

  function renderTable(container, history) {
    const details = el('details');
    const summary = el('summary');
    summary.textContent = 'Show raw samples (' + history.length + ')';
    details.appendChild(summary);

    const table = el('table');
    const thead = el('thead');
    const headRow = el('tr');
    ['Time', 'Session', 'Context %', '5h %', '7d %'].forEach((h) => {
      const th = el('th'); th.textContent = h; headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    history.slice(-50).reverse().forEach((entry) => {
      const row = el('tr');
      const cells = [
        formatTime(entry.ts),
        sessionLabel(entry),
        entry.contextUsedPct != null ? Math.round(entry.contextUsedPct) + '%' : '--',
        entry.fiveHourPct != null ? Math.round(entry.fiveHourPct) + '%' : '--',
        entry.sevenDayPct != null ? Math.round(entry.sevenDayPct) + '%' : '--',
      ];
      cells.forEach((val) => {
        const td = el('td'); td.textContent = val; row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    details.appendChild(table);
    container.appendChild(details);
  }

  // Scans backward for the most recent entry that actually has the field set.
  // With multiple concurrent sessions, history[history.length - 1] can be a
  // brand-new session that hasn't gotten rate_limits yet, which would
  // otherwise blank out perfectly good, more recent data from another one.
  function mostRecentWithField(hist, field) {
    for (let i = hist.length - 1; i >= 0; i--) {
      if (typeof hist[i][field] === 'number') return hist[i];
    }
    return null;
  }

  function render(history, workspaceDir) {
    app.textContent = '';

    if (!history || history.length === 0) {
      const empty = el('div', { class: 'empty' });
      const p1 = document.createElement('p');
      p1.textContent = 'No usage data yet.';
      const p2 = document.createElement('p');
      p2.appendChild(document.createTextNode('Install the context-runway statusline first, then keep using Claude Code \\u2014 samples will start showing up here:'));
      const code = document.createElement('code');
      code.textContent = 'cd statusline && npm run install-statusline';
      const p3 = document.createElement('p');
      p3.appendChild(code);
      empty.appendChild(p1); empty.appendChild(p2); empty.appendChild(p3);
      app.appendChild(empty);
      return;
    }

    // Group context samples by session so we can pick one to feature instead
    // of showing every session at once (confusing — you want to know how
    // *this* chat is doing, not scroll through every chat you've ever had).
    const bySession = new Map();
    for (const e of history) {
      if (typeof e.contextUsedPct !== 'number') continue;
      const existing = bySession.get(e.sessionId);
      if (!existing || e.ts > existing.lastTs) {
        bySession.set(e.sessionId, {
          sessionId: e.sessionId,
          lastTs: e.ts,
          dir: e.dir || existing?.dir,
          sessionName: e.sessionName || existing?.sessionName,
        });
      } else {
        if (!existing.dir && e.dir) existing.dir = e.dir;
        if (!existing.sessionName && e.sessionName) existing.sessionName = e.sessionName;
      }
    }
    const allSessions = Array.from(bySession.values()).sort((a, b) => b.lastTs - a.lastTs);

    // "Current chat" = the most recently active session in *this* workspace
    // folder, so it tracks whichever chat you're actually typing in right
    // now and updates as you switch between chats in the same project.
    // Falls back to the single most recently active session anywhere if
    // none match (e.g. older entries recorded before dir was tracked).
    const currentSession =
      (workspaceDir && allSessions.find((s) => s.dir === workspaceDir)) || allSessions[0] || null;

    if (currentSession) {
      const series = history
        .filter((e) => e.sessionId === currentSession.sessionId && typeof e.contextUsedPct === 'number')
        .map((e) => ({ ts: e.ts, pct: e.contextUsedPct }));
      renderChart(app, series, { title: 'Context window — this chat', subtitle: sessionLabel(currentSession) });
    }

    const fiveHourEntry = mostRecentWithField(history, 'fiveHourPct');
    if (fiveHourEntry) {
      const fiveHourSeries = history
        .filter((e) => e.fiveHourResetsAt === fiveHourEntry.fiveHourResetsAt && typeof e.fiveHourPct === 'number')
        .map((e) => ({ ts: e.ts, pct: e.fiveHourPct }));
      const msToReset = fiveHourEntry.fiveHourResetsAt * 1000 - Date.now();
      renderChart(app, fiveHourSeries, { title: '5-hour rate limit', subtitle: 'resets in ' + formatDuration(msToReset) });
    }

    const sevenDayEntry = mostRecentWithField(history, 'sevenDayPct');
    if (sevenDayEntry) {
      const sevenDaySeries = history
        .filter((e) => e.sevenDayResetsAt === sevenDayEntry.sevenDayResetsAt && typeof e.sevenDayPct === 'number')
        .map((e) => ({ ts: e.ts, pct: e.sevenDayPct }));
      const msToReset = sevenDayEntry.sevenDayResetsAt * 1000 - Date.now();
      renderChart(app, sevenDaySeries, { title: '7-day rate limit', subtitle: 'resets in ' + formatDuration(msToReset) });
    }

    const otherSessions = allSessions.filter((s) => s !== currentSession).slice(0, 5);
    if (otherSessions.length > 0) {
      const otherWrap = el('details');
      const summary = el('summary');
      summary.textContent = 'Other sessions (' + otherSessions.length + ')';
      otherWrap.appendChild(summary);
      otherSessions.forEach((s) => {
        const series = history
          .filter((e) => e.sessionId === s.sessionId && typeof e.contextUsedPct === 'number')
          .map((e) => ({ ts: e.ts, pct: e.contextUsedPct }));
        renderChart(otherWrap, series, { title: 'Context window — ' + sessionLabel(s) });
      });
      app.appendChild(otherWrap);
    }

    renderTable(app, history);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'history') render(message.history, message.workspaceDir);
  });
})();
</script>
</body>
</html>`;
}

module.exports = { renderPanelHtml, getNonce };
